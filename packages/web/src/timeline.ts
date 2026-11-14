import type { CleanPoint, HarshEvent, OverLimitStretch } from '@wolfbox/telemetry';
import { kphToMph } from '@wolfbox/telemetry';
import { seekTargetMs } from './safety.ts';

/** Seconds of lead-in before a speeding stretch, so the build-up is on screen. */
export const STRETCH_LEAD_MS = 3_000;
/** A gap longer than this in the track breaks the speed trace rather than bridging it. */
const BREAK_MS = 5_000;

/** One flagged moment on the timeline: a harsh event or a speeding stretch. */
export interface Moment {
  /** Matches the keys the Safety and Adherence panels use, so a highlight is shared. */
  key: string;
  kind: HarshEvent['kind'] | 'speeding';
  severity: 'minor' | 'moderate' | 'severe';
  label: string;
  startMs: number;
  endMs: number;
  /** Where the player should land to see it happen. */
  seekMs: number;
}

const EVENT_LABEL: Record<HarshEvent['kind'], string> = {
  braking: 'Hard stop',
  acceleration: 'Hard launch',
  cornering: 'Sharp turn',
};

/** Every flagged moment of a drive, in time order. */
export function buildMoments(
  events: readonly HarshEvent[],
  stretches: readonly OverLimitStretch[],
  tripStartMs: number,
): Moment[] {
  const moments: Moment[] = [
    ...events.map((event): Moment => ({
      key: `${event.kind}-${event.startMs}`,
      kind: event.kind,
      severity: event.severity,
      label: `${EVENT_LABEL[event.kind]}${event.direction ? ` ${event.direction}` : ''}, ${Math.abs(event.peakG).toFixed(2)} g`,
      startMs: event.startMs,
      endMs: event.endMs,
      seekMs: seekTargetMs(event, tripStartMs),
    })),
    ...stretches.map((stretch): Moment => ({
      key: `stretch-${stretch.startMs}`,
      kind: 'speeding',
      severity: stretch.severity,
      label: `${Math.round(kphToMph(stretch.peakExcessKph))} over the ${Math.round(kphToMph(stretch.limitKph))} limit`
        + (stretch.roadName ? ` on ${stretch.roadName}` : ''),
      startMs: stretch.startMs,
      endMs: stretch.endMs,
      seekMs: Math.max(tripStartMs, stretch.startMs - STRETCH_LEAD_MS),
    })),
  ];
  return moments.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The next moment after the playhead, or the previous one before it.
 *
 * "Previous" skips anything within a few seconds behind the playhead: having
 * just jumped to a moment, the playhead sits a little after its seek point,
 * and stepping back should reach the one before, not replay the same one.
 */
export function neighbourMoment(moments: readonly Moment[], cursorMs: number, direction: 1 | -1): Moment | undefined {
  if (direction === 1) return moments.find((moment) => moment.seekMs > cursorMs + 500);
  for (let i = moments.length - 1; i >= 0; i--) {
    if (moments[i]!.seekMs < cursorMs - 4_000) return moments[i];
  }
  return undefined;
}

/** Index of the point nearest an instant. Points must be in time order. */
export function nearestIndex(points: readonly { timestampMs: number }[], timestampMs: number): number {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid]!.timestampMs < timestampMs) low = mid + 1;
    else high = mid;
  }
  const before = points[low - 1];
  if (before && Math.abs(before.timestampMs - timestampMs) <= Math.abs(points[low]!.timestampMs - timestampMs)) {
    return low - 1;
  }
  return low;
}

const xOf = (ms: number, startMs: number, span: number, width: number) => ((ms - startMs) / span) * width;
const yOf = (kph: number, topKph: number, height: number) => height - (kph / topKph) * height;

/** A filled area under the speed trace, broken wherever the track has a gap. */
export function speedPath(
  points: readonly CleanPoint[], startMs: number, span: number, topKph: number, width: number, height: number,
): string {
  let d = '';
  let runStart: number | undefined;
  let lastX = 0;
  for (const [i, point] of points.entries()) {
    const x = xOf(point.timestampMs, startMs, span, width);
    const y = yOf(point.smoothedSpeedKph, topKph, height);
    const gap = i > 0 && point.timestampMs - points[i - 1]!.timestampMs > BREAK_MS;
    if (runStart === undefined || gap) {
      if (runStart !== undefined) d += `L${lastX.toFixed(1)},${height}Z`;
      d += `M${x.toFixed(1)},${height}L${x.toFixed(1)},${y.toFixed(1)}`;
      runStart = x;
    } else {
      d += `L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    lastX = x;
  }
  if (runStart !== undefined) d += `L${lastX.toFixed(1)},${height}Z`;
  return d;
}

/** The limit as a stepped line, absent wherever the limit is unknown or unlimited. */
export function limitPath(
  points: readonly CleanPoint[], limitKph: readonly (number | undefined)[],
  startMs: number, span: number, topKph: number, width: number, height: number,
): string {
  let d = '';
  let drawing = false;
  let lastY = 0;
  for (const [i, point] of points.entries()) {
    const limit = limitKph[i];
    const gap = i > 0 && point.timestampMs - points[i - 1]!.timestampMs > BREAK_MS;
    if (limit === undefined || !Number.isFinite(limit) || gap) {
      drawing = false;
      if (limit === undefined || !Number.isFinite(limit)) continue;
    }
    const x = xOf(point.timestampMs, startMs, span, width).toFixed(1);
    const y = yOf(limit, topKph, height);
    if (!drawing) {
      d += `M${x},${y.toFixed(1)}`;
      drawing = true;
    } else if (y !== lastY) {
      d += `L${x},${lastY.toFixed(1)}L${x},${y.toFixed(1)}`;
    } else {
      d += `L${x},${y.toFixed(1)}`;
    }
    lastY = y;
  }
  return d;
}
