import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tileAt, tilesForRoute, tileKey, TILE_ZOOM, MAX_TILES } from '../src/tiles.ts';

/** The reference card's own patch of Massachusetts. */
const HOME = { latitude: 42.2969, longitude: -71.4938 };

describe('tileAt', () => {
  test('places a known coordinate on the tile the service serves', () => {
    assert.deepEqual(tileAt(HOME), { z: TILE_ZOOM, x: 2469, y: 3031 });
  });

  test('moving east increases x, moving north decreases y', () => {
    const east = tileAt({ latitude: HOME.latitude, longitude: HOME.longitude + 0.1 });
    const north = tileAt({ latitude: HOME.latitude + 0.1, longitude: HOME.longitude });
    assert.ok(east.x > tileAt(HOME).x);
    assert.ok(north.y < tileAt(HOME).y);
  });

  test('the antimeridian and the poles stay inside the grid', () => {
    for (const point of [
      { latitude: 85, longitude: 180 }, { latitude: -85, longitude: -180 },
    ]) {
      const tile = tileAt(point);
      assert.ok(tile.x >= 0 && tile.x < 2 ** TILE_ZOOM, `x ${tile.x}`);
      assert.ok(tile.y >= 0 && tile.y < 2 ** TILE_ZOOM, `y ${tile.y}`);
    }
  });
});

describe('tilesForRoute', () => {
  test('a route within one tile asks for one tile', () => {
    const route = Array.from({ length: 20 }, (_, i) => ({
      latitude: HOME.latitude + i * 0.0001, longitude: HOME.longitude,
    }));
    assert.deepEqual(tilesForRoute(route).map(tileKey), ['13/2469/3031']);
  });

  test('a route crossing a boundary asks for both sides', () => {
    const route = [HOME, { latitude: HOME.latitude, longitude: HOME.longitude + 0.06 }];
    const keys = tilesForRoute(route).map(tileKey);
    assert.ok(keys.length >= 2, `expected both tiles, got ${keys}`);
    assert.ok(keys.includes('13/2469/3031'));
  });

  test('a route hugging a tile edge also pulls in the neighbour it could match into', () => {
    // Sit just inside the western edge of a tile; roads a few metres west are
    // still within matching range and live in the tile next door.
    const { x } = tileAt(HOME);
    const westEdgeLon = (x / 2 ** TILE_ZOOM) * 360 - 180 + 0.0005;
    const keys = tilesForRoute([{ latitude: HOME.latitude, longitude: westEdgeLon }]).map(tileKey);
    assert.ok(keys.length > 1, `expected a neighbour alongside, got ${keys}`);
  });

  test('a very long trip is capped rather than asking without limit', () => {
    const route = Array.from({ length: 4000 }, (_, i) => ({
      latitude: 42 + i * 0.01, longitude: -71 + i * 0.01,
    }));
    assert.ok(tilesForRoute(route).length <= MAX_TILES);
  });

  test('samples with no usable position are skipped, not turned into a tile', () => {
    const keys = tilesForRoute([
      HOME, { latitude: NaN, longitude: NaN }, { latitude: Infinity, longitude: 0 },
    ]).map(tileKey);
    assert.deepEqual(keys, ['13/2469/3031']);
  });

  test('an empty route asks for nothing', () => {
    assert.deepEqual(tilesForRoute([]), []);
  });
});
