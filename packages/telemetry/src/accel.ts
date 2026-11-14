import type { CleanPoint } from './clean.ts';
import { gpsLateralGAt, CORNER_MIN_KPH } from './cornering.ts';
import { HARSH_DELTA_KPH, SEVERE_DELTA_KPH, MAX_RELIABLE_GAP_SEC, MAX_PLAUSIBLE_DELTA_KPH } from './harshEvents.ts';

/**
 * G-forces for a live meter: braking/acceleration and lateral/cornering.
 *
 * Longitudinal comes from the GPS speed delta between consecutive samples --
 * the same signal `detectHarshEvents` already uses -- not from the camera's
 * raw accelerometer. That was the first thing tried, calibrated by treating a
 * stationary vehicle's ~248-count raw magnitude as 1g. Checked against real
 * GPS-confirmed harsh events on the reference card, the raw X axis tracks
 * braking consistently (nose-dive under braking adds to the signal), but its
 * response to acceleration events of equal or larger GPS-confirmed magnitude
 * is weak and inconsistent -- sometimes even the wrong sign. A meter that
 * deflects confidently for braking and barely (or wrongly) for acceleration
 * would be actively misleading, so longitudinal force uses the validated
 * GPS-speed signal for both directions instead, which also makes its
 * moderate/severe thresholds land exactly on `HARSH_DELTA_KPH`/
 * `SEVERE_DELTA_KPH`.
 *
 * Lateral comes from GPS too: speed times the rate heading changes (see
 * cornering.ts). Only below the speed where heading is trustworthy does it
 * fall back to the raw accelerometer's Y axis, which was never independently
 * calibrated and is an estimate.
 */

/** Raw accelerometer magnitude at rest, empirically measured on the reference card. 1g is this many counts. */
export const COUNTS_PER_G = 248;

/**
 * At-rest raw baseline per axis, subtracted before scaling. The camera is
 * mounted at a pitch, so gravity splits between X and Z at rest rather than
 * loading a single axis.
 */
export const REST_BASELINE = { x: -180, y: 5, z: 165 } as const;

/** kph/s per g (3.6 * 9.80665). */
const KPH_PER_S_PER_G = 35.30394;

export interface AccelG {
  /** Positive = accelerating, negative = braking. From the GPS speed delta, same signal as `detectHarshEvents`. */
  longitudinalG: number;
  /** Positive = right, negative = left. From GPS speed x heading rate; see `lateralGAt`. */
  lateralG: number;
}

/**
 * Longitudinal g at `points[i]`, from the speed change since `points[i-1]`.
 * Zero at the first sample (no previous point) or across an unreliable gap
 * (dropped/reacquired GPS fix), matching `detectHarshEvents`'s own guard.
 */
export function longitudinalGAt(points: CleanPoint[], i: number): number {
  const point = points[i];
  const previous = points[i - 1];
  if (!point || !previous) return 0;
  const seconds = (point.timestampMs - previous.timestampMs) / 1000;
  if (seconds <= 0 || seconds > MAX_RELIABLE_GAP_SEC) return 0;
  const deltaKph = (point.smoothedSpeedKph - previous.smoothedSpeedKph) / seconds;
  if (Math.abs(deltaKph) > MAX_PLAUSIBLE_DELTA_KPH) return 0;
  return deltaKph / KPH_PER_S_PER_G;
}

/**
 * Lateral g at `points[i]`, positive turning right.
 *
 * From GPS speed and heading (see `gpsLateralGAt`), the same signal cornering
 * events are detected from, so the meter and the event list agree. Below the
 * speed where heading is trustworthy it falls back to the raw accelerometer's
 * Y axis, which tracks the GPS figure (r = 0.52, slope 0.75) but was never
 * independently calibrated.
 */
export function lateralGAt(points: CleanPoint[], i: number): number {
  const point = points[i];
  if (!point) return 0;
  if (point.smoothedSpeedKph >= CORNER_MIN_KPH && points[i - 1] && points[i + 1]) {
    return gpsLateralGAt(points, i);
  }
  return (point.accel.y - REST_BASELINE.y) / COUNTS_PER_G;
}

/** g-equivalent of `HARSH_DELTA_KPH`, exact since longitudinal g now uses the same speed-delta signal. */
export const MODERATE_G = HARSH_DELTA_KPH / KPH_PER_S_PER_G;
/** g-equivalent of `SEVERE_DELTA_KPH`. */
export const SEVERE_G = SEVERE_DELTA_KPH / KPH_PER_S_PER_G;
