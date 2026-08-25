import type { CleanPoint } from './clean.ts';
import { haversineMeters } from './geo.ts';

/**
 * Detects hard braking and hard acceleration from GPS speed alone.
 *
 * The camera also records raw accelerometer counts (`TelemetryPoint.accel`),
 * which would in principle be a more direct signal. But its scale factor and
 * axis orientation are undocumented and nothing in this codebase calibrates
 * it, unlike the GPS speed field, which is validated against the camera's own
 * burned-in overlay (see gpmd.ts). Speed-derived deltas are the safer signal
 * until the accelerometer gets the same treatment.
 *
 * A stop is not one instant, it is a few seconds long, so this does not use
 * the sustained-over-tens-of-seconds arm/release windowing that `adherence.ts`
 * uses for speeding. Instead consecutive triggering samples of the same kind
 * are simply merged into one event, tolerating a single dropped sample so
 * ordinary 1 Hz jitter mid-stop does not split one hard stop into two.
 *
 * A speed change is only evidence of a harsh event if it happened in about a
 * second. Losing and reacquiring a GPS fix drops every sample in between --
 * under a bridge, in a tunnel, in a parking garage -- and the receiver often
 * reports a real but already-established speed the moment it comes back
 * (this is exactly how a car already doing 30 mph when the fix returns gets
 * misread as a hard launch from a stop). So a gap of more than a sample or
 * two is never treated as a real one-second change, no matter its magnitude.
 */

/** A speed change beyond this between consecutive 1 Hz samples is remarkable. ~0.34g. */
export const HARSH_DELTA_KPH = 12;
/** A markedly harder event, worth flagging distinctly from a firm stop. ~0.5g. */
export const SEVERE_DELTA_KPH = 18;
/**
 * At most this many consecutive non-triggering samples inside a run are
 * absorbed rather than treated as the run ending. Two dropped samples in a
 * row is treated as the event having genuinely ended.
 */
export const MERGE_GAP_SAMPLES = 1;

/**
 * Beyond this gap between consecutive samples, the speed either side is real
 * but the elapsed time is not -- a dropped or reacquired GPS fix, or a
 * recording gap -- so no delta is computed across it at all.
 */
export const MAX_RELIABLE_GAP_SEC = 2;

export type HarshKind = 'braking' | 'acceleration';
export type HarshSeverity = 'moderate' | 'severe';

export interface HarshEvent {
  startMs: number;
  endMs: number;
  durationSec: number;
  kind: HarshKind;
  severity: HarshSeverity;
  /** Largest-magnitude speed change seen during the event, signed (negative for braking). */
  peakDeltaKph: number;
  peakAtMs: number;
  distanceMeters: number;
}

interface Sample {
  point: CleanPoint;
  deltaKph: number;
}

/** Detects discrete hard-braking and hard-acceleration events in a cleaned track. */
export function detectHarshEvents(points: CleanPoint[]): HarshEvent[] {
  const events: HarshEvent[] = [];
  let run: Sample[] = [];
  let gap = 0;

  const flush = () => {
    if (run.length === 0) return;
    events.push(build(run));
    run = [];
    gap = 0;
  };

  for (const [i, point] of points.entries()) {
    const previous = points[i - 1];
    if (!previous) continue;

    const seconds = (point.timestampMs - previous.timestampMs) / 1000;
    if (seconds <= 0) continue;
    if (seconds > MAX_RELIABLE_GAP_SEC) { flush(); continue; }

    const deltaKph = (point.smoothedSpeedKph - previous.smoothedSpeedKph) / seconds;
    const triggered = Math.abs(deltaKph) >= HARSH_DELTA_KPH;
    const kind: HarshKind = deltaKph < 0 ? 'braking' : 'acceleration';
    const sample: Sample = { point, deltaKph };

    if (!triggered) {
      if (run.length > 0) {
        gap++;
        if (gap > MERGE_GAP_SAMPLES) flush();
      }
      continue;
    }

    const openKind: HarshKind | undefined = run.length > 0
      ? (run[0]!.deltaKph < 0 ? 'braking' : 'acceleration')
      : undefined;

    if (openKind && openKind !== kind) flush();

    run.push(sample);
    gap = 0;
  }

  flush();
  return events;
}

function build(run: Sample[]): HarshEvent {
  let peak = run[0]!;
  for (const sample of run) {
    if (Math.abs(sample.deltaKph) > Math.abs(peak.deltaKph)) peak = sample;
  }

  let distanceMeters = 0;
  for (let i = 1; i < run.length; i++) {
    distanceMeters += haversineMeters(run[i - 1]!.point, run[i]!.point);
  }

  const startMs = run[0]!.point.timestampMs;
  const endMs = run.at(-1)!.point.timestampMs;

  return {
    startMs,
    endMs,
    durationSec: (endMs - startMs) / 1000,
    kind: peak.deltaKph < 0 ? 'braking' : 'acceleration',
    severity: Math.abs(peak.deltaKph) >= SEVERE_DELTA_KPH ? 'severe' : 'moderate',
    peakDeltaKph: peak.deltaKph,
    peakAtMs: peak.point.timestampMs,
    distanceMeters,
  };
}
