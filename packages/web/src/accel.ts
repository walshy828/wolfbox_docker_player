import { longitudinalGAt, lateralGAt, type CleanPoint } from '@wolfbox/telemetry';

export interface AccelState {
  longitudinalG: number;
  lateralG: number;
  timestampMs: number;
}

/** Beyond this gap between samples there is nothing sensible to interpolate. Mirrors vehicle.ts. */
const MAX_INTERPOLATION_MS = 3_000;
/** How far past the last sample the reading is still shown. Mirrors vehicle.ts. */
const TOLERANCE_MS = 5_000;

/**
 * Where the vehicle's g-force is at an arbitrary instant, interpolated the
 * same way `vehicleAt` interpolates position/speed.
 *
 * Telemetry is only 1 Hz; lerping between the two samples that bracket the
 * cursor keeps the meter moving smoothly in step with the video rather than
 * stepping once a second, consistent with how the speed readout is already
 * interpolated -- acceleration is physically continuous, so this doesn't
 * fabricate anything a stepped reading wouldn't already be approximating.
 *
 * Returns undefined when the cursor is outside the track.
 */
export function accelAt(points: CleanPoint[], timestampMs: number | null): AccelState | undefined {
  if (timestampMs === null || !Number.isFinite(timestampMs) || points.length === 0) return undefined;

  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid]!.timestampMs < timestampMs) low = mid + 1;
    else high = mid;
  }

  const afterIdx = low;
  const after = points[afterIdx];
  const beforeIdx = afterIdx - 1;
  const before = beforeIdx >= 0 ? points[beforeIdx] : undefined;

  const bracketed = before && after
    && timestampMs >= before.timestampMs && timestampMs <= after.timestampMs;

  if (bracketed) {
    const span = after.timestampMs - before.timestampMs;
    if (span > 0 && span <= MAX_INTERPOLATION_MS) {
      const t = (timestampMs - before.timestampMs) / span;
      const fromLong = longitudinalGAt(points, beforeIdx);
      const toLong = longitudinalGAt(points, afterIdx);
      const fromLat = lateralGAt(points, beforeIdx);
      const toLat = lateralGAt(points, afterIdx);
      return {
        longitudinalG: fromLong + (toLong - fromLong) * t,
        lateralG: fromLat + (toLat - fromLat) * t,
        timestampMs,
      };
    }
  }

  const candidates = [
    before ? { point: before, index: beforeIdx } : undefined,
    after ? { point: after, index: afterIdx } : undefined,
  ].filter((c): c is { point: CleanPoint; index: number } => !!c);

  let best: { point: CleanPoint; index: number } | undefined;
  let bestDelta = Infinity;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate.point.timestampMs - timestampMs);
    if (delta < bestDelta) { bestDelta = delta; best = candidate; }
  }
  if (!best || bestDelta > TOLERANCE_MS) return undefined;

  return {
    longitudinalG: longitudinalGAt(points, best.index),
    lateralG: lateralGAt(points, best.index),
    timestampMs: best.point.timestampMs,
  };
}
