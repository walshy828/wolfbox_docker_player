import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { vehicleAt, lerpAngle } from '../src/vehicle.ts';
import type { CleanPoint } from '@wolfbox/telemetry';

const T0 = Date.UTC(2026, 7, 4, 21, 33, 34);
const point = (i: number, over: Partial<CleanPoint> = {}): CleanPoint => ({
  index: i,
  localTime: { year: 2026, month: 8, day: 4, hour: 13, minute: 33, second: 34 + i },
  utcTime: { hour: 21, minute: 33, second: 34 + i },
  timestampMs: T0 + i * 1000,
  latitude: 42.3 + i * 0.001,
  longitude: -71.5 + i * 0.001,
  speedKph: 80, smoothedSpeedKph: 80, speedKnots: 43.2,
  headingDeg: 90, accel: { x: 0, y: 0, z: 0 }, hasFix: true,
  ...over,
});

const track = [point(0), point(1), point(2), point(3)];

describe('lerpAngle', () => {
  test('takes the short way across zero', () => {
    assert.equal(lerpAngle(350, 10, 0.5), 0);
    assert.equal(lerpAngle(10, 350, 0.5), 0);
  });
  test('interpolates within a turn', () => {
    assert.equal(lerpAngle(90, 180, 0.5), 135);
  });
});

describe('vehicleAt', () => {
  const near = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} vs ${expected}`);

  test('lands on a sample', () => {
    const at = vehicleAt(track, T0 + 1000)!;
    near(at.latitude, 42.3 + 0.001, 'latitude');
  });

  // Telemetry is 1 Hz; without this the marker jumps once a second.
  test('interpolates between samples so the marker glides', () => {
    const at = vehicleAt(track, T0 + 1500)!;
    assert.ok(at.latitude > 42.301 && at.latitude < 42.302,
      `expected a position between samples, got ${at.latitude}`);
    near(at.latitude, 42.3 + 0.0015, 'latitude');
    near(at.longitude, -71.5 + 0.0015, 'longitude');
  });

  test('interpolates heading through a turn', () => {
    const turning = [point(0, { headingDeg: 350 }), point(1, { headingDeg: 10 })];
    assert.equal(vehicleAt(turning, T0 + 500)!.headingDeg, 0);
  });

  test('interpolates speed', () => {
    const accelerating = [
      point(0, { smoothedSpeedKph: 0 }),
      point(1, { smoothedSpeedKph: 160.9344 }),
    ];
    assert.equal(Math.round(vehicleAt(accelerating, T0 + 500)!.speedMph), 50);
  });

  test('hides the marker outside the track', () => {
    assert.equal(vehicleAt(track, T0 - 60_000), undefined);
    assert.equal(vehicleAt(track, T0 + 60_000), undefined);
  });

  test('does not interpolate across a recording gap', () => {
    const gapped = [point(0), { ...point(1), timestampMs: T0 + 30_000 }];
    // Halfway through the gap is closer to neither sample than the tolerance.
    assert.equal(vehicleAt(gapped, T0 + 15_000), undefined);
    // Just after the first sample it still snaps to it.
    assert.equal(vehicleAt(gapped, T0 + 2_000)!.latitude, 42.3);
  });

  test('refuses a NaN or missing cursor rather than guessing', () => {
    assert.equal(vehicleAt(track, null), undefined);
    assert.equal(vehicleAt(track, Number.NaN), undefined);
    assert.equal(vehicleAt([], T0), undefined);
  });

  test('skips unusable coordinates', () => {
    const broken = [point(0, { latitude: Number.NaN }), point(1)];
    near(vehicleAt(broken, T0 + 1000)!.latitude, 42.3 + 0.001, 'latitude');
  });
});
