import type { CleanPoint } from './clean.ts';
import { HARSH_DELTA_KPH, SEVERE_DELTA_KPH, MAX_RELIABLE_GAP_SEC } from './harshEvents.ts';

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
 * Lateral has no GPS-derived equivalent (GPS gives no independent cornering
 * signal at low speed), so it still comes from the raw accelerometer's Y
 * axis, using the same rest-magnitude calibration. Unlike X, Y was never
 * independently validated against a ground truth -- there is no equivalent
 * of harsh-braking events to check it against -- so it is presented as an
 * estimate, not a validated measurement.
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
  /** Positive = right, negative = left. From the raw accelerometer's Y axis -- an estimate, not independently validated. */
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
  return deltaKph / KPH_PER_S_PER_G;
}

/** Lateral g estimate at `points[i]`, from the raw accelerometer's Y axis. Not independently validated -- see the file doc comment. */
export function lateralGAt(points: CleanPoint[], i: number): number {
  const point = points[i];
  if (!point) return 0;
  return (point.accel.y - REST_BASELINE.y) / COUNTS_PER_G;
}

/** g-equivalent of `HARSH_DELTA_KPH`, exact since longitudinal g now uses the same speed-delta signal. */
export const MODERATE_G = HARSH_DELTA_KPH / KPH_PER_S_PER_G;
/** g-equivalent of `SEVERE_DELTA_KPH`. */
export const SEVERE_G = SEVERE_DELTA_KPH / KPH_PER_S_PER_G;
