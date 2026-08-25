import { kphToMph, type CleanPoint } from '@wolfbox/telemetry';

export interface VehicleState {
  latitude: number;
  longitude: number;
  /** Degrees true, interpolated the short way round. */
  headingDeg: number;
  speedMph: number;
  /**
   * The instant this state describes: the cursor itself while interpolating,
   * or the sample's own time when falling back to the nearest one. The readout
   * quotes it, so it must be the time the shown values actually belong to.
   */
  timestampMs: number;
}

/** Beyond this gap between samples there is nothing sensible to interpolate. */
const MAX_INTERPOLATION_MS = 3_000;
/** How far past the last sample the marker is still shown. */
const TOLERANCE_MS = 5_000;

const usable = (p: CleanPoint) =>
  Number.isFinite(p.latitude) && Number.isFinite(p.longitude) &&
  Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;

/** Interpolates an angle the short way, so 350 -> 10 passes through zero. */
export function lerpAngle(from: number, to: number, t: number): number {
  const delta = ((to - from) % 360 + 540) % 360 - 180;
  return (from + delta * t + 360) % 360;
}

/**
 * Where the vehicle is at an arbitrary instant.
 *
 * Telemetry is only 1 Hz, so snapping the marker to the nearest sample makes it
 * jump a car length at a time down the road. Interpolating between the two
 * samples that bracket the cursor makes it glide along the route in step with
 * the picture, which is the whole point of showing it.
 *
 * Returns undefined when the cursor is outside the track, so the marker is
 * hidden rather than parked at a stale position.
 */
export function vehicleAt(points: CleanPoint[], timestampMs: number | null): VehicleState | undefined {
  if (timestampMs === null || !Number.isFinite(timestampMs) || points.length === 0) return undefined;

  // Points are sorted by time; binary search for the first at or after the cursor.
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid]!.timestampMs < timestampMs) low = mid + 1;
    else high = mid;
  }

  const after = points[low];
  const before = points[low - 1] ?? (after && after.timestampMs <= timestampMs ? after : undefined);

  // Only interpolate when the cursor genuinely lies between the two samples.
  // Clamping instead would silently pin the marker to the last known point for
  // as long as playback ran past the end of the track.
  const bracketed = before && after
    && timestampMs >= before.timestampMs && timestampMs <= after.timestampMs;

  if (bracketed && before !== after && usable(before) && usable(after)) {
    const span = after.timestampMs - before.timestampMs;
    if (span > 0 && span <= MAX_INTERPOLATION_MS) {
      const t = (timestampMs - before.timestampMs) / span;
      return {
        latitude: before.latitude + (after.latitude - before.latitude) * t,
        longitude: before.longitude + (after.longitude - before.longitude) * t,
        headingDeg: lerpAngle(before.headingDeg, after.headingDeg, t),
        speedMph: kphToMph(before.smoothedSpeedKph + (after.smoothedSpeedKph - before.smoothedSpeedKph) * t),
        timestampMs,
      };
    }
  }

  // No usable pair: fall back to whichever single sample is closest in time.
  const candidates = [before, after].filter((p): p is CleanPoint => !!p && usable(p));
  let best: CleanPoint | undefined;
  let bestDelta = Infinity;
  for (const point of candidates) {
    const delta = Math.abs(point.timestampMs - timestampMs);
    if (delta < bestDelta) { bestDelta = delta; best = point; }
  }
  if (!best || bestDelta > TOLERANCE_MS) return undefined;

  return {
    latitude: best.latitude,
    longitude: best.longitude,
    headingDeg: best.headingDeg,
    speedMph: kphToMph(best.smoothedSpeedKph),
    timestampMs: best.timestampMs,
  };
}
