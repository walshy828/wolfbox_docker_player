import type { LatLon } from '@wolfbox/telemetry';

/**
 * Which map tiles a route needs road data for.
 *
 * Road data is fetched by tile rather than by trip so that a commute driven
 * every day reuses one cached answer instead of asking again for the same
 * streets under a slightly different bounding box each time.
 */

/**
 * Must match the zoom the service serves. Zoom 13 is about 5 km across at mid
 * latitudes: coarse enough that a request says little about where the car
 * actually went, fine enough that a short trip pulls only one or two.
 */
export const TILE_ZOOM = 13;
/** The service refuses more than this, so a long trip is capped before asking. */
export const MAX_TILES = 40;

export interface Tile { z: number; x: number; y: number }

export const tileKey = ({ z, x, y }: Tile) => `${z}/${x}/${y}`;

/** The tile a coordinate falls in, in the usual slippy-map scheme. */
export function tileAt({ latitude, longitude }: LatLon, z = TILE_ZOOM): Tile {
  const n = 2 ** z;
  const x = Math.floor(((longitude + 180) / 360) * n);
  const lat = (latitude * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n);
  return {
    z,
    x: Math.min(Math.max(x, 0), n - 1),
    y: Math.min(Math.max(y, 0), n - 1),
  };
}

/**
 * Every tile a route needs, including the neighbours of tiles it only grazes.
 *
 * A road just over a tile edge is still within matching range of a car on this
 * side of it, and a route running along a boundary would otherwise be matched
 * against only half its surroundings. Pulling the neighbour in costs one more
 * cached tile and removes a whole class of wrong match.
 */
export function tilesForRoute(points: readonly LatLon[], z = TILE_ZOOM): Tile[] {
  const found = new Map<string, Tile>();
  const n = 2 ** z;
  /** About 250 m at zoom 13 -- comfortably past the 30 m matching radius. */
  const EDGE = 0.05;

  for (const point of points) {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) continue;
    const tile = tileAt(point, z);

    // Where the point sits inside its own tile decides which neighbours matter.
    const fx = ((point.longitude + 180) / 360) * n - tile.x;
    const lat = (point.latitude * Math.PI) / 180;
    const fy = ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n - tile.y;

    const xs = [tile.x, ...(fx < EDGE ? [tile.x - 1] : fx > 1 - EDGE ? [tile.x + 1] : [])];
    const ys = [tile.y, ...(fy < EDGE ? [tile.y - 1] : fy > 1 - EDGE ? [tile.y + 1] : [])];

    for (const x of xs) {
      for (const y of ys) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const neighbour = { z, x, y };
        found.set(tileKey(neighbour), neighbour);
      }
    }
  }

  // A trip long enough to exceed the cap is rare, but the tiles the car spent
  // most of its time in are the ones worth keeping, so take them in the order
  // they were driven rather than truncating arbitrarily.
  return [...found.values()].slice(0, MAX_TILES);
}
