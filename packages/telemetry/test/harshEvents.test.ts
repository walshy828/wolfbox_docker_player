import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrack } from '../src/clean.ts';
import { detectHarshEvents, HARSH_DELTA_KPH, SEVERE_DELTA_KPH } from '../src/harshEvents.ts';
import type { TelemetryPoint } from '../src/gpmd.ts';

const T0 = Date.UTC(2026, 7, 1, 19, 23, 29);
/** A straight eastbound run, one sample per second. */
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
    accel: { x: 0, y: 0, z: 0 },
    hasFix: true,
  }));

const detect = (speeds: number[]) => detectHarshEvents(cleanTrack(run(speeds)));

/** Samples at explicit offsets, for simulating a dropped or reacquired GPS fix. */
const gappy = (entries: { speedKph: number; offsetSec: number }[]): TelemetryPoint[] =>
  entries.map(({ speedKph, offsetSec }, i) => ({
    index: i,
    localTime: { year: 2026, month: 8, day: 1, hour: 11, minute: 23, second: 29 },
    utcTime: { hour: 19, minute: 23, second: 29 },
    timestampMs: T0 + offsetSec * 1000,
    latitude: 42.1,
    longitude: -71.3 + offsetSec * 0.0001,
    speedKph,
    speedKnots: speedKph / 1.852,
    headingDeg: 90,
    accel: { x: 0, y: 0, z: 0 },
    hasFix: true,
  }));

describe('detectHarshEvents', () => {
  test('returns nothing for an empty track', () => {
    assert.deepEqual(detectHarshEvents([]), []);
  });

  test('gentle slowing is not an event', () => {
    assert.deepEqual(detect([50, 47, 44, 41, 38]), []);
  });

  test('a single triggering sample is one event', () => {
    const events = detect([50, 50, 50, 20, 20]);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event!.kind, 'braking');
    assert.ok(event!.peakDeltaKph < 0);
    assert.equal(event!.startMs, event!.endMs);
    assert.equal(event!.peakAtMs, event!.startMs);
  });

  test('a hard acceleration is flagged as such', () => {
    const events = detect([20, 20, 20, 50, 50]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'acceleration');
    assert.ok(events[0]!.peakDeltaKph > 0);
  });

  test('one dropped sample mid-stop does not split the event', () => {
    // 50 -> 30 (delta -20) -> 29 (delta -1, under threshold) -> 9 (delta -20).
    const events = detect([50, 30, 29, 9]);
    assert.equal(events.length, 1, `expected one merged event, got ${events.length}`);
    assert.equal(events[0]!.startMs, T0 + 1000);
    assert.equal(events[0]!.endMs, T0 + 3000);
  });

  test('two consecutive dropped samples end the event', () => {
    // 50 -> 30 (delta -20) -> 29 -> 28 (both under threshold) -> 8 (delta -20).
    const events = detect([50, 30, 29, 28, 8]);
    assert.equal(events.length, 2, `expected two events, got ${events.length}`);
  });

  test('an opposite-sign spike starts a new event', () => {
    // Hard brake, held for a moment, then floor it: two events, not one with a
    // sign flip. (A single-sample dip would be erased by median smoothing, so
    // the low speed is held for two samples to survive it.)
    const events = detect([50, 50, 20, 20, 50, 50]);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.kind, 'braking');
    assert.equal(events[1]!.kind, 'acceleration');
  });

  test('severity tiers on peak magnitude', () => {
    const moderate = detect([50, 50, 50, 35]); // delta -15, between the two thresholds
    assert.equal(moderate.length, 1);
    assert.equal(moderate[0]!.severity, 'moderate');
    assert.ok(Math.abs(moderate[0]!.peakDeltaKph) >= HARSH_DELTA_KPH);
    assert.ok(Math.abs(moderate[0]!.peakDeltaKph) < SEVERE_DELTA_KPH);

    const severe = detect([60, 60, 60, 25]); // delta -35, clears the severe threshold
    assert.equal(severe.length, 1);
    assert.equal(severe[0]!.severity, 'severe');
    assert.ok(Math.abs(severe[0]!.peakDeltaKph) >= SEVERE_DELTA_KPH);
  });

  test('distance covers the span of the event', () => {
    // Three seconds of hard braking at ~8.3 m/s of eastward travel per sample.
    const events = detect([60, 40, 20, 0]);
    assert.equal(events.length, 1);
    assert.ok(events[0]!.distanceMeters > 15 && events[0]!.distanceMeters < 30,
      `${events[0]!.distanceMeters}m`);
  });

  test('peak timing picks the true maximum inside a multi-sample run', () => {
    // Deltas: -13, -25, -14 -- the middle sample is the peak.
    const events = detect([60, 47, 22, 8]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.peakAtMs, T0 + 2000);
  });

  test('a speed jump across a lost-then-reacquired GPS fix is not a launch', () => {
    // Stopped, then the fix drops for six seconds (a tunnel, a garage) and
    // comes back with the car already doing 30 mph -- not a hard launch.
    const events = detectHarshEvents(cleanTrack(gappy([
      { speedKph: 0, offsetSec: 0 },
      { speedKph: 0, offsetSec: 1 },
      { speedKph: 48, offsetSec: 7 },
    ])));
    assert.deepEqual(events, []);
  });

  test('the same jump in one real second is still flagged', () => {
    const events = detectHarshEvents(cleanTrack(gappy([
      { speedKph: 0, offsetSec: 0 },
      { speedKph: 0, offsetSec: 1 },
      { speedKph: 48, offsetSec: 2 },
    ])));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'acceleration');
  });
});
