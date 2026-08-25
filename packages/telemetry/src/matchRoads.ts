import type { CleanPoint } from './clean.ts';
import type { RoadWay, RoadMatch } from './roads.ts';
import { angleDelta, bearingDeg, pointToSegmentMeters, type LatLon } from './geo.ts';
import { STOPPED_KPH } from './summary.ts';

/**
 * Decides which road each GPS sample was driven on.
 *
 * The naive answer -- nearest centreline -- fails in exactly the places that
 * matter. A motorway's two carriageways are twenty metres apart and a fix can
 * land on the wrong one; an arterial and its frontage road run parallel with
 * limits thirty miles an hour apart. So distance alone is not enough, and two
 * further signals are used: the direction the car was travelling, which tells
 * the carriageways apart outright, and which road it was on a second ago,
 * which stops the match flickering between neighbours.
 *
 * The honest limitation, which no amount of tuning removes: a frontage road
 * carrying traffic the same way as the arterial beside it is separated only by
 * distance, against a GPS error of the same size. Showing the matched road's
 * name in the UI is what lets a reader notice when this went wrong.
 */

/** Beyond this no road may claim a sample; it is reported as unmatched. */
export const MAX_MATCH_METERS = 30;
/** The road already being driven keeps its claim out to here. */
export const STICKY_MATCH_METERS = 45;
/** A right-angle heading disagreement costs this much, priced in metres. */
export const HEADING_WEIGHT_M = 40;
/** Staying on the current road is worth this much against a rival's distance. */
export const CONTINUITY_BONUS_M = 15;
/** A stretch shorter than this between two agreeing neighbours is flicker. */
export const MIN_RUN_SAMPLES = 4;

export interface MatchOptions {
  maxMatchMeters?: number;
  stickyMatchMeters?: number;
  headingWeightM?: number;
  continuityBonusM?: number;
  minRunSamples?: number;
}

interface Segment {
  wayId: number;
  a: LatLon;
  b: LatLon;
  bearing: number;
  oneway: boolean;
}

/**
 * Matches every sample to a road, in order.
 *
 * The result is aligned one-to-one with `points`, so callers can walk the two
 * together without re-deriving timestamps.
 */
export function matchRoads(
  points: CleanPoint[],
  ways: RoadWay[],
  options: MatchOptions = {},
): RoadMatch[] {
  const {
    maxMatchMeters = MAX_MATCH_METERS,
    stickyMatchMeters = STICKY_MATCH_METERS,
    headingWeightM = HEADING_WEIGHT_M,
    continuityBonusM = CONTINUITY_BONUS_M,
    minRunSamples = MIN_RUN_SAMPLES,
  } = options;

  const index = buildIndex(ways);
  const matches: RoadMatch[] = [];
  let previousWayId: number | undefined;

  for (const point of points) {
    // At rest the heading field is meaningless -- a stationary receiver
    // reports whatever it last saw -- so hold the road rather than re-deciding
    // on noise. A car does not change road while parked.
    const stopped = point.smoothedSpeedKph <= STOPPED_KPH;

    let best: { segment: Segment; meters: number; score: number } | undefined;
    for (const segment of index.near(point)) {
      const { meters } = pointToSegmentMeters(point, segment.a, segment.b);
      const reach = segment.wayId === previousWayId ? stickyMatchMeters : maxMatchMeters;
      if (meters > reach) continue;

      let score = meters;
      if (!stopped) {
        // A two-way road may be drawn in either direction, so its own node
        // order says nothing; fold the disagreement into a right angle. A
        // one-way road does mean what it says, and driving against it is
        // strong evidence this is the wrong carriageway.
        const raw = angleDelta(point.headingDeg, segment.bearing);
        const off = segment.oneway ? raw : Math.min(raw, 180 - raw);
        score += headingWeightM * (off / 90);
      }
      if (segment.wayId === previousWayId) score -= continuityBonusM;

      if (!best || score < best.score) best = { segment, meters, score };
    }

    if (!best) {
      matches.push({ timestampMs: point.timestampMs });
      previousWayId = undefined;
      continue;
    }

    matches.push({
      timestampMs: point.timestampMs,
      wayId: best.segment.wayId,
      offsetMeters: best.meters,
      forward: angleDelta(point.headingDeg, best.segment.bearing) <= 90,
    });
    previousWayId = best.segment.wayId;
  }

  return repairShortRuns(matches, minRunSamples);
}

/**
 * Rewrites brief excursions onto a neighbouring road.
 *
 * Crossing an intersection puts a sample or two within range of the road being
 * crossed, and at speed that is enough to manufacture a limit change and back
 * again. A run shorter than four samples, with the same road either side of
 * it, is that artefact rather than a real turn: four seconds at sixty is over
 * a hundred metres, far longer than any junction.
 */
function repairShortRuns(matches: RoadMatch[], minRunSamples: number): RoadMatch[] {
  const runs: { wayId: number | undefined; from: number; to: number }[] = [];
  for (const [i, match] of matches.entries()) {
    const last = runs.at(-1);
    if (last && last.wayId === match.wayId) last.to = i;
    else runs.push({ wayId: match.wayId, from: i, to: i });
  }

  for (const [r, run] of runs.entries()) {
    const before = runs[r - 1];
    const after = runs[r + 1];
    const length = run.to - run.from + 1;
    if (length > minRunSamples) continue;
    if (!before || !after || before.wayId !== after.wayId) continue;
    if (before.wayId === undefined) continue;

    for (let i = run.from; i <= run.to; i++) {
      matches[i] = { ...matches[i]!, wayId: before.wayId };
    }
    run.wayId = before.wayId;
  }

  return matches;
}

/** Cell size for the lookup grid: ~0.002 degrees of latitude, about 220 m. */
const CELL_DEG = 0.002;

/**
 * A grid over the road segments, so each sample only tests its own neighbourhood.
 *
 * A trip is a couple of thousand samples and a tile's worth of road is tens of
 * thousands of segments; testing every pair is tens of millions of distance
 * calculations per trip, which is enough to lock the tab.
 */
function buildIndex(ways: RoadWay[]) {
  const cells = new Map<string, Segment[]>();
  const key = (lat: number, lon: number) =>
    `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;

  for (const way of ways) {
    const oneway = way.tags['oneway'] === 'yes' || way.tags['oneway'] === '1';
    for (let i = 1; i < way.geometry.length; i++) {
      const a = way.geometry[i - 1]!;
      const b = way.geometry[i]!;
      const segment: Segment = { wayId: way.id, a, b, bearing: bearingDeg(a, b), oneway };

      // A segment can span several cells, so file it under every cell its own
      // extent touches; a segment filed only by its midpoint would be invisible
      // to a sample sitting beside one of its ends.
      const latFrom = Math.floor(Math.min(a.latitude, b.latitude) / CELL_DEG);
      const latTo = Math.floor(Math.max(a.latitude, b.latitude) / CELL_DEG);
      const lonFrom = Math.floor(Math.min(a.longitude, b.longitude) / CELL_DEG);
      const lonTo = Math.floor(Math.max(a.longitude, b.longitude) / CELL_DEG);
      for (let y = latFrom; y <= latTo; y++) {
        for (let x = lonFrom; x <= lonTo; x++) {
          const cell = `${y}:${x}`;
          let bucket = cells.get(cell);
          if (!bucket) cells.set(cell, (bucket = []));
          bucket.push(segment);
        }
      }
    }
  }

  return {
    /** Every segment in the sample's cell and the eight around it. */
    near(point: LatLon): Segment[] {
      const found: Segment[] = [];
      const seen = new Set<Segment>();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = cells.get(
            key(point.latitude + dy * CELL_DEG, point.longitude + dx * CELL_DEG));
          if (!bucket) continue;
          for (const segment of bucket) {
            if (seen.has(segment)) continue;
            seen.add(segment);
            found.push(segment);
          }
        }
      }
      return found;
    },
  };
}
