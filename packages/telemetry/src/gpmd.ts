import type { ByteReader } from './reader.ts';
import { parseTracks, type Track } from './mp4.ts';

/**
 * HiSilicon "gpmd" telemetry, as written by the WolfBox Player 1.
 *
 * The third track of every clip has hdlr=`meta`, name "Hisilicon MetaData" and
 * a `gpmd` sample entry. Despite the fourcc this is NOT GoPro GPMF: it is a
 * flat little-endian C struct, one 1000-byte sample per second of video.
 *
 * Field offsets below were recovered by decoding all 728 clips of a reference
 * card (41,881 points) and cross-checking three ways:
 *   - `HEADING` matches the bearing computed from consecutive fixes to <0.5deg
 *   - straight-line distance over 20s (368m) is consistent with the
 *     speed-integrated path (335m); reading the coordinates as NMEA
 *     ddmm.mmmmm instead gives 683m, which is geometrically impossible
 *   - decoded positions reverse-geocode to real roads (Millis, Massachusetts)
 *
 * Each coordinate is followed by a u64 literal 100000 that looks like a scale
 * factor. It is not applied by the firmware -- coordinates are plain 1e-7
 * degrees. Ignore it.
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
  SPEED: 0x48,      // i64, / 1000 -> km/h
  HEADING: 0x58,    // i64, / 100  -> degrees true
  DAY: 0x68,        // u32
  MONTH: 0x6c,      // u32
  YEAR: 0x70,       // u64
  UTC_HOUR: 0xa0,   // u32
  UTC_MINUTE: 0xa4, // u32
  UTC_SECOND: 0xa8, // u32
  LATITUDE: 0xb0,   // i64, / 1e7 -> decimal degrees
  LONGITUDE: 0xc0,  // i64, / 1e7 -> decimal degrees
} as const;

/** Smallest sample we can decode without running off the end. */
const MIN_SAMPLE_SIZE = 0xd0;
const COORD_SCALE = 1e7;

export interface TelemetryPoint {
  /** Sample index within the clip; also its offset in seconds from clip start. */
  index: number;
  /** Wall-clock time from the camera's local clock. */
  localTime: { year: number; month: number; day: number; hour: number; minute: number; second: number };
  /** UTC time-of-day from the GNSS receiver. */
  utcTime: { hour: number; minute: number; second: number };
  /** Milliseconds since the epoch, from the local date + UTC time-of-day. */
  timestampMs: number;
  latitude: number;
  longitude: number;
  speedKph: number;
  headingDeg: number;
  accel: { x: number; y: number; z: number };
  hasFix: boolean;
}

/** Finds the telemetry track in an already-parsed track list. */
export function findTelemetryTrack(tracks: Track[]): Track | undefined {
  return tracks.find((t) => t.format === 'gpmd');
}

function decodeSample(view: DataView, index: number): TelemetryPoint | null {
  if (view.byteLength < MIN_SAMPLE_SIZE) return null;

  const year = Number(view.getBigUint64(OFF.YEAR, true));
  const month = view.getUint32(OFF.MONTH, true);
  const day = view.getUint32(OFF.DAY, true);
  const utcHour = view.getUint32(OFF.UTC_HOUR, true);
  const utcMinute = view.getUint32(OFF.UTC_MINUTE, true);
  const utcSecond = view.getUint32(OFF.UTC_SECOND, true);

  // The date fields are local but time-of-day is recorded in both zones. Pair
  // the local date with the UTC time-of-day to get an absolute instant -- the
  // camera never records its UTC offset, so this is the only sound anchor.
  // Around midnight the two disagree by a day; callers correct with `fixDateRollover`.
  const timestampMs = Date.UTC(year, month - 1, day, utcHour, utcMinute, utcSecond);

  return {
    index,
    localTime: {
      year, month, day,
      hour: view.getUint32(OFF.HOUR, true),
      minute: view.getUint32(OFF.MINUTE, true),
      second: view.getUint32(OFF.SECOND, true),
    },
    utcTime: { hour: utcHour, minute: utcMinute, second: utcSecond },
    timestampMs,
    latitude: Number(view.getBigInt64(OFF.LATITUDE, true)) / COORD_SCALE,
    longitude: Number(view.getBigInt64(OFF.LONGITUDE, true)) / COORD_SCALE,
    speedKph: Number(view.getBigInt64(OFF.SPEED, true)) / 1000,
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
