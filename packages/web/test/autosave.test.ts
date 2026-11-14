import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autosaveCandidates } from '../src/autosave.ts';
import type { CardTrip } from '../src/card.ts';
import type { TripStatsEntry } from '../src/tripStats.ts';

const trip = (id: string, startLocalMs: number): CardTrip =>
  ({ id, startLocalMs, endLocalMs: startLocalMs + 60_000, hasEvent: false, clips: [] });
const ready = (limits: 'pending' | 'ready' | 'unavailable'): TripStatsEntry => ({
  status: 'ready', distanceMeters: 1000, maxSpeedKph: 50, averageMovingSpeedKph: 40, movingSec: 60,
  harshEvents: { moderate: 0, severe: 0 }, limits, risk: null, route: [],
});

test('saves drives once their limits lookup has finished, oldest first', () => {
  const drives = [trip('c', 3), trip('a', 1), trip('b', 2), trip('d', 4)];
  const stats = new Map<string, TripStatsEntry>([
    ['a', ready('ready')], ['b', ready('unavailable')], ['c', ready('pending')], ['d', { status: 'pending' }],
  ]);
  assert.deepEqual(autosaveCandidates(drives, stats, new Map(), new Set()).map((t) => t.id), ['a', 'b']);
});

test('skips drives already saved with limits, or already tried', () => {
  const drives = [trip('a', 1), trip('b', 2), trip('c', 3)];
  const stats = new Map<string, TripStatsEntry>([['a', ready('ready')], ['b', ready('ready')], ['c', ready('ready')]]);
  const archived = new Map([['a', { risk: { includesSpeeding: true } as never }]]);
  assert.deepEqual(autosaveCandidates(drives, stats, archived, new Set(['c'])).map((t) => t.id), ['b']);
});

test('saves again a copy made before limits were known', () => {
  const drives = [trip('a', 1)];
  const archived = new Map([['a', { risk: { includesSpeeding: false } as never }]]);
  assert.equal(autosaveCandidates(drives, new Map([['a', ready('ready')]]), archived, new Set()).length, 1);
  assert.equal(autosaveCandidates(drives, new Map([['a', ready('unavailable')]]), archived, new Set()).length, 0);
});
