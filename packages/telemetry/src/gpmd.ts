import type { ByteReader } from './reader.ts';
import { parseTracks, type Track } from './mp4.ts';

/**
 * HiSilicon "gpmd" telemetry, as written by the WolfBox Player 1.
 *
 * The third track of every clip has hdlr=`meta`, name "Hisilicon MetaData" and
 * a `gpmd` sample entry. Despite the fourcc this is NOT GoPro GPMF: it is a
 * flat little-endian C struct, one 1000-byte sample per second of video.
 *
 * The record is a decoded NMEA RMC sentence, and it keeps NMEA's units:
 * coordinates are `ddmm.mmmmm` (degrees and decimal *minutes*, not decimal
 * degrees) and speed over ground is in knots. The u64 that follows each value
 * is its scale factor, and the firmware really does apply it -- coordinates are
 * scaled by 100000, speed by 1000. A converted km/h speed is provided at
 * SPEED_KPH.
 *
 * Ground truth: the camera burns its own position and speed into the video. For
 * `front_norm/2026_08_04_133634_00.MP4` at 13:37:07 the overlay reads
 * "W71.4938 N42.2969 64.1MPH", and this table decodes that sample to
 * 42.29686, -71.49383, 103.605 km/h (64.4 mph). GPS-derived speed over the
 * surrounding samples is 103-105 km/h, agreeing to about 1%.
 *
 * The i64 fields at 0x28/0x38 also look like coordinates but are noise.
 */
const OFF = {
  MAGIC: 0x00,      // u64, always 0x65
  ACCEL: 0x08,      // 3 x i16, raw G-sensor counts (X, Y, Z)
  HOUR: 0x10,       // u32, local time
  MINUTE: 0x14,     // u32
  SECOND: 0x18,     // u32
  FIX: 0x20,        // u64, 1 = GPS fix valid
  SPEED_KNOTS: 0x48,// i64, / 1000 -> knots (NMEA speed over ground)
  HEADING: 0x58,    // i64, / 100  -> degrees true
  DAY: 0x68,        // u32
  MONTH: 0x6c,      // u32
  YEAR: 0x70,       // u64
  UTC_HOUR: 0xa0,   // u32
  UTC_MINUTE: 0xa4, // u32
  UTC_SECOND: 0xa8, // u32
  LATITUDE: 0xb0,   // i64, / 1e5 -> ddmm.mmmmm
  LONGITUDE: 0xc0,  // i64, / 1e5 -> ddmm.mmmmm
  SPEED_KPH: 0x1f8, // i64, / 1000 -> km/h
} as const;

/** Smallest sample we can decode without running off the end. */
const MIN_SAMPLE_SIZE = 0x200;
/** Scale applied to the raw ddmm.mmmmm coordinate fields. */
const COORD_SCALE = 1e5;

/**
 * Before the receiver gets a fix the camera writes 0xFFFFFFFF into the date
 * fields. Feeding that to Date.UTC yields NaN, which then propagates silently
 * into every downstream time comparison.
 */
const NO_DATE = 0xffffffff;

const DAY_MS = 86_400_000;
/** Real UTC offsets run from -12:00 to +14:00; anything outside is a rollover. */
const MAX_UTC_OFFSET_MS = 14 * 3_600_000;
const MIN_UTC_OFFSET_MS = -12 * 3_600_000;

/**
 * Converts NMEA `ddmm.mmmmm` to decimal degrees.
 *
 * 4229.686 is 42 degrees and 29.686 minutes, i.e. 42.29477 -- not 42.29686.
 * Reading these fields as decimal degrees puts a route tens of kilometres from
 * where it was driven while still looking superficially plausible.
 */
function nmeaToDegrees(raw: number): number {
  const value = Math.abs(raw) / COORD_SCALE;
  const degrees = Math.floor(value / 100);
  const minutes = value - degrees * 100;
  return Math.sign(raw) * (degrees + minutes / 60);
}

export interface TelemetryPoint {
  /** Sample index within the clip; also its offset in seconds from clip start. */
  index: number;
  /** Wall-clock time from the camera's local clock. */
  localTime: { year: number; month: number; day: number; hour: number; minute: number; second: number };
  /** UTC time-of-day from the GNSS receiver. */
  utcTime: { hour: number; minute: number; second: number };
  /**
   * Milliseconds since the epoch, from the local date + UTC time-of-day, or
   * NaN before the receiver had a fix. Anchor a clip with `clipStartMs` rather
   * than reading this off the first sample.
   */
  timestampMs: number;
  latitude: number;
  longitude: number;
  speedKph: number;
  /** Speed over ground as the receiver reported it, in knots. */
  speedKnots: number;
  headingDeg: number;
  accel: { x: number; y: number; z: number };
  hasFix: boolean;
}

/** Finds the telemetry track in an already-parsed track list. */
export function findTelemetryTrack(tracks: Track[]): Track | undefined {
  return tracks.find((t) => t.format === 'gpmd');
}

/**
 * Combines the camera's local date with the receiver's UTC time-of-day.
 *
 * The date fields are local, time-of-day is recorded in both zones, and the
 * camera never records its UTC offset -- so pairing the local date with the UTC
 * time is the only sound anchor. Near midnight the two are on different dates
 * (an evening drive in the US is already tomorrow in UTC), which would place
 * the clip 24 hours out. Real UTC offsets span -12:00 to +14:00, so an implied
 * offset outside that range means the UTC time belongs to the adjacent day.
 *
 * Returns NaN when the camera had no fix and so wrote no usable date.
 */
export function resolveTimestamp(
  local: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  utc: { hour: number; minute: number; second: number },
): number {
  const { year, month, day } = local;
  // No fix yet: the date is a sentinel, so no absolute instant exists.
  if (year === NO_DATE || month === NO_DATE || day === NO_DATE) return Number.NaN;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return Number.NaN;
  const localNaive = Date.UTC(year, month - 1, day, local.hour, local.minute, local.second);
  let timestampMs = Date.UTC(year, month - 1, day, utc.hour, utc.minute, utc.second);
  const offset = localNaive - timestampMs;
  if (offset > MAX_UTC_OFFSET_MS) timestampMs += DAY_MS;
  else if (offset < MIN_UTC_OFFSET_MS) timestampMs -= DAY_MS;
  return timestampMs;
}

function decodeSample(view: DataView, index: number): TelemetryPoint | null {
  if (view.byteLength < MIN_SAMPLE_SIZE) return null;

  const year = Number(view.getBigUint64(OFF.YEAR, true));
  const month = view.getUint32(OFF.MONTH, true);
  const day = view.getUint32(OFF.DAY, true);
  const hour = view.getUint32(OFF.HOUR, true);
  const minute = view.getUint32(OFF.MINUTE, true);
  const second = view.getUint32(OFF.SECOND, true);
  const utcHour = view.getUint32(OFF.UTC_HOUR, true);
  const utcMinute = view.getUint32(OFF.UTC_MINUTE, true);
  const utcSecond = view.getUint32(OFF.UTC_SECOND, true);

  const timestampMs = resolveTimestamp(
    { year, month, day, hour, minute, second },
    { hour: utcHour, minute: utcMinute, second: utcSecond },
  );

  return {
    index,
    localTime: { year, month, day, hour, minute, second },
    utcTime: { hour: utcHour, minute: utcMinute, second: utcSecond },
    timestampMs,
    latitude: nmeaToDegrees(Number(view.getBigInt64(OFF.LATITUDE, true))),
    longitude: nmeaToDegrees(Number(view.getBigInt64(OFF.LONGITUDE, true))),
    speedKph: Number(view.getBigInt64(OFF.SPEED_KPH, true)) / 1000,
    speedKnots: Number(view.getBigInt64(OFF.SPEED_KNOTS, true)) / 1000,
    headingDeg: Number(view.getBigInt64(OFF.HEADING, true)) / 100,
    accel: {
      x: view.getInt16(OFF.ACCEL, true),
      y: view.getInt16(OFF.ACCEL + 2, true),
      z: view.getInt16(OFF.ACCEL + 4, true),
    },
    hasFix: Number(view.getBigUint64(OFF.FIX, true)) === 1,
  };
}

/**
 * Reads every telemetry sample from a clip.
 *
 * Samples are interleaved through `mdat`, so this issues one read per second of
 * video scattered across the whole file -- ~700ms per clip on a USB SD reader.
 * Callers should treat it as expensive: index lazily and cache the result.
 *
 * Pass `stride` to sample sparsely. `stride: 60` reads a single point per clip,
 * which is enough to place a clip on a map without paying for the full track.
 */
export async function readTelemetry(
  reader: ByteReader,
  options: { track?: Track; stride?: number } = {},
): Promise<TelemetryPoint[]> {
  const { track, stride = 1 } = options;
  const gpmd = track ?? findTelemetryTrack(await parseTracks(reader));
  if (!gpmd) return [];

  const points: TelemetryPoint[] = [];
  for (const [i, sample] of gpmd.samples.entries()) {
    if (i % stride !== 0) continue;
    if (sample.size < MIN_SAMPLE_SIZE) continue;
    const bytes = await reader.read(sample.offset, sample.size);
    if (bytes.length < MIN_SAMPLE_SIZE) continue;
    const point = decodeSample(new DataView(bytes.buffer, bytes.byteOffset, bytes.length), i);
    if (point) points.push(point);
  }
  return points;
}

/** Telemetry is written once per second of video. */
export const SAMPLE_INTERVAL_MS = 1000;

/**
 * The absolute instant of video time zero for one clip.
 *
 * Samples run at 1 Hz from the start of the clip, so any sample with a usable
 * timestamp dates the whole file. This deliberately does not read sample zero:
 * a clip recorded before the receiver had a fix begins with a run of samples
 * whose date fields are the 0xFFFFFFFF sentinel, and anchoring playback to one
 * of those leaves every position and speed lookup missing.
 */
export function clipStartMs(points: TelemetryPoint[]): number | undefined {
  for (const point of points) {
    if (Number.isFinite(point.timestampMs)) {
      return point.timestampMs - point.index * SAMPLE_INTERVAL_MS;
    }
  }
  return undefined;
}
