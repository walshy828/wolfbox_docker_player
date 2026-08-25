import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters, bearingDeg, angleDelta, pointToSegmentMeters, kphToMph, mphToKph,
} from '../src/geo.ts';

/** A short east-west segment at the reference card's latitude. */
const A = { latitude: 42.30, longitude: -71.50 };
const B = { latitude: 42.30, longitude: -71.49 };

describe('angleDelta', () => {
  test('opposite bearings are 180 apart', () => {
    assert.equal(angleDelta(0, 180), 180);
    assert.equal(angleDelta(90, 270), 180);
  });

  test('the wrap at north is measured the short way', () => {
    assert.equal(angleDelta(350, 10), 20);
    assert.equal(angleDelta(10, 350), 20);
  });

  test('a bearing is zero from itself', () => {
    assert.equal(angleDelta(137, 137), 0);
  });
});

describe('pointToSegmentMeters', () => {
  test('a point on the line is on the line', () => {
    const midpoint = { latitude: 42.30, longitude: -71.495 };
    const hit = pointToSegmentMeters(midpoint, A, B);
    assert.ok(hit.meters < 0.5, `${hit.meters}m`);
    assert.ok(Math.abs(hit.t - 0.5) < 0.01, `t was ${hit.t}`);
  });

  test('the foot of the perpendicular is nearer than either end', () => {
    // Offset north of the midpoint: perpendicular distance, not a corner cut.
    const off = { latitude: 42.3005, longitude: -71.495 };
    const hit = pointToSegmentMeters(off, A, B);
    assert.ok(hit.meters < haversineMeters(off, A));
    assert.ok(hit.meters < haversineMeters(off, B));
    assert.ok(Math.abs(hit.meters - 55.6) < 2, `expected ~55m, got ${hit.meters}`);
  });

  test('a point past the end clamps to the end rather than the infinite line', () => {
    const beyond = { latitude: 42.30, longitude: -71.48 };
    const hit = pointToSegmentMeters(beyond, A, B);
    assert.equal(hit.t, 1);
    assert.ok(Math.abs(hit.meters - haversineMeters(beyond, B)) < 1);
  });

  test('a segment whose nodes coincide does not divide by zero', () => {
    const hit = pointToSegmentMeters(B, A, A);
    assert.ok(Number.isFinite(hit.meters) && hit.meters > 0);
  });
});

describe('speed units', () => {
  test('mph and kph round-trip', () => {
    assert.ok(Math.abs(kphToMph(mphToKph(65)) - 65) < 1e-9);
  });

  test('a motorway limit is the figure drivers know', () => {
    assert.ok(Math.abs(mphToKph(70) - 112.65) < 0.01);
  });
});

describe('bearingDeg', () => {
  test('due east is ninety degrees', () => {
    assert.ok(Math.abs(bearingDeg(A, B) - 90) < 0.1);
  });
});
