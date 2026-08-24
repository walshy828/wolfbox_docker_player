import {
  blobReader, readTelemetry, cleanTrack, summarize, clipStartMs,
  type CleanPoint, type TelemetryPoint, type TripSummary,
} from '@wolfbox/telemetry';
import { cacheKey, readCached, writeCached } from './cache.ts';
import type { CardTrip } from './card.ts';

export interface TripTrack {
  points: CleanPoint[];
  summary: TripSummary | null;
  /**
   * Absolute start instant of each camera's file, per clip pair, aligned with
   * `trip.clips`. Both cameras stamp their own telemetry, which is the only
   * sound way to line them up: the two run on independent clocks, so filenames
   * for the same moment can differ by a minute.
   */
  clipStarts: { front?: number; rear?: number }[];
}

/** Reads one clip's telemetry, using the cache when possible. */
async function clipTelemetry(handle: FileSystemFileHandle, stride = 1): Promise<TelemetryPoint[]> {
  const file = await handle.getFile();
  const key = `${cacheKey(file)}:${stride}`;

  const cached = await readCached(key);
  if (cached) return cached;

  const points = await readTelemetry(blobReader(file), { stride });
  await writeCached(key, points);
  return points;
}

/**
 * Loads a whole trip's 1 Hz track.
 *
 * Rear clips carry the same telemetry as front clips, so the rear file is only
 * sampled for its start time when a front clip already supplied the track.
 * `onProgress` fires per clip so the caller can show real progress rather than
 * making the user wait out the whole trip.
 */
export async function loadTripTrack(
  trip: CardTrip,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<TripTrack> {
  const { signal, onProgress } = options;
  const points: TelemetryPoint[] = [];
  const clipStarts: TripTrack['clipStarts'] = [];

  for (const [i, pair] of trip.clips.entries()) {
    if (signal?.aborted) break;
    const starts: { front?: number; rear?: number } = {};

    // The route only needs one camera's copy of the track, but each camera's
    // own first timestamp is what lets the two videos be aligned.
    if (pair.front) {
      const front = await safeTelemetry(pair.front.handle);
      starts.front = clipStartMs(front);
      points.push(...front);
    }
    if (pair.rear) {
      // The rear file duplicates the track, so it is only sampled for its own
      // clock. Stride 60 would miss the anchor when the opening samples have no
      // fix, so read enough of the head to find one.
      const rear = await safeTelemetry(pair.rear.handle, pair.front ? 5 : 1);
      starts.rear = clipStartMs(rear);
      if (!pair.front) points.push(...rear);
    }

    clipStarts[i] = starts;
    onProgress?.(i + 1, trip.clips.length);
  }

  fillMissingStarts(clipStarts, trip);

  points.sort((a, b) => a.timestampMs - b.timestampMs);
  const cleaned = cleanTrack(points);
  return { points: cleaned, summary: summarize(cleaned), clipStarts };
}

/**
 * Dates clips whose telemetry never got a fix at all.
 *
 * Such a clip has no absolute time of its own, but the filename carries the
 * camera's local clock. Any clip in the trip that *did* get a fix gives the
 * offset between that local clock and real time, which dates the rest. Without
 * this a fixless clip anchors playback at nothing and the map stops tracking
 * for its whole minute.
 */
function fillMissingStarts(clipStarts: TripTrack['clipStarts'], trip: CardTrip): void {
  let offsetMs: number | undefined;
  for (const [i, starts] of clipStarts.entries()) {
    const known = starts.front ?? starts.rear;
    const pair = trip.clips[i];
    if (known !== undefined && pair) {
      offsetMs = known - pair.startLocalMs;
      break;
    }
  }
  if (offsetMs === undefined) return;

  for (const [i, pair] of trip.clips.entries()) {
    const starts = clipStarts[i] ?? (clipStarts[i] = {});
    const estimated = pair.startLocalMs + offsetMs;
    starts.front ??= pair.front ? estimated : undefined;
    starts.rear ??= pair.rear ? estimated : undefined;
  }
}

/** A truncated clip should not sink the trip it belongs to. */
async function safeTelemetry(handle: FileSystemFileHandle, stride = 1): Promise<TelemetryPoint[]> {
  try {
    return await clipTelemetry(handle, stride);
  } catch {
    return [];
  }
}
