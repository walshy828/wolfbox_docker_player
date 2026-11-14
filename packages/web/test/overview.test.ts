import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardTotals, formatSpan, matchesBand } from '../src/overview.ts';
import type { TripStatsEntry } from '../src/tripStats.ts';

const ready = (score: number | null, band: 'low' | 'moderate' | 'high', over = 0): TripStatsEntry => ({
  status: 'ready', distanceMeters: 1609.344 * 10, maxSpeedKph: 100, averageMovingSpeedKph: 50,
  movingSec: 600, harshEvents: { moderate: 1, severe: 1 }, limits: 'ready', route: [],
  risk: score === null ? null : {
    score, band, factors: [], includesSpeeding: true,
    speeding: { stretchSec: over, stretchCount: 1, longestSec: over, peakExcessKph: 10, bySeverity: { minor: 0, moderate: 1, severe: 0 }, overShare: 0.1, assumed: false },
  },
});

test('cardTotals adds up what has been read and averages what has been scored', () => {
  const stats = new Map<string, TripStatsEntry>([
    ['a', ready(90, 'low', 30)],
    ['b', ready(50, 'high', 90)],
    ['c', ready(null, 'low')],
    ['d', { status: 'pending' }],
  ]);
  const totals = cardTotals(['a', 'b', 'c', 'd', 'e'], stats);
  assert.equal(totals.drives, 5);
  assert.equal(totals.read, 3);
  assert.ok(Math.abs(totals.miles - 30) < 1e-9);
  assert.equal(totals.averageScore, 70);
  assert.deepEqual(totals.byBand, { low: 1, moderate: 0, high: 1 });
  assert.equal(totals.overLimitSec, 120);
  assert.equal(totals.hardEvents, 6);
  assert.equal(Math.round(totals.topMph), 62);
});

test('no average until something is scored', () => {
  assert.equal(cardTotals(['x'], new Map()).averageScore, null);
});

test('matchesBand', () => {
  assert.equal(matchesBand(ready(50, 'high'), 'high'), true);
  assert.equal(matchesBand(ready(90, 'low'), 'high'), false);
  assert.equal(matchesBand({ status: 'pending' }, 'high'), false);
  assert.equal(matchesBand(undefined, 'all'), true);
});

test('formatSpan', () => {
  assert.equal(formatSpan(35), '35s');
  assert.equal(formatSpan(48 * 60), '48m');
  assert.equal(formatSpan(3 * 3600 + 12 * 60), '3h 12m');
});
