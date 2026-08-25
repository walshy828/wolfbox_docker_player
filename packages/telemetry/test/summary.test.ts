import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrack } from '../src/clean.ts';
import { summarize, STOPPED_KPH } from '../src/summary.ts';
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
    // ~0.0001 degrees of longitude per second at this latitude is ~8.3m/s.
    longitude: -71.3 + i * 0.0001,
    speedKph,
    speedKnots: speedKph / 1.852,
    headingDeg: 90,
    accel: { x: 0, y: 0, z: 0 },
    hasFix: true,
  }));

describe('summarize', () => {
  test('returns null for an empty track', () => {
    assert.equal(summarize([]), null);
  });

  test('measures duration, distance and speed', () => {
    const s = summarize(cleanTrack(run(Array(11).fill(30))))!;
    assert.equal(s.durationSec, 10);
    assert.equal(s.maxSpeedKph, 30);
    assert.equal(Math.round(s.averageSpeedKph), 30);
    // Ten steps of ~8.3m.
    assert.ok(s.distanceMeters > 70 && s.distanceMeters < 95, `${s.distanceMeters}m`);
  });

  test('separates moving from stopped time', () => {
    const s = summarize(cleanTrack(run([0, 0, 0, 40, 40, 40, 40, 0, 0, 0, 0])))!;
    assert.equal(s.movingSec + s.stoppedSec, s.durationSec);
    assert.equal(s.movingSec, 4);
    assert.ok(s.averageMovingSpeedKph === 40, 'moving average ignores the stops');
    assert.ok(s.averageSpeedKph < 20, 'overall average includes them');
  });

  test('treats GPS jitter at rest as stopped', () => {
    const s = summarize(cleanTrack(run(Array(11).fill(STOPPED_KPH - 1))))!;
    assert.equal(s.movingSec, 0);
  });

  test('flags harsh braking but not ordinary slowing', () => {
    const gentle = summarize(cleanTrack(run([50, 47, 44, 41, 38])))!;
    assert.equal(gentle.harshEvents.length, 0);

    const slam = summarize(cleanTrack(run([50, 50, 50, 20, 20])))!;
    const braking = slam.harshEvents.filter((e) => e.kind === 'braking');
    assert.equal(braking.length, 1);
    assert.ok(braking[0]!.peakDeltaKph < 0);
  });

  // A real trip on the reference card reported a 44 mph maximum but contained
  // one 161 km/h sample -- under the outlier clamp, yet obviously wrong.
  test('time above the ramp top lands in the 80+ band', () => {
    // 145 km/h is 90 mph.
    const s = summarize(cleanTrack(run([145, 145, 145, 145])))!;
    assert.ok(s.histogramMph[4]! > 0, 'expected time in the 80+ band');
    assert.equal(s.histogramMph[3], 0);
  });

  test('an isolated spike does not become the trip maximum', () => {
    const s = summarize(cleanTrack(run([50, 50, 50, 161, 50, 50, 50])))!;
    assert.equal(s.maxSpeedKph, 50);
    assert.equal(s.harshEvents.length, 0);
    assert.equal(s.histogramMph[4], 0, 'nothing lands in the 80+ mph bucket');
  });

  test('a sustained high speed is kept', () => {
    const s = summarize(cleanTrack(run([110, 112, 111, 113, 112])))!;
    assert.ok(s.maxSpeedKph >= 110, `max was ${s.maxSpeedKph}`);
  });

  test('buckets time by speed and bounds the route', () => {
    // 20 mph -> bucket 1 (15-35), 50 mph -> bucket 2 (35-60).
    const s = summarize(cleanTrack(run([32.2, 32.2, 32.2, 80.5, 80.5, 80.5])))!;
    assert.ok(s.histogramMph[1]! > 0);
    assert.ok(s.histogramMph[2]! > 0);
    assert.equal(s.histogramMph[5], undefined);
    assert.ok(s.bounds!.east > s.bounds!.west);
    assert.equal(s.bounds!.north, 42.1);
  });
});
