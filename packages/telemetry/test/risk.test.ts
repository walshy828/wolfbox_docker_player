import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, formatDuration, speedingStats, type RiskInput } from '../src/risk.ts';
import type { HarshEvent } from '../src/harshEvents.ts';
import type { OverLimitStretch, TripAdherence } from '../src/adherence.ts';
import { mphToKph } from '../src/geo.ts';

const MILE = 1609.344;

const summary = (over: Partial<RiskInput['summary']> = {}): RiskInput['summary'] => ({
  distanceMeters: 10 * MILE,
  movingSec: 1200,
  maxSpeedKph: mphToKph(45),
  histogramMph: [0, 0, 0, 0, 0],
  harshEvents: [],
  ...over,
});

const event = (kind: HarshEvent['kind'], severity: HarshEvent['severity'] = 'moderate'): HarshEvent => ({
  startMs: 0, endMs: 1000, durationSec: 1, kind, severity,
  peakDeltaKph: kind === 'braking' ? -14 : 14, peakG: kind === 'braking' ? -0.4 : 0.4,
  peakAtMs: 0, speedKph: 50, distanceMeters: 10,
});

const stretch = (over: Partial<OverLimitStretch> = {}): OverLimitStretch => ({
  startMs: 0, endMs: 60_000, durationSec: 60, limitKph: mphToKph(30), limitSource: 'tagged',
  peakSpeedKph: mphToKph(42), peakExcessKph: mphToKph(12), distanceMeters: 800,
  severity: 'moderate', roadName: 'Main St', ...over,
});

const adherence = (stretches: OverLimitStretch[], within = 0.95, known = true): TripAdherence => ({
  stretches,
  excessKph: [], limitKph: [], limitSource: [],
  coverage: { movingSec: 1200, taggedSec: 1200, implicitSec: 0, inferredSec: 0, unknownSec: 0, unmatchedSec: 0 },
  score: known ? within : null,
  scoreWithInferred: within,
  overLimitSec: 0, overLimitMeters: 0, peakExcessKph: 0, region: 'US',
});

describe('assessRisk', () => {
  test('too short to judge', () => {
    assert.equal(assessRisk({ summary: summary({ distanceMeters: 200 }) }), null);
  });

  test('a clean drive is 100 with no factors', () => {
    const risk = assessRisk({ summary: summary(), adherence: adherence([], 1) })!;
    assert.equal(risk.score, 100);
    assert.equal(risk.band, 'low');
    assert.deepEqual(risk.factors, []);
    assert.equal(risk.includesSpeeding, true);
  });

  test('says when speed limits were not part of it', () => {
    assert.equal(assessRisk({ summary: summary() })!.includesSpeeding, false);
  });

  test('speeding costs points and explains itself', () => {
    const risk = assessRisk({
      summary: summary(),
      adherence: adherence([stretch(), stretch({ durationSec: 90 })], 0.8),
    })!;
    const factor = risk.factors.find((f) => f.key === 'speeding')!;
    assert.equal(factor.label, '2:30 over the limit');
    assert.match(factor.detail!, /2 stretches · longest 1:30 · peak 12 over on Main St/);
    assert.ok(risk.score < 85);
  });

  test('one severe stretch over a signed limit caps the score as high risk', () => {
    const risk = assessRisk({
      summary: summary(),
      adherence: adherence([stretch({ severity: 'severe', peakExcessKph: mphToKph(22) })], 0.98),
    })!;
    assert.ok(risk.score <= 64);
    assert.equal(risk.band, 'high');
    assert.equal(risk.cappedBy, '20+ mph over a signed limit');
  });

  test('a short track does not turn a few seconds over into a third of the drive', () => {
    const short = assessRisk({ summary: summary({ movingSec: 140 }), adherence: adherence([stretch()], 0.66) })!;
    const long = assessRisk({ summary: summary({ movingSec: 1200 }), adherence: adherence([stretch()], 0.66) })!;
    assert.ok(short.score > long.score);
    assert.ok(short.score >= 75, `got ${short.score}`);
  });

  test('assumed limits count for less than signed ones', () => {
    const signed = assessRisk({ summary: summary(), adherence: adherence([stretch()], 0.85) })!;
    const assumed = assessRisk({
      summary: summary(),
      adherence: adherence([stretch({ limitSource: 'inferred' })], 0.85, false),
    })!;
    assert.ok(assumed.score > signed.score);
    assert.match(assumed.factors[0]!.detail!, /some limits assumed/);
  });

  test('each event kind is its own factor, severe costing more', () => {
    const risk = assessRisk({
      summary: summary({ harshEvents: [event('braking'), event('braking', 'severe'), event('cornering')] }),
    })!;
    const braking = risk.factors.find((f) => f.key === 'braking')!;
    assert.equal(braking.label, '2 hard stops');
    assert.equal(risk.factors.find((f) => f.key === 'cornering')!.label, '1 sharp turn');
    assert.ok(risk.factors[0]!.points >= risk.factors[1]!.points, 'worst first');
    assert.ok(risk.score <= 84, 'a severe event caps below low risk');
  });

  test('a short errand is not punished as if it were a fraction of a longer drive', () => {
    const errand = assessRisk({ summary: summary({ distanceMeters: 1 * MILE, harshEvents: [event('braking')] }) })!;
    const commute = assessRisk({ summary: summary({ distanceMeters: 5 * MILE, harshEvents: [event('braking')] }) })!;
    assert.equal(errand.score, commute.score);
    const trip = assessRisk({ summary: summary({ distanceMeters: 50 * MILE, harshEvents: [event('braking')] }) })!;
    assert.ok(trip.score > commute.score);
  });

  test('no single behaviour can sink the score alone', () => {
    const many = Array.from({ length: 40 }, () => event('acceleration'));
    const risk = assessRisk({ summary: summary({ harshEvents: many }) })!;
    assert.equal(risk.score, 75);
  });

  test('very high speed is called out whatever the limit', () => {
    const risk = assessRisk({
      summary: summary({ maxSpeedKph: mphToKph(92), histogramMph: [0, 0, 0, 0, 120] }),
    })!;
    assert.equal(risk.factors[0]!.label, 'Reached 92 mph');
    assert.ok(risk.score <= 60);
  });
});

describe('speedingStats', () => {
  test('null without a lookup', () => assert.equal(speedingStats(undefined), null));

  test('totals stretches and finds the worst', () => {
    const stats = speedingStats(adherence([
      stretch({ durationSec: 30, severity: 'minor', peakExcessKph: mphToKph(7) }),
      stretch({ durationSec: 75, severity: 'severe', peakExcessKph: mphToKph(24), roadName: 'Route 9' }),
    ], 0.9))!;
    assert.equal(stats.stretchSec, 105);
    assert.equal(stats.longestSec, 75);
    assert.equal(stats.peakRoad, 'Route 9');
    assert.deepEqual(stats.bySeverity, { minor: 1, moderate: 0, severe: 1 });
    assert.ok(Math.abs(stats.overShare! - 0.1) < 1e-9);
  });
});

test('formatDuration', () => {
  assert.equal(formatDuration(42), '42s');
  assert.equal(formatDuration(150), '2:30');
  assert.equal(formatDuration(1260), '21 min');
});
