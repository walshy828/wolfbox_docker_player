import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, type CleanPoint, type TripAdherence } from '@wolfbox/telemetry';
import { buildImportPayload, toReviewTrip, archivedClipStarts, toStatsEntry, UNLIMITED_KPH, type ArchivedTrip } from '../src/archive.ts';
import type { CardTrip } from '../src/card.ts';

const T = Date.UTC(2026, 9, 11, 16, 49, 3);
const point = (i: number, kph: number): CleanPoint => ({
  index: i, localTime: { year: 2026, month: 10, day: 11, hour: 8, minute: 49, second: 3 + i },
  utcTime: { hour: 16, minute: 49, second: 3 + i }, timestampMs: T + i * 1000,
  latitude: 42.3 + i * 0.0003, longitude: -71.5, speedKph: kph, speedKnots: kph / 1.852, headingDeg: 0,
  accel: { x: -180, y: 5 + i, z: 165 }, hasFix: true, smoothedSpeedKph: kph,
});
const points = Array.from({ length: 30 }, (_, i) => point(i, 60));
const summary = summarize(points)!;
const handle = {} as FileSystemFileHandle;
const trip: CardTrip = {
  id: '2026-10-11T08-49-00', startLocalMs: 0, endLocalMs: 60_000, hasEvent: false,
  clips: [{
    startLocalMs: 0, kind: 'normal',
    front: { name: '2026_10_11_084900_00.MP4', camera: 'front', kind: 'normal', startLocalMs: 0, handle },
    rear: { name: '2026_10_11_084910_01_b.MP4', camera: 'rear', kind: 'normal', startLocalMs: 10_000, handle },
  }],
};
const adherence = {
  stretches: [], excessKph: [], coverage: { movingSec: 30, taggedSec: 30, implicitSec: 0, inferredSec: 0, unknownSec: 0, unmatchedSec: 0 },
  limitKph: points.map((_, i) => (i < 10 ? undefined : i < 20 ? 80 : Infinity)),
  limitSource: points.map((_, i) => (i < 10 ? undefined : 'tagged')),
  score: 1, scoreWithInferred: 1, overLimitSec: 0, overLimitMeters: 0, peakExcessKph: 0, region: 'US',
} as unknown as TripAdherence;

test('the import payload carries the track column by column, with limits JSON can hold', () => {
  const body = buildImportPayload({
    trip, points, summary, clipStarts: [{ front: T, rear: T + 9_000 }], adherence, driverId: 3,
    startLabel: 'A', endLabel: 'B', cameraOffsetMs: -28_800_000,
  });
  assert.equal(body.points.t.length, 30);
  assert.equal(body.points.ay[4], 9);
  assert.equal(body.points.limit[0], null);
  assert.equal(body.points.limit[15], 80);
  assert.equal(body.points.limit[25], UNLIMITED_KPH);
  assert.equal(body.points.src[15], 'tagged');
  assert.deepEqual(body.clips.map((c) => [c.camera, c.startMs]), [['front', T], ['rear', T + 9_000]]);
  assert.equal(body.risk?.includesSpeeding, true);
  assert.ok(!('harshEvents' in body.summary), 'events travel separately');
  assert.equal(JSON.parse(JSON.stringify(body)).points.limit[25], UNLIMITED_KPH);
});

test('an archived drive comes back as the same trip, its clips pointing at the service', () => {
  const archived = {
    id: trip.id, startLocalMs: 0, endLocalMs: 60_000, startMs: T, endMs: T + 29_000, cameraOffsetMs: null,
    driverId: null, driverName: null, hasEvent: false, distanceMeters: 1000, durationSec: 29, movingSec: 29,
    maxSpeedKph: 60, averageMovingSpeedKph: 60, hardEvents: 2, severeEvents: 1, overLimitSec: 0,
    startLabel: 'A', endLabel: null, summary: {}, risk: null, route: [], importedMs: 0,
    clips: [
      { name: '2026_10_11_084900_00.MP4', camera: 'front', kind: 'normal', startLocalMs: 0, startMs: T, size: 10, stored: true },
      { name: '2026_10_11_084910_01_b.MP4', camera: 'rear', kind: 'normal', startLocalMs: 10_000, startMs: T + 9_000, size: 8, stored: false },
    ],
  } satisfies ArchivedTrip;
  const review = toReviewTrip(archived);
  assert.equal(review.clips.length, 1, 'front and rear re-paired');
  const front = review.clips[0]!.front!.handle;
  assert.ok('url' in front && front.url.endsWith(`/trips/${trip.id}/clips/2026_10_11_084900_00.MP4`));
  assert.deepEqual(archivedClipStarts(review), [{ front: T, rear: T + 9_000 }]);

  const entry = toStatsEntry(archived);
  assert.equal(entry.status, 'ready');
  if (entry.status === 'ready') assert.deepEqual(entry.harshEvents, { moderate: 1, severe: 1 });
});
