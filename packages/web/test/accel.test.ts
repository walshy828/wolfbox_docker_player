import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { accelAt } from '../src/accel.ts';
import { MODERATE_G, REST_BASELINE, type CleanPoint } from '@wolfbox/telemetry';

const T0 = Date.UTC(2026, 7, 4, 21, 33, 34);
const point = (i: number, over: Partial<CleanPoint> = {}): CleanPoint => ({
  index: i,
  localTime: { year: 2026, month: 8, day: 4, hour: 13, minute: 33, second: 34 + i },
  utcTime: { hour: 21, minute: 33, second: 34 + i },
  timestampMs: T0 + i * 1000,
  latitude: 42.3, longitude: -71.5,
  speedKph: 80, smoothedSpeedKph: 80, speedKnots: 43.2,
  headingDeg: 90, accel: { ...REST_BASELINE }, hasFix: true,
  ...over,
});

describe('accelAt', () => {
  const near = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} vs ${expected}`);

  test('zero longitudinal g at the first sample', () => {
    const at = accelAt([point(0)], T0)!;
    near(at.longitudinalG, 0, 'longitudinalG');
  });

  test('reflects a harsh-braking speed drop between samples', () => {
    const track = [point(0, { smoothedSpeedKph: 80 }), point(1, { smoothedSpeedKph: 80 - 12 })];
    const at = accelAt(track, T0 + 1000)!;
    near(at.longitudinalG, -MODERATE_G, 'longitudinalG');
  });

  test('reflects a harsh-acceleration speed gain between samples', () => {
    const track = [point(0, { smoothedSpeedKph: 80 }), point(1, { smoothedSpeedKph: 80 + 12 })];
    const at = accelAt(track, T0 + 1000)!;
    near(at.longitudinalG, MODERATE_G, 'longitudinalG');
  });

  test('interpolates the longitudinal reading between samples so it glides', () => {
    const track = [
      point(0, { smoothedSpeedKph: 80 }),
      point(1, { smoothedSpeedKph: 80 - 12 }),
      point(2, { smoothedSpeedKph: 80 - 12 }),
    ];
    const at = accelAt(track, T0 + 1500)!;
    near(at.longitudinalG, -MODERATE_G / 2, 'longitudinalG');
  });

  test('lateral g comes from the accelerometer Y axis', () => {
    const track = [point(0, { accel: { x: REST_BASELINE.x, y: REST_BASELINE.y + 50, z: REST_BASELINE.z } })];
    const at = accelAt(track, T0)!;
    assert.ok(at.lateralG > 0, `expected positive lateralG, got ${at.lateralG}`);
  });

  test('falls back to the nearest sample within tolerance', () => {
    const track = [point(0)];
    const at = accelAt(track, T0 + 4000)!;
    assert.equal(at.timestampMs, T0);
  });

  test('gives up beyond tolerance', () => {
    assert.equal(accelAt([point(0)], T0 + 10_000), undefined);
  });

  test('returns undefined for an empty track', () => {
    assert.equal(accelAt([], T0), undefined);
  });
});
