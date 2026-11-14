import type { CleanPoint } from './clean.ts';
import { haversineMeters } from './geo.ts';
import type { HarshEvent, HarshSeverity } from './harshEvents.ts';

/**
 * Detects aggressive cornering from GPS speed and heading.
 *
 * A car following a curve at speed v while its heading turns at rate omega
 * pulls v * omega of lateral acceleration. Both come from the receiver at 1 Hz,
 * and both are validated elsewhere: speed against the camera's burnt-in overlay
 * and heading against the bearing between fixes. That makes this a far sounder
 * signal than the raw accelerometer, whose scale and axes are undocumented.
 * Checked over fifteen drives on the reference card, it correlates with the
 * accelerometer's Y axis (r = 0.52, slope 0.75) once the heading's per-sample
 * scale is honoured -- see `decodeHeading` in gpmd.ts, without which a single
 * misread heading reads as several g.
 *
 * Heading is differenced across the sample either side (a centred difference)
 * rather than from the previous one, which halves the noise of a single
 * jittery fix. Below `CORNER_MIN_KPH` a receiver's heading wanders on its own
 * -- creeping through a car park can swing it through tens of degrees -- and no
 * cornering force worth remarking on is possible anyway.
 */

/** Below this, heading is too noisy to difference, and lateral force is trivial. */
export const CORNER_MIN_KPH = 20;
/**
 * Lateral g worth remarking on. Ordinary driving on the reference card peaks
 * around 0.25 g (99.5th percentile 0.26 g over fifteen drives), and consumer
 * telematics flag harsh cornering in the 0.3-0.4 g range.
 */
export const CORNER_MODERATE_G = 0.3;
/** Markedly harder: tyre-squeal territory for an ordinary car on a dry road. */
export const CORNER_SEVERE_G = 0.4;
/** The centred difference spans two samples; a wider span is a fix gap, not a turn. */
const MAX_SPAN_SEC = 3;
/** Beyond this the tyres would have let go long before; it is a heading glitch, not a turn. */
const MAX_PLAUSIBLE_G = 1.2;
const G = 9.80665;

/**
 * Lateral g at `points[i]`, positive turning right (heading increasing).
 * Zero at either end of the track, across a fix gap, or below the minimum speed.
 */
export function gpsLateralGAt(points: readonly CleanPoint[], i: number): number {
  const before = points[i - 1];
  const point = points[i];
  const after = points[i + 1];
  if (!before || !point || !after) return 0;
  if (point.smoothedSpeedKph < CORNER_MIN_KPH) return 0;

  const seconds = (after.timestampMs - before.timestampMs) / 1000;
  if (seconds <= 0 || seconds > MAX_SPAN_SEC) return 0;

  const turnDeg = ((after.headingDeg - before.headingDeg) % 360 + 540) % 360 - 180;
  const yawRadPerSec = (turnDeg * Math.PI) / 180 / seconds;
  const g = ((point.smoothedSpeedKph / 3.6) * yawRadPerSec) / G;
  return Math.abs(g) > MAX_PLAUSIBLE_G ? 0 : g;
}

/** Detects discrete aggressive-cornering events in a cleaned track. */
export function detectCornering(points: readonly CleanPoint[]): HarshEvent[] {
  const events: HarshEvent[] = [];
  let run: { index: number; g: number }[] = [];
  let gap = 0;

  const flush = () => {
    if (run.length > 0) events.push(build(points, run));
    run = [];
    gap = 0;
  };

  for (let i = 1; i < points.length - 1; i++) {
    const g = gpsLateralGAt(points, i);
    const triggered = Math.abs(g) >= CORNER_MODERATE_G;

    if (!triggered) {
      if (run.length > 0 && ++gap > 1) flush();
      continue;
    }
    // A left immediately followed by a right is a chicane: two events.
    if (run.length > 0 && Math.sign(run[0]!.g) !== Math.sign(g)) flush();
    run.push({ index: i, g });
    gap = 0;
  }
  flush();
  return events;
}

function build(points: readonly CleanPoint[], run: { index: number; g: number }[]): HarshEvent {
  let peak = run[0]!;
  for (const sample of run) if (Math.abs(sample.g) > Math.abs(peak.g)) peak = sample;

  const first = run[0]!.index;
  const last = run.at(-1)!.index;
  let distanceMeters = 0;
  for (let i = first + 1; i <= last; i++) distanceMeters += haversineMeters(points[i - 1]!, points[i]!);

  const startMs = points[first]!.timestampMs;
  const endMs = points[last]!.timestampMs;
  const severity: HarshSeverity = Math.abs(peak.g) >= CORNER_SEVERE_G ? 'severe' : 'moderate';
  return {
    startMs,
    endMs,
    durationSec: (endMs - startMs) / 1000,
    kind: 'cornering',
    severity,
    peakDeltaKph: 0,
    peakG: peak.g,
    direction: peak.g > 0 ? 'right' : 'left',
    peakAtMs: points[peak.index]!.timestampMs,
    speedKph: points[peak.index]!.smoothedSpeedKph,
    distanceMeters,
  };
}
