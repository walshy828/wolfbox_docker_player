import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessAdherence, TOLERANCE_MPH } from '../src/adherence.ts';
import type { RoadMatch, RoadWay } from '../src/roads.ts';
import type { CleanPoint } from '../src/clean.ts';
import { mphToKph } from '../src/geo.ts';

const T0 = Date.UTC(2026, 7, 1, 19, 23, 29);
const M_PER_LAT = 111_320;

/** One second of driving at a given speed, straight north. */
const point = (i: number, mph: number): CleanPoint => ({
  index: i,
  localTime: { year: 2026, month: 8, day: 1, hour: 11, minute: 23, second: 29 + i },
  utcTime: { hour: 19, minute: 23, second: 29 + i },
  timestampMs: T0 + i * 1000,
  latitude: 42.30 + (i * 20) / M_PER_LAT,
  longitude: -71.50,
  speedKph: mphToKph(mph),
  speedKnots: mphToKph(mph) / 1.852,
  headingDeg: 0,
  accel: { x: 0, y: 0, z: 0 },
  hasFix: true,
  smoothedSpeedKph: mphToKph(mph),
});

const ROAD: RoadWay = {
  id: 1, tags: { highway: 'primary', maxspeed: '30 mph', name: 'Main Street' },
  geometry: [{ latitude: 42.29, longitude: -71.50 }, { latitude: 42.32, longitude: -71.50 }],
};

/** Drives `speeds` (mph) along one road with a signed limit. */
function drive(speeds: number[], ways: RoadWay[] = [ROAD], wayIds?: (number | undefined)[]) {
  const points = speeds.map((mph, i) => point(i, mph));
  const matches: RoadMatch[] = points.map((p, i) => ({
    timestampMs: p.timestampMs,
    wayId: wayIds ? wayIds[i] : ways[0]!.id,
    forward: true,
  }));
  return assessAdherence(points, matches, ways, 'US');
}

const at = (mph: number, seconds: number) => Array(seconds).fill(mph);

describe('assessAdherence', () => {
  test('driving at the limit produces nothing to report', () => {
    const report = drive(at(30, 60));
    assert.equal(report.stretches.length, 0);
    assert.equal(report.overLimitSec, 0);
    assert.equal(report.score, 1);
  });

  test('a brief drift over the tolerance is not a stretch', () => {
    // Nine seconds at +8 mph, which is over the +5 tolerance but not sustained.
    const report = drive([...at(30, 20), ...at(38, 9), ...at(30, 20)]);
    assert.equal(report.stretches.length, 0, 'nine seconds is under the ten-second bar');
  });

  test('sustained speeding over the tolerance is a stretch', () => {
    const report = drive([...at(30, 20), ...at(38, 15), ...at(30, 20)]);
    assert.equal(report.stretches.length, 1);
    assert.equal(report.stretches[0]!.roadName, 'Main Street');
  });

  test('the stretch begins when the speeding began, not ten seconds later', () => {
    const report = drive([...at(30, 20), ...at(38, 15), ...at(30, 20)]);
    const stretch = report.stretches[0]!;
    // The 21st sample (index 20) is the first one over.
    assert.equal(stretch.startMs, T0 + 20_000,
      'start was back-dated to the first sample over the tolerance');
  });

  test('one dropped sample does not restart the ten-second clock', () => {
    // Noise puts a single second back under the tolerance mid-run. A strict
    // unbroken-run rule would never open a stretch here.
    const speeds = [...at(30, 10), ...at(38, 6), 34, ...at(38, 8), ...at(30, 10)];
    assert.equal(drive(speeds).stretches.length, 1);
  });

  test('a stretch does not end until the car is back at the limit', () => {
    // Eases off to +4 mph -- under the tolerance, but still over the limit.
    // That must not close the stretch and start a second one.
    const speeds = [...at(30, 10), ...at(40, 12), ...at(34, 12), ...at(40, 12), ...at(30, 10)];
    const report = drive(speeds);
    assert.equal(report.stretches.length, 1, 'one continuous offence, not two');
  });

  test('a genuine return to the limit closes the stretch', () => {
    const speeds = [
      ...at(30, 10), ...at(40, 12), ...at(29, 10), ...at(40, 12), ...at(30, 10),
    ];
    assert.equal(drive(speeds).stretches.length, 2, 'two separate offences');
  });

  test('leaving a fast road for a slow one does not carry the speeding into town', () => {
    const highway: RoadWay = {
      id: 2, tags: { highway: 'motorway', maxspeed: '65 mph', name: 'Interstate' },
      geometry: ROAD.geometry,
    };
    // 75 in a 65, then straight onto a 30 still doing 40.
    const speeds = [...at(75, 20), ...at(40, 20)];
    const ids = [...Array(20).fill(2), ...Array(20).fill(1)];
    const report = drive(speeds, [highway, ROAD], ids);
    assert.equal(report.stretches.length, 2);
    assert.equal(report.stretches[0]!.limitKph, mphToKph(65));
    assert.equal(report.stretches[1]!.limitKph, mphToKph(30));
  });

  test('a road with no limit at all can never be speeding', () => {
    const autobahn: RoadWay = {
      id: 3, tags: { highway: 'motorway', maxspeed: 'none' }, geometry: ROAD.geometry,
    };
    const report = drive(at(120, 40), [autobahn]);
    assert.equal(report.stretches.length, 0);
    assert.equal(report.overLimitSec, 0);
    assert.ok(report.coverage.taggedSec > 0, 'still counts as a road we knew about');
  });

  test('unmatched time is reported as unmatched, never as compliant', () => {
    const speeds = at(50, 40);
    const report = drive(speeds, [ROAD], Array(40).fill(undefined));
    assert.equal(report.stretches.length, 0, 'no road, so no verdict');
    assert.equal(report.coverage.unmatchedSec, report.coverage.movingSec);
    assert.equal(report.score, null, 'nothing known, so nothing scored');
  });

  test('too little known limit yields no score rather than a flattering one', () => {
    // Three quarters of the drive off-network, the rest driven perfectly.
    const speeds = at(30, 40);
    const ids = [...Array(30).fill(undefined), ...Array(10).fill(1)];
    const report = drive(speeds, [ROAD], ids);
    assert.equal(report.score, null, 'below half coverage there is no honest score');
  });

  test('a guessed limit is kept out of the headline score', () => {
    const untagged: RoadWay = {
      id: 4, tags: { highway: 'residential', name: 'Elm Street' }, geometry: ROAD.geometry,
    };
    // 40 mph on an untagged residential street, which US law puts at 25.
    const report = drive(at(40, 40), [untagged]);
    assert.equal(report.score, null, 'guesswork does not produce a headline score');
    assert.ok(report.scoreWithInferred !== null, 'but it is still reported separately');
    assert.ok(report.coverage.inferredSec > 0);
    assert.equal(report.stretches[0]!.limitSource, 'inferred',
      'the stretch is marked as resting on a guess');
  });

  test('severity is keyed to excess over the limit, not over the tolerance', () => {
    // +12 mph over a 30 limit is moderate; the tolerance does not shift it.
    assert.equal(drive([...at(42, 15)]).stretches[0]!.severity, 'moderate');
    assert.equal(drive([...at(36, 15)]).stretches[0]!.severity, 'minor');
    assert.equal(drive([...at(55, 15)]).stretches[0]!.severity, 'severe');
  });

  test('the worst moment is reported, and when it happened', () => {
    const report = drive([...at(38, 12), 48, ...at(38, 12)]);
    assert.ok(Math.abs(report.peakExcessKph - mphToKph(18)) < 0.1);
    assert.equal(report.peakExcessAtMs, T0 + 12_000);
  });

  test('time spent stopped is not counted as driving', () => {
    const report = drive([...at(0, 30), ...at(30, 30)]);
    assert.ok(Math.abs(report.coverage.movingSec - 30) <= 1, `${report.coverage.movingSec}s`);
  });

  test('an empty trip does not throw', () => {
    const report = assessAdherence([], [], [], 'US');
    assert.equal(report.stretches.length, 0);
    assert.equal(report.score, null);
  });

  test('the tolerance is the documented five miles an hour', () => {
    // Exactly at the tolerance line is not over it.
    assert.equal(drive(at(30 + TOLERANCE_MPH, 40)).stretches.length, 0);
    assert.equal(drive(at(30 + TOLERANCE_MPH + 2, 40)).stretches.length, 1);
  });
});
