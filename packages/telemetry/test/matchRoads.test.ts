import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoads } from '../src/matchRoads.ts';
import type { RoadWay } from '../src/roads.ts';
import type { CleanPoint } from '../src/clean.ts';

const T0 = Date.UTC(2026, 7, 1, 19, 23, 29);
/** Metres per degree at the reference card's latitude. */
const M_PER_LAT = 111_320;
const M_PER_LON = 82_400;

/** A run of samples, each `metresNorth` further along, at a fixed offset east. */
function run(
  count: number,
  { eastM = 0, headingDeg = 0, speedKph = 80, startNorthM = 0 } = {},
): CleanPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const northM = startNorthM + i * 22;  // ~80 km/h at 1 Hz
    return {
      index: i,
      localTime: { year: 2026, month: 8, day: 1, hour: 11, minute: 23, second: 29 + i },
      utcTime: { hour: 19, minute: 23, second: 29 + i },
      timestampMs: T0 + i * 1000,
      latitude: 42.30 + northM / M_PER_LAT,
      longitude: -71.50 + eastM / M_PER_LON,
      speedKph, speedKnots: speedKph / 1.852, headingDeg,
      accel: { x: 0, y: 0, z: 0 }, hasFix: true,
      smoothedSpeedKph: speedKph,
    } satisfies CleanPoint;
  });
}

/** A straight north-south way at a given offset east of the origin. */
const northSouthWay = (id: number, eastM: number, tags: Record<string, string>): RoadWay => ({
  id, tags,
  geometry: [
    { latitude: 42.30 - 200 / M_PER_LAT, longitude: -71.50 + eastM / M_PER_LON },
    { latitude: 42.30 + 600 / M_PER_LAT, longitude: -71.50 + eastM / M_PER_LON },
  ],
});

describe('matchRoads', () => {
  test('a sample on a road is matched to that road', () => {
    const ways = [northSouthWay(1, 0, { highway: 'primary' })];
    const matches = matchRoads(run(10), ways);
    assert.ok(matches.every((m) => m.wayId === 1), 'every sample found the road');
    assert.equal(matches.length, 10);
  });

  test('a sample far from every road is unmatched, not forced onto one', () => {
    const ways = [northSouthWay(1, 0, { highway: 'primary' })];
    // 80 m east of the only road, well beyond any plausible GPS error.
    const matches = matchRoads(run(10, { eastM: 80 }), ways);
    assert.ok(matches.every((m) => m.wayId === undefined), 'stayed unmatched');
  });

  test('the northbound carriageway is never matched to the southbound one', () => {
    // Two carriageways 24 m apart. The car sits nearer the southbound one, so
    // distance alone would pick it; the direction of travel must override.
    const ways = [
      northSouthWay(1, 0, { highway: 'motorway', oneway: 'yes', maxspeed: '65 mph' }),
      northSouthWay(2, 24, { highway: 'motorway', oneway: 'yes', maxspeed: '65 mph' }),
    ];
    // Way 2 is drawn south-to-north too, so flip it to make it truly southbound.
    ways[1]!.geometry.reverse();

    const matches = matchRoads(run(10, { eastM: 15, headingDeg: 0 }), ways);
    assert.ok(matches.every((m) => m.wayId === 1),
      `expected the northbound way, got ${[...new Set(matches.map((m) => m.wayId))]}`);
  });

  test('crossing an intersection does not switch the matched road', () => {
    const ways = [
      northSouthWay(1, 0, { highway: 'primary', maxspeed: '45 mph' }),
      // A cross street through the middle of the run, briefly within range.
      {
        id: 2, tags: { highway: 'residential', maxspeed: '25 mph' },
        geometry: [
          { latitude: 42.30 + 110 / M_PER_LAT, longitude: -71.50 - 200 / M_PER_LON },
          { latitude: 42.30 + 110 / M_PER_LAT, longitude: -71.50 + 200 / M_PER_LON },
        ],
      } satisfies RoadWay,
    ];
    const matches = matchRoads(run(12), ways);
    assert.ok(matches.every((m) => m.wayId === 1),
      'the cross street never took the samples driving straight through it');
  });

  test('a real turn onto another road is followed', () => {
    const ways = [
      northSouthWay(1, 0, { highway: 'primary' }),
      {
        id: 2, tags: { highway: 'residential' },
        geometry: [
          { latitude: 42.30 + 220 / M_PER_LAT, longitude: -71.50 },
          { latitude: 42.30 + 220 / M_PER_LAT, longitude: -71.50 + 400 / M_PER_LON },
        ],
      } satisfies RoadWay,
    ];
    // North up the primary, then a sustained run east along the residential.
    const north = run(10, { headingDeg: 0 });
    const east = Array.from({ length: 10 }, (_, i) => ({
      ...north[0]!,
      index: 10 + i,
      timestampMs: T0 + (10 + i) * 1000,
      latitude: 42.30 + 220 / M_PER_LAT,
      longitude: -71.50 + (i * 22) / M_PER_LON,
      headingDeg: 90,
    }));
    const matches = matchRoads([...north, ...east], ways);
    assert.equal(matches.at(-1)!.wayId, 2, 'ended up on the road actually turned onto');
    assert.equal(matches[0]!.wayId, 1, 'started on the road actually driven');
  });

  test('at a standstill the road is held rather than re-decided on a stale heading', () => {
    const ways = [
      northSouthWay(1, 0, { highway: 'primary' }),
      northSouthWay(2, 26, { highway: 'service' }),
    ];
    // Moving north, then stopped with the heading field wandering, as a
    // stationary receiver's does.
    const moving = run(6, { headingDeg: 0 });
    const parked = Array.from({ length: 6 }, (_, i) => ({
      ...moving.at(-1)!,
      index: 6 + i,
      timestampMs: T0 + (6 + i) * 1000,
      speedKph: 0, smoothedSpeedKph: 0,
      headingDeg: (i * 71) % 360,
    }));
    const matches = matchRoads([...moving, ...parked], ways);
    assert.ok(matches.every((m) => m.wayId === 1),
      'a parked car did not wander onto the service road');
  });

  test('travel direction is reported, so directional tags can be applied', () => {
    const ways = [northSouthWay(1, 0, { highway: 'primary' })];
    assert.equal(matchRoads(run(5, { headingDeg: 0 }), ways)[2]!.forward, true);
    assert.equal(matchRoads(run(5, { headingDeg: 180 }), ways)[2]!.forward, false);
  });

  test('an empty road network leaves everything unmatched without throwing', () => {
    const matches = matchRoads(run(5), []);
    assert.equal(matches.length, 5);
    assert.ok(matches.every((m) => m.wayId === undefined));
  });
});
