import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrack } from '../src/clean.ts';
import { detectCornering, gpsLateralGAt, CORNER_MODERATE_G, CORNER_SEVERE_G } from '../src/cornering.ts';
import { lateralGAt } from '../src/accel.ts';
import { summarize } from '../src/summary.ts';
import type { TelemetryPoint } from '../src/gpmd.ts';

const T0 = Date.UTC(2026, 7, 1, 19, 23, 29);
/**
 * A drive at constant speed through the given headings, one sample a second.
 * Positions are left nearly still: cornering reads speed and heading only.
 */
const drive = (speedKph: number, headings: number[], spacingSec = 1): TelemetryPoint[] =>
  headings.map((headingDeg, i) => ({
    index: i,
    localTime: { year: 2026, month: 8, day: 1, hour: 11, minute: 23, second: 29 },
    utcTime: { hour: 19, minute: 23, second: 29 },
    timestampMs: T0 + i * spacingSec * 1000,
    latitude: 42.1,
    longitude: -71.3 + i * 0.0001,
    speedKph,
    speedKnots: speedKph / 1.852,
    headingDeg,
    accel: { x: 0, y: 0, z: 0 },
    hasFix: true,
  }));

/** Heading rate (deg/s) that produces `g` of lateral force at `kph`. */
const degPerSecFor = (g: number, kph: number) => ((g * 9.80665) / (kph / 3.6)) * (180 / Math.PI);

/** Straight, then a steady turn at `rate` deg/s for `seconds`, then straight. */
const turn = (kph: number, rate: number, seconds: number) => {
  const headings: number[] = [];
  let h = 10;
  for (let i = 0; i < 5; i++) headings.push(h);
  for (let i = 0; i < seconds; i++) { h += rate; headings.push(h); }
  for (let i = 0; i < 5; i++) headings.push(h);
  return cleanTrack(drive(kph, headings.map((x) => ((x % 360) + 360) % 360)));
};

describe('gpsLateralGAt', () => {
  test('v times yaw rate, positive turning right', () => {
    const kph = 50;
    const points = turn(kph, degPerSecFor(0.3, kph), 6);
    const g = gpsLateralGAt(points, 8);
    assert.ok(Math.abs(g - 0.3) < 0.01, `got ${g}`);
  });

  test('wraps through north without reading as a spin', () => {
    const points = cleanTrack(drive(60, [350, 355, 0, 5, 10]));
    const g = gpsLateralGAt(points, 2);
    assert.ok(g > 0 && g < 0.2, `got ${g}`);
  });

  test('ignores heading wander at walking pace', () => {
    const points = cleanTrack(drive(10, [0, 60, 120]));
    assert.equal(gpsLateralGAt(points, 1), 0);
  });

  test('ignores a fix gap', () => {
    const points = cleanTrack(drive(60, [0, 90, 180], 5));
    assert.equal(gpsLateralGAt(points, 1), 0);
  });

  test('the live meter uses the same signal at speed', () => {
    const kph = 50;
    const points = turn(kph, -degPerSecFor(0.35, kph), 6);
    assert.equal(lateralGAt(points, 8), gpsLateralGAt(points, 8));
    assert.ok(lateralGAt(points, 8) < -0.3);
  });
});

describe('detectCornering', () => {
  test('a gentle bend is not an event', () => {
    assert.equal(detectCornering(turn(50, degPerSecFor(0.2, 50), 8)).length, 0);
  });

  test('a hard left is one moderate event', () => {
    const events = detectCornering(turn(50, -degPerSecFor(0.33, 50), 5));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'cornering');
    assert.equal(events[0]!.direction, 'left');
    assert.equal(events[0]!.severity, 'moderate');
    assert.ok(events[0]!.peakG < -CORNER_MODERATE_G);
  });

  test('severe above the severe threshold', () => {
    const [event] = detectCornering(turn(60, degPerSecFor(0.45, 60), 4));
    assert.equal(event?.severity, 'severe');
    assert.ok(event!.peakG > CORNER_SEVERE_G);
    assert.equal(event!.direction, 'right');
  });

  test('a chicane is two events', () => {
    const r = degPerSecFor(0.35, 50);
    const headings = [10, 10, 10, 10 + r, 10 + 2 * r, 10 + 3 * r, 10 + 2 * r, 10 + r, 10, 10, 10];
    const events = detectCornering(cleanTrack(drive(50, headings)));
    assert.deepEqual(events.map((e) => e.direction), ['right', 'left']);
  });

  test('summaries include cornering alongside braking, in time order', () => {
    const summary = summarize(turn(50, degPerSecFor(0.35, 50), 5))!;
    assert.ok(summary.harshEvents.some((e) => e.kind === 'cornering'));
    const starts = summary.harshEvents.map((e) => e.startMs);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });
});
