import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrack } from '../src/clean.ts';
import { longitudinalGAt, lateralGAt, REST_BASELINE, MODERATE_G, SEVERE_G } from '../src/accel.ts';
import { HARSH_DELTA_KPH, SEVERE_DELTA_KPH } from '../src/harshEvents.ts';
import type { TelemetryPoint } from '../src/gpmd.ts';

const T0 = Date.UTC(2026, 7, 1, 19, 23, 29);
/** A straight eastbound run, one sample per second, at the given speeds. */
const run = (speeds: number[]): TelemetryPoint[] =>
  speeds.map((speedKph, i) => ({
    index: i,
    localTime: { year: 2026, month: 8, day: 1, hour: 11, minute: 23, second: 29 + i },
    utcTime: { hour: 19, minute: 23, second: 29 + i },
    timestampMs: T0 + i * 1000,
    latitude: 42.1,
    longitude: -71.3 + i * 0.0001,
    speedKph,
    speedKnots: speedKph / 1.852,
    headingDeg: 90,
    accel: { ...REST_BASELINE },
    hasFix: true,
  }));

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} vs ${expected}`);

describe('longitudinalGAt', () => {
  test('zero at the first sample, since there is no previous speed to compare', () => {
    const points = cleanTrack(run([50, 50]));
    assert.equal(longitudinalGAt(points, 0), 0);
  });

  test('a harsh-braking speed drop reads as exactly -MODERATE_G', () => {
    const points = cleanTrack(run([50, 50 - HARSH_DELTA_KPH]));
    near(longitudinalGAt(points, 1), -MODERATE_G, 'longitudinalG');
  });

  test('a severe speed gain reads as exactly +SEVERE_G', () => {
    const points = cleanTrack(run([50, 50 + SEVERE_DELTA_KPH]));
    near(longitudinalGAt(points, 1), SEVERE_G, 'longitudinalG');
  });

  test('gentle slowing reads as a small negative value, not zero', () => {
    const points = cleanTrack(run([50, 47]));
    const g = longitudinalGAt(points, 1);
    assert.ok(g < 0 && g > -MODERATE_G, `expected a small negative value, got ${g}`);
  });
});

describe('lateralGAt', () => {
  test('zero at the rest baseline', () => {
    const points = cleanTrack(run([0, 0]));
    assert.equal(lateralGAt(points, 0), 0);
  });

  test('independent of the X and Z axes', () => {
    const points = cleanTrack(run([0]));
    points[0]!.accel = { x: REST_BASELINE.x + 999, y: REST_BASELINE.y, z: REST_BASELINE.z - 999 };
    assert.equal(lateralGAt(points, 0), 0);
  });
});
