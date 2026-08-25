import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeDriveScore } from '../src/driveScore.ts';
import type { HarshEvent } from '../src/harshEvents.ts';

const MILE = 1609.344;

const event = (severity: HarshEvent['severity']): HarshEvent => ({
  startMs: 0, endMs: 1000, durationSec: 1,
  kind: 'braking', severity,
  peakDeltaKph: -20, peakAtMs: 0, distanceMeters: 10,
});

describe('computeDriveScore', () => {
  test('returns null for a trip too short to judge', () => {
    assert.equal(computeDriveScore({ harshEvents: [], distanceMeters: 100 }), null);
  });

  test('a clean drive scores perfectly', () => {
    const score = computeDriveScore({ harshEvents: [], distanceMeters: 10 * MILE });
    assert.equal(score?.value, 100);
    assert.equal(score?.band, 'good');
    assert.equal(score?.includesAdherence, false);
  });

  test('harsh events lower the score, severe more than moderate', () => {
    const moderate = computeDriveScore({
      harshEvents: [event('moderate')], distanceMeters: 10 * MILE,
    })!;
    const severe = computeDriveScore({
      harshEvents: [event('severe')], distanceMeters: 10 * MILE,
    })!;
    assert.ok(moderate.value < 100);
    assert.ok(severe.value < moderate.value);
  });

  test('the same event count matters less over a longer drive', () => {
    const short = computeDriveScore({
      harshEvents: [event('severe')], distanceMeters: 5 * MILE,
    })!;
    const long = computeDriveScore({
      harshEvents: [event('severe')], distanceMeters: 100 * MILE,
    })!;
    assert.ok(long.value > short.value);
  });

  test('behaviour alone never drops the score to zero', () => {
    const many = Array.from({ length: 50 }, () => event('severe'));
    const score = computeDriveScore({ harshEvents: many, distanceMeters: 5 * MILE })!;
    assert.ok(score.value >= 20);
    assert.equal(score.band, 'poor');
  });

  test('adherence blends in when supplied, and is flagged as included', () => {
    const withoutAdherence = computeDriveScore({
      harshEvents: [event('moderate')], distanceMeters: 10 * MILE,
    })!;
    const poorAdherence = computeDriveScore({
      harshEvents: [event('moderate')], distanceMeters: 10 * MILE, adherenceScore: 0.2,
    })!;
    const goodAdherence = computeDriveScore({
      harshEvents: [event('moderate')], distanceMeters: 10 * MILE, adherenceScore: 1,
    })!;
    assert.equal(poorAdherence.includesAdherence, true);
    assert.ok(poorAdherence.value < withoutAdherence.value);
    assert.ok(goodAdherence.value > poorAdherence.value);
  });
});
