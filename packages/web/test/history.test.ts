import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  periods, driverSummaries, reconcile, bucketStart, tripDate, driverSlot, inRange, averageScore, UNASSIGNED,
} from '../src/history.ts';
import type { ArchivedTrip } from '../src/archive.ts';
import type { TimeContext } from '../src/time.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 18); // Sat 14 Nov 2026, 18:00 UTC
const utc: TimeContext = { zone: 'UTC', cameraUtcOffsetMs: 0 };

const trip = (daysAgo: number, over: Partial<ArchivedTrip> = {}): ArchivedTrip => {
  const startMs = NOW - daysAgo * DAY;
  return {
    id: `t${daysAgo}`, startLocalMs: startMs, endLocalMs: startMs + 600_000, startMs, endMs: startMs + 600_000,
    cameraOffsetMs: 0, driverId: 1, driverName: 'Alex', hasEvent: false, distanceMeters: 1609.344 * 10,
    durationSec: 600, movingSec: 600, maxSpeedKph: 100, averageMovingSpeedKph: 60, hardEvents: 1,
    severeEvents: 0, overLimitSec: 60, startLabel: null, endLabel: null, summary: {},
    risk: { score: 80, band: 'moderate', factors: [], speeding: null, includesSpeeding: true },
    route: [], importedMs: 0, clips: [], ...over,
  };
};

describe('periods', () => {
  test('30 days is thirty daily buckets, quiet days included', () => {
    const result = periods([trip(0), trip(0.1), trip(3)], '30d', NOW, utc);
    assert.equal(result.length, 30);
    assert.equal(result.at(-1)!.total.drives, 2);
    assert.equal(result.at(-4)!.total.drives, 1);
    assert.equal(result.filter((p) => p.total.drives === 0).length, 28);
  });

  test('weeks start on Monday and months on the 1st', () => {
    assert.equal(new Date(bucketStart({ y: 2026, m: 11, d: 14 }, 'week')).toISOString().slice(0, 10), '2026-11-09');
    assert.equal(new Date(bucketStart({ y: 2026, m: 11, d: 9 }, 'week')).toISOString().slice(0, 10), '2026-11-09');
    assert.equal(new Date(bucketStart({ y: 2026, m: 11, d: 14 }, 'month')).toISOString().slice(0, 10), '2026-11-01');
  });

  test('splits by driver and averages scores', () => {
    const [period] = periods([trip(0), trip(0, { driverId: 2, driverName: 'Sam', risk: null })], '30d', NOW, utc).slice(-1);
    assert.equal(period!.byDriver.size, 2);
    assert.ok(Math.abs(period!.total.miles - 20) < 1e-9);
    assert.equal(averageScore(period!.total), 80, 'unscored drives do not drag the average');
  });

  test('all time runs from the first drive', () => {
    const result = periods([trip(400)], 'all', NOW, utc);
    assert.equal(result[0]!.total.drives, 1);
    assert.equal(result.length, 14, 'Oct 2025 to Nov 2026');
    assert.deepEqual(periods([], 'all', NOW, utc), []);
  });

  test('range filters by when the drive started', () => {
    assert.deepEqual(inRange([trip(10), trip(40)], '30d', NOW, utc).map((t) => t.id), ['t10']);
  });
});

test('dates follow the chosen zone: a late drive in New York is the previous day there', () => {
  const late = trip(0, { startMs: Date.UTC(2026, 10, 14, 2) }); // 21:00 on the 13th in New York
  assert.deepEqual(tripDate(late, { zone: 'America/New_York' }), { y: 2026, m: 11, d: 13 });
  assert.deepEqual(tripDate(late, utc), { y: 2026, m: 11, d: 14 });
  const camera = trip(0, { startLocalMs: Date.UTC(2026, 10, 12, 23, 59) });
  assert.deepEqual(tripDate(camera, { zone: 'camera' }), { y: 2026, m: 11, d: 12 });
});

describe('driverSummaries', () => {
  const trips = [
    trip(1, { risk: { score: 60, band: 'high', factors: [], speeding: null, includesSpeeding: true } }),
    trip(2),
    trip(40, { risk: { score: 90, band: 'low', factors: [], speeding: null, includesSpeeding: true } }),
    trip(3, { driverId: null, driverName: null, distanceMeters: 1609.344 }),
  ];
  const [alex, unassigned] = driverSummaries(trips, NOW, utc);

  test('most-driven first, with rates people can compare', () => {
    assert.equal(alex!.name, 'Alex');
    assert.equal(alex!.drives, 3);
    assert.equal(alex!.highRisk, 1);
    assert.equal(alex!.overLimitMinPerHour, 6, '3 min over in 30 min driven');
    assert.ok(Math.abs(alex!.hardPer100mi - 10) < 1e-9);
    assert.equal(Math.round(alex!.topMph), 62);
    assert.equal(unassigned!.key, UNASSIGNED);
    assert.equal(unassigned!.name, 'Not assigned');
  });

  test('trend compares the last 30 days with the 30 before', () => {
    assert.equal(alex!.trend, -20, '70 now against 90 before');
    assert.equal(unassigned!.trend, null);
  });
});

test('reconcile compares the odometer with recorded drives between readings', () => {
  const readings = [
    { id: 2, readMs: NOW - 5 * DAY, miles: 1100, note: null },
    { id: 1, readMs: NOW - 20 * DAY, miles: 1000, note: null },
    { id: 3, readMs: NOW - 4 * DAY, miles: 1100, note: null },
  ];
  const checks = reconcile(readings, [trip(10), trip(12), trip(30)], utc);
  assert.equal(checks.length, 2);
  assert.equal(checks[0]!.odometerMiles, 100);
  assert.equal(checks[0]!.drives, 2);
  assert.ok(Math.abs(checks[0]!.share! - 0.2) < 1e-9);
  assert.equal(checks[1]!.share, null, 'no movement, no share');
});

test('driver colours follow the driver, not their rank', () => {
  const keys = ['7', '2', UNASSIGNED, '5', '9'];
  assert.equal(driverSlot('2', keys), 1);
  assert.equal(driverSlot('5', keys), 2);
  assert.equal(driverSlot('7', keys), 3);
  assert.equal(driverSlot('9', keys), 'other');
  assert.equal(driverSlot(UNASSIGNED, keys), 'none');
  assert.equal(driverSlot('5', ['5', '7']), 1, 'only depends on which drivers exist');
});
