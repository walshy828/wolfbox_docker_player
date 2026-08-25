/**
 * Card layout and trip segmentation.
 *
 * Everything here works from directory listings alone -- no file reads -- so a
 * card with 1,500 clips produces a browsable trip list in milliseconds. GPS is
 * layered on afterwards, lazily. See `readTelemetry` for why that split matters.
 */

export type Camera = 'front' | 'rear';
/** `normal` is the rolling loop; `event` is a locked/impact clip. */
export type ClipKind = 'normal' | 'event' | 'photo';

/** One file on the card, identified from its name and folder alone. */
export interface ClipRef<T = unknown> {
  name: string;
  camera: Camera;
  kind: ClipKind;
  /**
   * Camera-local start time as milliseconds. The camera records no UTC offset
   * in the filename, so this is a naive local instant: correct for ordering and
   * grouping, but only `TelemetryPoint.timestampMs` is a true absolute time.
   */
  startLocalMs: number;
  /** Whatever the caller needs to open the file later (a `File`, a path, ...). */
  handle: T;
}

const FOLDERS: Record<string, { camera: Camera; kind: ClipKind }> = {
  front_norm: { camera: 'front', kind: 'normal' },
  rear_norm: { camera: 'rear', kind: 'normal' },
  front_emer: { camera: 'front', kind: 'event' },
  rear_emer: { camera: 'rear', kind: 'event' },
  front_photo: { camera: 'front', kind: 'photo' },
  rear_photo: { camera: 'rear', kind: 'photo' },
};

export const CLIP_FOLDERS = Object.keys(FOLDERS);

/**
 * The folder a clip lives in, from what a `ClipRef` records.
 *
 * A `ClipRef` keeps camera and kind rather than the folder it was found in,
 * which is enough to display it but not to reach the file again -- removing one
 * needs its parent directory. This is the inverse of `FOLDERS`.
 */
export function clipFolder(camera: Camera, kind: ClipKind): string {
  const folder = CLIP_FOLDERS.find(
    (name) => FOLDERS[name]!.camera === camera && FOLDERS[name]!.kind === kind,
  );
  if (!folder) throw new Error(`no folder holds ${camera} ${kind} clips`);
  return folder;
}

/** `2026_08_01_112328_00.MP4` (front) / `2026_08_01_112328_01_b.MP4` (rear). */
const NAME_RE = /^(\d{4})_(\d{2})_(\d{2})_(\d{2})(\d{2})(\d{2})_(\d{2})(_b)?\.MP4$/i;

export function parseClipName(folder: string, name: string): Omit<ClipRef, 'handle'> | null {
  const location = FOLDERS[folder];
  if (!location) return null;
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m;
  return {
    name,
    camera: location.camera,
    kind: location.kind,
    startLocalMs: Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second!),
  };
}

export interface ClipPair<T = unknown> {
  startLocalMs: number;
  kind: ClipKind;
  front?: ClipRef<T>;
  rear?: ClipRef<T>;
}

export interface Trip<T = unknown> {
  id: string;
  startLocalMs: number;
  /** Start of the last clip plus its duration. */
  endLocalMs: number;
  clips: ClipPair<T>[];
  /** True if any clip in the trip came from an `*_emer` folder. */
  hasEvent: boolean;
}

/** Clips are one minute long; the cadence on real cards is 56-62s. */
export const CLIP_DURATION_MS = 60_000;
/** A gap longer than this starts a new trip. Two clip lengths. */
export const TRIP_GAP_MS = 120_000;
/**
 * Front and rear run on independent clocks -- on the reference card the rear
 * camera started a full minute before the front -- so pairing must tolerate
 * drift rather than demand identical filenames.
 */
export const PAIR_TOLERANCE_MS = 45_000;

/**
 * Matches front clips to rear clips by start time.
 *
 * Exact filename matching pairs only 714 of 728 clips on the reference card,
 * because the two cameras start independently. This walks both lists in order
 * and pairs greedily within `PAIR_TOLERANCE_MS`, leaving unmatched clips as
 * single-camera entries rather than dropping them.
 */
export function pairClips<T>(clips: ClipRef<T>[], toleranceMs = PAIR_TOLERANCE_MS): ClipPair<T>[] {
  const byTime = (a: ClipRef<T>, b: ClipRef<T>) => a.startLocalMs - b.startLocalMs;
  const front = clips.filter((c) => c.camera === 'front').sort(byTime);
  const rear = clips.filter((c) => c.camera === 'rear').sort(byTime);

  const pairs: ClipPair<T>[] = [];
  let f = 0;
  let r = 0;
  while (f < front.length || r < rear.length) {
    const nextFront = front[f];
    const nextRear = rear[r];

    if (nextFront && nextRear) {
      const delta = nextFront.startLocalMs - nextRear.startLocalMs;
      if (Math.abs(delta) <= toleranceMs) {
        pairs.push({
          startLocalMs: Math.min(nextFront.startLocalMs, nextRear.startLocalMs),
          kind: nextFront.kind,
          front: nextFront,
          rear: nextRear,
        });
        f++; r++;
        continue;
      }
      // Emit whichever is earlier on its own and try again.
      if (delta < 0) { pairs.push(single(nextFront)); f++; }
      else { pairs.push(single(nextRear)); r++; }
      continue;
    }
    if (nextFront) { pairs.push(single(nextFront)); f++; }
    else if (nextRear) { pairs.push(single(nextRear)); r++; }
  }
  return pairs;

  function single(clip: ClipRef<T>): ClipPair<T> {
    return {
      startLocalMs: clip.startLocalMs,
      kind: clip.kind,
      [clip.camera]: clip,
    } as ClipPair<T>;
  }
}

/**
 * Splits paired clips into trips wherever recording stopped for longer than
 * `gapMs`. On the reference card this yields 54 trips across 23 days, matching
 * the observed cadence (598 of 727 gaps are exactly 60s).
 */
export function groupTrips<T>(pairs: ClipPair<T>[], gapMs = TRIP_GAP_MS): Trip<T>[] {
  const sorted = [...pairs].sort((a, b) => a.startLocalMs - b.startLocalMs);
  const trips: Trip<T>[] = [];
  let current: ClipPair<T>[] = [];

  const close = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current.at(-1)!;
    trips.push({
      id: new Date(first.startLocalMs).toISOString().replace(/[:.]/g, '-').slice(0, 19),
      startLocalMs: first.startLocalMs,
      endLocalMs: last.startLocalMs + CLIP_DURATION_MS,
      clips: current,
      hasEvent: current.some((c) => c.kind === 'event'),
    });
    current = [];
  };

  for (const pair of sorted) {
    const previous = current.at(-1);
    if (previous && pair.startLocalMs - previous.startLocalMs > gapMs) close();
    current.push(pair);
  }
  close();
  return trips;
}

/** Convenience: filenames in, trips out. */
export function buildTrips<T>(clips: ClipRef<T>[], gapMs = TRIP_GAP_MS): Trip<T>[] {
  return groupTrips(pairClips(clips), gapMs);
}
