import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gVectorToPoint, TOP_G } from '../src/accelScale.ts';

describe('gVectorToPoint', () => {
  test('zero g maps to the centre', () => {
    const point = gVectorToPoint(0, 0, 40);
    assert.equal(point.x, 0);
    assert.equal(point.y, 0);
    assert.equal(point.magnitude, 0);
  });

  test('pure lateral g maps to the horizontal axis', () => {
    const point = gVectorToPoint(0, TOP_G / 2, 40);
    assert.equal(point.y, 0);
    assert.ok(point.x > 0);
  });

  test('pure longitudinal g maps to the vertical axis', () => {
    const point = gVectorToPoint(TOP_G / 2, 0, 40);
    assert.equal(point.x, 0);
    assert.ok(point.y > 0);
  });

  test('a reading at TOP_G lands exactly on the ring', () => {
    const point = gVectorToPoint(TOP_G, 0, 40);
    assert.ok(Math.abs(Math.hypot(point.x, point.y) - 40) < 1e-9);
  });

  test('a reading beyond TOP_G is clamped to the ring, preserving direction', () => {
    const inRing = gVectorToPoint(0.3, 0.4, 40); // magnitude 0.5, i.e. beyond TOP_G (0.8 default but check ratio)
    const scaled = gVectorToPoint(0.6, 0.8, 40); // same direction, magnitude 1.0
    const angle = (p: { x: number; y: number }) => Math.atan2(p.x, p.y);
    assert.ok(Math.abs(angle(inRing) - angle(scaled)) < 1e-9);
    assert.ok(Math.abs(Math.hypot(scaled.x, scaled.y) - 40) < 1e-9);
    assert.equal(scaled.magnitude, 1.0);
  });
});
