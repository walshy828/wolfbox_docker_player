import {
  blobReader, readTelemetry, cleanTrack, summarize,
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
      starts.front = front[0]?.timestampMs;
      points.push(...front);
    }
    if (pair.rear) {
      const rear = await safeTelemetry(pair.rear.handle, pair.front ? 60 : 1);
      starts.rear = rear[0]?.timestampMs;
      if (!pair.front) points.push(...rear);
    }

    clipStarts[i] = starts;
    onProgress?.(i + 1, trip.clips.length);
  }

  points.sort((a, b) => a.timestampMs - b.timestampMs);
  const cleaned = cleanTrack(points);
  return { points: cleaned, summary: summarize(cleaned), clipStarts };
}

/** A truncated clip should not sink the trip it belongs to. */
async function safeTelemetry(handle: FileSystemFileHandle, stride = 1): Promise<TelemetryPoint[]> {
  try {
    return await clipTelemetry(handle, stride);
  } catch {
    return [];
  }
}

/** Nearest track point to a playback instant, for the map cursor and readout. */
export function pointAt(points: CleanPoint[], timestampMs: number): CleanPoint | undefined {
  if (points.length === 0) return undefined;

  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid]!.timestampMs < timestampMs) low = mid + 1;
    else high = mid;
  }
  const after = points[low]!;
  const before = points[low - 1];
  if (!before) return after;
  return timestampMs - before.timestampMs <= after.timestampMs - timestampMs ? before : after;
}
