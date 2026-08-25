import { useEffect, useState } from 'react';
import {
  matchRoads, assessAdherence, inferRegion, kphToMph, severityFor,
  type CleanPoint, type LimitSource, type RoadWay, type Severity, type TripAdherence,
} from '@wolfbox/telemetry';
import { tilesForRoute, tileKey, MAX_TILES, type Tile } from './tiles.ts';
import type { TripTrack } from './track.ts';

/**
 * Fetches the road data a trip needs and scores the drive against it.
 *
 * Kept apart from `loadTripTrack` on purpose. Reading the card is local and
 * always works; this reaches a third-party service over the network and often
 * will not. Folding the two together would mean a failed lookup, or simply
 * being offline, delayed or blocked the route and the summary -- which are the
 * things the app is actually for.
 */

const ENDPOINT = '/api/speedlimits';

interface TileResponse {
  z: number; x: number; y: number;
  status: 'ok' | 'stale' | 'offline' | 'miss';
  ways: { id: number; tags: Record<string, string>; geometry: [number, number][] }[];
}

/** Tiles already fetched this session. The service caches too; this saves the trip. */
const cached = new Map<string, RoadWay[]>();
/** Two trips over the same ground must not become two identical requests. */
const inFlight = new Map<string, Promise<RoadWay[]>>();

export type LimitStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface TripLimits {
  adherence: TripAdherence;
  /** Excess over the limit in mph per sample, for the map's compliance view. */
  excessMph: (number | undefined)[];
  /** How many of the tiles the route needed actually came back. */
  tilesResolved: number;
  tilesWanted: number;
}

async function fetchTiles(tiles: Tile[], signal?: AbortSignal): Promise<RoadWay[]> {
  const wanted = tiles.filter((tile) => !cached.has(tileKey(tile)));

  if (wanted.length > 0) {
    const key = wanted.map(tileKey).join(',');
    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(`${ENDPOINT}?tiles=${encodeURIComponent(key)}`, { signal });
        if (!response.ok) throw new Error(`Speed limit lookup failed: ${response.status}`);
        const payload = await response.json() as { tiles: TileResponse[] };
        const collected: RoadWay[] = [];
        for (const tile of payload.tiles) {
          // An offline tile is not cached: the next attempt should try again
          // rather than remembering a hole for the rest of the session.
          if (tile.status === 'offline') continue;
          const ways = tile.ways.map((way) => ({
            id: way.id,
            tags: way.tags,
            geometry: way.geometry.map(([latitude, longitude]) => ({ latitude, longitude })),
          }));
          cached.set(tileKey(tile), ways);
          collected.push(...ways);
        }
        return collected;
      })();
      inFlight.set(key, pending);
      pending.catch(() => undefined).finally(() => inFlight.delete(key));
    }
    await pending;
  }

  // Rebuild from the cache rather than from the response, so tiles fetched by
  // an earlier trip are included and a way shared across two tiles appears once.
  const seen = new Set<number>();
  const ways: RoadWay[] = [];
  for (const tile of tiles) {
    for (const way of cached.get(tileKey(tile)) ?? []) {
      if (seen.has(way.id)) continue;
      seen.add(way.id);
      ways.push(way);
    }
  }
  return ways;
}

/**
 * Fetches the road data for a route without scoring it.
 *
 * Exposed for callers that need the raw ways for their own matching pass --
 * currently the trip list's lazy per-row adherence lookup -- while still
 * going through the same tile cache as `useTripLimits`, so a trip already
 * scored once (in the list or the open drive) never re-fetches its tiles.
 */
export async function loadRoadWays(points: { latitude: number; longitude: number }[], signal?: AbortSignal) {
  return fetchTiles(tilesForRoute(points), signal);
}

/**
 * Scores one trip against the speed limits of the roads it was driven on.
 *
 * `enabled` gates the network call so the lookup only happens when the panel
 * showing it is actually open. That keeps a user browsing thirty trips from
 * sending thirty queries to a service run on donated hardware, and it means
 * route data leaves the machine only when the feature is being used.
 */
export function useTripLimits(track: TripTrack | null, enabled: boolean): {
  status: LimitStatus;
  limits?: TripLimits;
} {
  const [state, setState] = useState<{ status: LimitStatus; limits?: TripLimits }>(
    { status: 'idle' });

  useEffect(() => {
    if (!track || !enabled || track.points.length === 0) { setState({ status: 'idle' }); return; }

    const controller = new AbortController();
    setState({ status: 'loading' });

    void (async () => {
      try {
        const tiles = tilesForRoute(track.points);
        const ways = await fetchTiles(tiles, controller.signal);
        if (controller.signal.aborted) return;

        if (ways.length === 0) { setState({ status: 'unavailable' }); return; }

        const region = inferRegion(ways.map((way) => way.tags), track.points[0]);
        const matches = matchRoads(track.points, ways);
        const adherence = assessAdherence(track.points, matches, ways, region);

        setState({
          status: 'ready',
          limits: {
            adherence,
            excessMph: adherence.excessKph.map((kph) => kph === undefined ? undefined : kphToMph(kph)),
            tilesResolved: tiles.filter((tile) => cached.has(tileKey(tile))).length,
            tilesWanted: Math.min(tiles.length, MAX_TILES),
          },
        });
      } catch {
        if (!controller.signal.aborted) setState({ status: 'unavailable' });
      }
    })();

    return () => controller.abort();
  }, [track, enabled]);

  return state;
}

export interface CurrentLimit {
  /** The limit in mph. Infinity on a road with no limit at all. */
  limitMph: number;
  source: LimitSource;
  /** Vehicle speed less the limit, undefined on an unlimited road. */
  excessMph?: number;
  /** Only 'moderate' or 'severe' -- a minor excess is not worth calling out in the readout. */
  severity?: Exclude<Severity, 'minor'>;
}

/**
 * The limit that applies at a given instant, read off the sample nearest it.
 *
 * `adherence`'s arrays are aligned one-to-one with `points`, not interpolated
 * like the vehicle marker -- a speed limit does not ease between two values
 * the way a position does, so the nearest sample's road is the right answer
 * rather than a blend of two.
 */
export function currentLimit(
  points: CleanPoint[],
  adherence: TripAdherence | undefined,
  timestampMs: number | null,
): CurrentLimit | undefined {
  if (!adherence || timestampMs === null || points.length === 0) return undefined;

  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid]!.timestampMs < timestampMs) low = mid + 1;
    else high = mid;
  }
  const after = points[low];
  const before = points[low - 1];
  const index = before && (!after
    || Math.abs(before.timestampMs - timestampMs) <= Math.abs(after.timestampMs - timestampMs))
    ? low - 1 : low;

  const limitKph = adherence.limitKph[index];
  const source = adherence.limitSource[index];
  if (limitKph === undefined || !source) return undefined;

  const excessKph = adherence.excessKph[index];
  const excessMph = excessKph !== undefined && Number.isFinite(excessKph) ? kphToMph(excessKph) : undefined;

  const severity = excessKph !== undefined && excessKph > 0 ? severityFor(excessKph) : undefined;

  return {
    limitMph: Number.isFinite(limitKph) ? kphToMph(limitKph) : Infinity,
    source,
    excessMph,
    severity: severity === 'minor' ? undefined : severity,
  };
}
