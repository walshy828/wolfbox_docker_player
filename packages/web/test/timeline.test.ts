import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMoments, neighbourMoment, nearestIndex, speedPath, limitPath, STRETCH_LEAD_MS } from '../src/timeline.ts';
import { BRAKE_LEAD_MS } from '../src/safety.ts';
import type { CleanPoint, HarshEvent, OverLimitStretch } from '@wolfbox/telemetry';

const T = 1_000_000;
const event = (kind: HarshEvent['kind'], startMs: number): HarshEvent => ({
  startMs, endMs: startMs + 1000, durationSec: 1, kind, severity: 'moderate',
  peakDeltaKph: 0, peakG: 0.35, peakAtMs: startMs, speedKph: 50, distanceMeters: 10,
  direction: kind === 'cornering' ? 'left' : undefined,
});
const stretch = (startMs: number): OverLimitStretch => ({
  startMs, endMs: startMs + 30_000, durationSec: 30, limitKph: 48.28, limitSource: 'tagged',
  peakSpeedKph: 70, peakExcessKph: 21.7, distanceMeters: 500, severity: 'moderate', roadName: 'Main St',
});
const point = (i: number, kph: number, gapAfter = 0): CleanPoint => ({
  index: i, localTime: { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
  utcTime: { hour: 0, minute: 0, second: 0 }, timestampMs: T + i * 1000 + gapAfter,
  latitude: 42, longitude: -71, speedKph: kph, speedKnots: 0, headingDeg: 0,
  accel: { x: 0, y: 0, z: 0 }, hasFix: true, smoothedSpeedKph: kph,
});

describe('buildMoments', () => {
  const moments = buildMoments([event('braking', T + 60_000), event('cornering', T + 5_000)], [stretch(T + 30_000)], T);

  test('merges events and stretches in time order, with panel-compatible keys', () => {
    assert.deepEqual(moments.map((m) => m.key), [`cornering-${T + 5_000}`, `stretch-${T + 30_000}`, `braking-${T + 60_000}`]);
  });

  test('labels say what and how much', () => {
    assert.equal(moments[0]!.label, 'Sharp turn left, 0.35 g');
    assert.equal(moments[1]!.label, '13 over the 30 limit on Main St');
  });

  test('lands before the moment so it can be seen happening, never before the trip', () => {
    assert.equal(moments[1]!.seekMs, T + 30_000 - STRETCH_LEAD_MS);
    assert.equal(moments[2]!.seekMs, T + 60_000 - BRAKE_LEAD_MS);
    assert.equal(moments[0]!.seekMs, T + 1_000);
  });

  test('next and previous step through them from the playhead', () => {
    assert.equal(neighbourMoment(moments, T, 1)?.kind, 'cornering');
    assert.equal(neighbourMoment(moments, moments[1]!.seekMs + 500, 1)?.kind, 'braking');
    // Just after jumping to the stretch, previous goes to the one before it.
    assert.equal(neighbourMoment(moments, moments[1]!.seekMs + 500, -1)?.kind, 'cornering');
    assert.equal(neighbourMoment(moments, T + 100_000, 1), undefined);
  });
});

test('nearestIndex', () => {
  const points = [point(0, 0), point(1, 0), point(2, 0)];
  assert.equal(nearestIndex(points, T + 1400), 1);
  assert.equal(nearestIndex(points, T + 1600), 2);
  assert.equal(nearestIndex(points, T - 5000), 0);
  assert.equal(nearestIndex(points, T + 9000), 2);
});

describe('paths', () => {
  test('the speed trace breaks across a recording gap', () => {
    const points = [point(0, 30), point(1, 40), point(2, 40, 60_000), point(3, 30, 60_000)];
    const d = speedPath(points, T, 63_000, 50, 100, 10);
    assert.equal(d.match(/M/g)?.length, 2);
  });

  test('the limit line skips unknown stretches', () => {
    const points = [point(0, 30), point(1, 30), point(2, 30), point(3, 30)];
    const d = limitPath(points, [50, 50, undefined, 80], T, 3000, 100, 100, 10);
    assert.equal(d.match(/M/g)?.length, 2);
  });
});
