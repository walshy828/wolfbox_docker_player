import type { CleanPoint } from './clean.ts';
import type { RoadMatch, RoadWay } from './roads.ts';
import { haversineMeters, kphToMph, mphToKph } from './geo.ts';
import { limitForWay, type LimitSource, type RegionCode, type SpeedLimit } from './maxspeed.ts';
import { STOPPED_KPH } from './summary.ts';

/**
 * Scores a drive against the speed limits of the roads it was driven on.
 *
 * The design problem is not detecting a number going above another number. It
 * is deciding what a driver would accept as a fair reading of their own drive.
 * Every real speedometer over-reads, GPS carries a couple of km/h of noise,
 * and drifting a few miles an hour over on a downhill is not what anyone means
 * by speeding. So a moment over the limit is not an event: only a sustained
 * excess above a tolerance is, and everything below that is reported as time,
 * not as an accusation.
 */

/**
 * How far over is not worth remarking on.
 *
 * Five miles an hour is wide enough to swallow speedometer error, GPS noise
 * and ordinary variation, and narrow enough that a real 15-over stretch still
 * clears it comfortably.
 */
export const TOLERANCE_MPH = 5;
/** How long over the tolerance before it counts as a stretch rather than a drift. */
export const SUSTAIN_SEC = 10;
/** How long back at the limit before an open stretch is considered over. */
export const RELEASE_SEC = 5;
/** Below this share of known limits, no overall score is honest enough to show. */
export const MIN_COVERAGE_FOR_SCORE = 0.5;
/** A sample stands for at most this much time, so a recording gap is not driving. */
const MAX_INTERVAL_SEC = 5;

export type Severity = 'minor' | 'moderate' | 'severe';

export interface OverLimitStretch {
  startMs: number;
  endMs: number;
  durationSec: number;
  limitKph: number;
  limitSource: LimitSource;
  peakSpeedKph: number;
  /** Peak speed less the limit. The figure the severity is keyed to. */
  peakExcessKph: number;
  distanceMeters: number;
  severity: Severity;
  roadName?: string;
  wayId?: number;
}

export interface Coverage {
  /** Moving seconds in total -- the denominator everything else is a share of. */
  movingSec: number;
  /** Moving seconds whose limit was signed on the road. */
  taggedSec: number;
  /** Moving seconds whose limit came from a country's stated default. */
  implicitSec: number;
  /** Moving seconds whose limit was guessed from the road's class. */
  inferredSec: number;
  /** Moving seconds on a known road carrying no limit anyone could resolve. */
  unknownSec: number;
  /** Moving seconds where no road could be matched at all. */
  unmatchedSec: number;
}

export interface TripAdherence {
  stretches: OverLimitStretch[];
  /**
   * Speed over the limit at each sample, aligned one-to-one with the points
   * passed in. Undefined where no limit could be established, which the map
   * must draw as unknown rather than as compliant.
   */
  excessKph: (number | undefined)[];
  /** The limit itself at each sample, aligned with `excessKph`. Infinity on an unlimited road. */
  limitKph: (number | undefined)[];
  /** Where each sample's limit came from, aligned with `excessKph`. */
  limitSource: (LimitSource | undefined)[];
  coverage: Coverage;
  /**
   * Share of judged moving time spent at or under limit plus tolerance, over
   * limits that were actually known. Null when too little of the route had a
   * known limit for the figure to mean anything.
   */
  score: number | null;
  /** The same figure with guessed limits folded in, always a secondary number. */
  scoreWithInferred: number | null;
  overLimitSec: number;
  overLimitMeters: number;
  peakExcessKph: number;
  peakExcessAtMs?: number;
  region: RegionCode;
}

interface Judged {
  point: CleanPoint;
  seconds: number;
  meters: number;
  limit?: SpeedLimit;
  wayId?: number;
  roadName?: string;
  excessKph?: number;
}

/**
 * Walks a matched trip and produces its adherence report.
 *
 * Guessed limits are kept out of the headline score entirely rather than
 * merely flagged. A route through untagged residential streets is mostly
 * guesswork, and a score built on guesswork reads exactly like a score built
 * on signs -- so the two are reported separately and the caller decides which
 * to lead with.
 */
export function assessAdherence(
  points: CleanPoint[],
  matches: RoadMatch[],
  ways: RoadWay[],
  region: RegionCode,
): TripAdherence {
  const byId = new Map(ways.map((way) => [way.id, way]));
  const judged = judge(points, matches, byId, region);

  const coverage: Coverage = {
    movingSec: 0, taggedSec: 0, implicitSec: 0,
    inferredSec: 0, unknownSec: 0, unmatchedSec: 0,
  };
  let overLimitSec = 0;
  let overLimitMeters = 0;
  let peakExcessKph = 0;
  let peakExcessAtMs: number | undefined;
  let knownSec = 0, knownWithinSec = 0;
  let anySec = 0, anyWithinSec = 0;

  const tolerance = mphToKph(TOLERANCE_MPH);

  for (const entry of judged) {
    if (entry.point.smoothedSpeedKph <= STOPPED_KPH) continue;
    coverage.movingSec += entry.seconds;

    if (entry.wayId === undefined) { coverage.unmatchedSec += entry.seconds; continue; }
    if (!entry.limit) { coverage.unknownSec += entry.seconds; continue; }

    if (entry.limit.source === 'tagged') coverage.taggedSec += entry.seconds;
    else if (entry.limit.source === 'implicit') coverage.implicitSec += entry.seconds;
    else coverage.inferredSec += entry.seconds;

    const excess = entry.excessKph ?? 0;
    if (excess > 0) {
      overLimitSec += entry.seconds;
      overLimitMeters += entry.meters;
      if (excess > peakExcessKph) {
        peakExcessKph = excess;
        peakExcessAtMs = entry.point.timestampMs;
      }
    }

    const within = excess <= tolerance;
    anySec += entry.seconds;
    if (within) anyWithinSec += entry.seconds;
    if (entry.limit.source !== 'inferred') {
      knownSec += entry.seconds;
      if (within) knownWithinSec += entry.seconds;
    }
  }

  const judgedShare = coverage.movingSec > 0 ? knownSec / coverage.movingSec : 0;
  const anyShare = coverage.movingSec > 0 ? anySec / coverage.movingSec : 0;

  return {
    stretches: findStretches(judged, tolerance),
    // An unlimited road cannot be exceeded, so it reads as comfortably
    // compliant rather than as unknown: the limit there really is known.
    excessKph: judged.map((entry) =>
      entry.excessKph === undefined ? undefined
        : Number.isFinite(entry.excessKph) ? entry.excessKph : -1),
    limitKph: judged.map((entry) => entry.limit?.kph),
    limitSource: judged.map((entry) => entry.limit?.source),
    coverage,
    score: judgedShare >= MIN_COVERAGE_FOR_SCORE && knownSec > 0
      ? knownWithinSec / knownSec : null,
    scoreWithInferred: anyShare >= MIN_COVERAGE_FOR_SCORE && anySec > 0
      ? anyWithinSec / anySec : null,
    overLimitSec,
    overLimitMeters,
    peakExcessKph,
    peakExcessAtMs,
    region,
  };
}

/** Attaches the applicable limit, elapsed time and distance to each sample. */
function judge(
  points: CleanPoint[],
  matches: RoadMatch[],
  byId: Map<number, RoadWay>,
  region: RegionCode,
): Judged[] {
  return points.map((point, i) => {
    const previous = points[i - 1];
    const seconds = previous
      ? Math.min(Math.max((point.timestampMs - previous.timestampMs) / 1000, 0), MAX_INTERVAL_SEC)
      : 0;
    const meters = previous ? haversineMeters(previous, point) : 0;

    const match = matches[i];
    const way = match?.wayId === undefined ? undefined : byId.get(match.wayId);
    const limit = way ? limitForWay(way.tags, region, match?.forward ?? true) ?? undefined : undefined;

    // An unlimited road cannot be exceeded, so it is covered but never over.
    const excessKph = limit && Number.isFinite(limit.kph)
      ? point.smoothedSpeedKph - limit.kph
      : limit ? -Infinity : undefined;

    return {
      point, seconds, meters, limit,
      wayId: match?.wayId,
      roadName: way?.tags['name'],
      excessKph,
    };
  });
}

/**
 * Finds the sustained over-limit stretches.
 *
 * Arming is a leaky bucket rather than an unbroken run: at 1 Hz with a couple
 * of km/h of noise, a strict run would be broken by a single sample dipping
 * under and a forty-second stretch of speeding would never be reported at all.
 * Time under the tolerance drains the bucket instead, so ten seconds of net
 * excess is still required but one dropped sample does not erase it.
 *
 * The thresholds to open and to close are deliberately different. Opening at
 * limit-plus-tolerance keeps error out of the verdict; closing only once the
 * car is genuinely back at the limit stops a driver easing off from +9 to +4
 * from having their one offence recorded as two.
 */
function findStretches(judged: Judged[], tolerance: number): OverLimitStretch[] {
  const stretches: OverLimitStretch[] = [];

  let armedSec = 0;
  let armedFrom: number | undefined;
  let open: { from: number; limit: SpeedLimit; wayId?: number; roadName?: string } | undefined;
  let releaseSec = 0;
  let releaseFrom: number | undefined;

  const close = (to: number) => {
    if (!open) return;
    const end = releaseFrom ?? to;
    stretches.push(build(judged, open.from, end - 1 >= open.from ? end - 1 : open.from,
      open.limit, open.wayId, open.roadName));
    open = undefined;
    releaseSec = 0;
    releaseFrom = undefined;
  };

  for (const [i, entry] of judged.entries()) {
    const limit = entry.limit;
    const excess = entry.excessKph;

    // No comparison to make: a gap in knowledge is not evidence either way, so
    // any open stretch ends here rather than being extended through the dark.
    if (!limit || excess === undefined || !Number.isFinite(limit.kph)
        || entry.point.smoothedSpeedKph <= STOPPED_KPH) {
      close(i);
      armedSec = 0;
      armedFrom = undefined;
      continue;
    }

    // A new limit is a new question. Judging a 35 zone against the 65 the car
    // just left would carry a motorway's speeding into town.
    if (open && open.limit.kph !== limit.kph) {
      close(i);
      armedSec = 0;
      armedFrom = undefined;
    }

    if (!open) {
      if (excess > tolerance) {
        armedFrom ??= i;
        armedSec += entry.seconds;
        if (armedSec >= SUSTAIN_SEC) {
          open = { from: armedFrom, limit, wayId: entry.wayId, roadName: entry.roadName };
          armedSec = 0;
          armedFrom = undefined;
          releaseSec = 0;
          releaseFrom = undefined;
        }
      } else {
        armedSec = Math.max(0, armedSec - entry.seconds);
        if (armedSec === 0) armedFrom = undefined;
      }
      continue;
    }

    if (excess > 0) {
      releaseSec = 0;
      releaseFrom = undefined;
    } else {
      releaseFrom ??= i;
      releaseSec += entry.seconds;
      if (releaseSec >= RELEASE_SEC) close(i);
    }
  }

  close(judged.length);
  return stretches;
}

function build(
  judged: Judged[],
  from: number,
  to: number,
  limit: SpeedLimit,
  wayId: number | undefined,
  roadName: string | undefined,
): OverLimitStretch {
  let peakSpeedKph = 0;
  let distanceMeters = 0;
  for (let i = from; i <= to; i++) {
    const entry = judged[i]!;
    peakSpeedKph = Math.max(peakSpeedKph, entry.point.smoothedSpeedKph);
    if (i > from) distanceMeters += entry.meters;
  }

  const startMs = judged[from]!.point.timestampMs;
  const endMs = judged[to]!.point.timestampMs;
  const peakExcessKph = peakSpeedKph - limit.kph;

  return {
    startMs, endMs,
    durationSec: (endMs - startMs) / 1000,
    limitKph: limit.kph,
    limitSource: limit.source,
    peakSpeedKph,
    peakExcessKph,
    distanceMeters,
    severity: severityFor(peakExcessKph),
    roadName,
    wayId,
  };
}

/**
 * Severity by how far over the limit the car actually got.
 *
 * Keyed to excess over the limit, not over the tolerance, because the limit is
 * the number on the sign and the one a reader will compare against.
 */
export function severityFor(peakExcessKph: number): Severity {
  const mph = kphToMph(peakExcessKph);
  if (mph >= 20) return 'severe';
  if (mph >= 10) return 'moderate';
  return 'minor';
}
