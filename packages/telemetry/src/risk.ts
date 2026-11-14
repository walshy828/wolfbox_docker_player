import type { TripAdherence } from './adherence.ts';
import { kphToMph } from './geo.ts';
import type { HarshEvent, HarshKind } from './harshEvents.ts';
import type { TripSummary } from './summary.ts';

/**
 * Scores how risky a drive was, and says why.
 *
 * A parent reviewing a card wants two things from a list of drives: which ones
 * to watch first, and what to look for in them. A single opaque number answers
 * the first and not the second, so the score is built by deduction from 100,
 * one named factor at a time, and every factor carries a plain-English label
 * ("7 min over the limit", "2 hard stops"). The factors are the explanation.
 *
 * Event counts are judged per 10 miles, but over at least `MIN_EXPOSURE_MILES`,
 * so one hard stop on a two-mile errand is not treated as five times worse
 * than the same stop on a ten-mile commute. Each factor is capped, so no one
 * kind of behaviour can account for the whole score.
 *
 * A drive is also capped by its worst moment. Averages forgive: ten minutes at
 * 22 over on a forty-minute drive is a quarter of the time, but it is the ten
 * minutes worth watching, and a score of 80 would hide it. So a severe moment
 * caps the score below the band it would otherwise land in.
 *
 * Speeding needs a speed-limit lookup and may be missing. The score is still
 * given without it -- behaviour is always known -- but `includesSpeeding` says
 * so, and the UI must not present such a score as complete.
 */

export type RiskBand = 'low' | 'moderate' | 'high';
export type FactorSeverity = 'minor' | 'moderate' | 'severe';
export type RiskFactorKey = 'speeding' | 'top-speed' | HarshKind;

export interface RiskFactor {
  key: RiskFactorKey;
  /** Short and concrete, for a chip in a list: "7 min over the limit". */
  label: string;
  /** One more line of evidence, for the drive's own breakdown. */
  detail?: string;
  /** Points deducted from 100. */
  points: number;
  severity: FactorSeverity;
}

export interface SpeedingStats {
  /** Seconds inside sustained over-limit stretches. */
  stretchSec: number;
  stretchCount: number;
  longestSec: number;
  /** Worst excess over the limit across all stretches, km/h. */
  peakExcessKph: number;
  peakRoad?: string;
  bySeverity: { minor: number; moderate: number; severe: number };
  /** Share of moving time over limit plus tolerance, 0-1. Null with too little known. */
  overShare: number | null;
  /** True when `overShare` had to lean on limits guessed from the road class. */
  assumed: boolean;
}

export interface DriveRisk {
  /** 0-100, higher is safer. */
  score: number;
  band: RiskBand;
  /** Every factor that cost points, worst first. */
  factors: RiskFactor[];
  speeding: SpeedingStats | null;
  /** Whether speed limits were known when this score was made. */
  includesSpeeding: boolean;
  /** Set when the worst moment capped the score lower than the factors alone. */
  cappedBy?: string;
}

export interface RiskInput {
  summary: Pick<TripSummary, 'distanceMeters' | 'movingSec' | 'maxSpeedKph' | 'histogramMph' | 'harshEvents'>;
  adherence?: TripAdherence | null;
}

const MILES_PER_METER = 1 / 1609.344;
/** Below this there is not enough driving to judge. */
export const MIN_RISK_MILES = 0.5;
/** Event rates are judged over at least this many miles. */
export const MIN_EXPOSURE_MILES = 5;

/** Points per event, before scaling for distance, and the most each kind can cost. */
const EVENT_WEIGHTS: Record<HarshKind, { moderate: number; severe: number; cap: number }> = {
  braking: { moderate: 6, severe: 15, cap: 30 },
  acceleration: { moderate: 5, severe: 12, cap: 25 },
  cornering: { moderate: 5, severe: 12, cap: 25 },
};
/**
 * Speeding time is judged over at least this much moving time, for the same
 * reason event rates have a distance floor: 48 seconds over in a drive with
 * two minutes of GPS is a third of the drive, but it is still 48 seconds.
 */
export const MIN_EXPOSURE_SEC = 600;
/** Points per percent of moving time spent over the limit plus tolerance. */
const SPEEDING_POINTS_PER_PCT = 0.8;
/** Points per sustained stretch, by severity, on top of the time spent. */
const STRETCH_POINTS = { minor: 1, moderate: 4, severe: 10 } as const;
const SPEEDING_CAP = 45;
/** A limit guessed from the road class counts for this much of a signed one. */
const ASSUMED_WEIGHT = 0.5;
/** Very fast in absolute terms, whatever the limit: the top of the map's colour ramp. */
const FAST_MPH = 80;
const VERY_FAST_MPH = 90;

export const bandFor = (score: number): RiskBand =>
  score >= 85 ? 'low' : score >= 65 ? 'moderate' : 'high';

const severityOf = (points: number): FactorSeverity =>
  points >= 15 ? 'severe' : points >= 5 ? 'moderate' : 'minor';

/** m:ss, or whole minutes past ten. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s >= 600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Summarises the over-limit stretches of a drive. Null without a lookup. */
export function speedingStats(adherence: TripAdherence | null | undefined): SpeedingStats | null {
  if (!adherence) return null;
  const bySeverity = { minor: 0, moderate: 0, severe: 0 };
  let stretchSec = 0;
  let longestSec = 0;
  let peakExcessKph = 0;
  let peakRoad: string | undefined;
  for (const stretch of adherence.stretches) {
    bySeverity[stretch.severity]++;
    stretchSec += stretch.durationSec;
    longestSec = Math.max(longestSec, stretch.durationSec);
    if (stretch.peakExcessKph > peakExcessKph) {
      peakExcessKph = stretch.peakExcessKph;
      peakRoad = stretch.roadName;
    }
  }
  const within = adherence.score ?? adherence.scoreWithInferred;
  return {
    stretchSec,
    stretchCount: adherence.stretches.length,
    longestSec,
    peakExcessKph,
    peakRoad,
    bySeverity,
    overShare: within === null ? null : 1 - within,
    assumed: adherence.score === null && adherence.scoreWithInferred !== null,
  };
}

const EVENT_NOUN: Record<HarshKind, [string, string]> = {
  braking: ['hard stop', 'hard stops'],
  acceleration: ['hard launch', 'hard launches'],
  cornering: ['sharp turn', 'sharp turns'],
};

function eventFactor(kind: HarshKind, events: HarshEvent[], exposureMiles: number): RiskFactor | null {
  const ofKind = events.filter((event) => event.kind === kind);
  if (ofKind.length === 0) return null;
  const weights = EVENT_WEIGHTS[kind];
  const severe = ofKind.filter((event) => event.severity === 'severe').length;
  const moderate = ofKind.length - severe;
  const raw = (moderate * weights.moderate + severe * weights.severe) * (10 / exposureMiles);
  const points = Math.min(weights.cap, raw);
  const [one, many] = EVENT_NOUN[kind];
  const peak = Math.max(...ofKind.map((event) => Math.abs(event.peakG)));
  return {
    key: kind,
    label: `${ofKind.length} ${ofKind.length === 1 ? one : many}`,
    detail: `${severe > 0 ? `${severe} severe · ` : ''}peak ${peak.toFixed(2)} g`,
    points,
    severity: severe > 0 ? 'severe' : severityOf(points),
  };
}

function speedingFactor(
  stats: SpeedingStats, adherence: TripAdherence, movingSec: number,
): RiskFactor | null {
  if (stats.stretchCount === 0 && !stats.overShare) return null;
  const weight = stats.assumed ? ASSUMED_WEIGHT : 1;
  let stretchPoints = 0;
  for (const stretch of adherence.stretches) {
    stretchPoints += STRETCH_POINTS[stretch.severity] * (stretch.limitSource === 'inferred' ? ASSUMED_WEIGHT : 1);
  }
  const exposure = Math.min(1, movingSec / MIN_EXPOSURE_SEC);
  const timePoints = (stats.overShare ?? 0) * exposure * 100 * SPEEDING_POINTS_PER_PCT * weight;
  const points = Math.min(SPEEDING_CAP, timePoints + stretchPoints);
  if (points < 0.5) return null;

  const peakMph = Math.round(kphToMph(stats.peakExcessKph));
  const parts = [
    `${stats.stretchCount} stretch${stats.stretchCount === 1 ? '' : 'es'}`,
    stats.stretchCount > 0 ? `longest ${formatDuration(stats.longestSec)}` : null,
    stats.stretchCount > 0 ? `peak ${peakMph} over${stats.peakRoad ? ` on ${stats.peakRoad}` : ''}` : null,
    stats.assumed ? 'some limits assumed' : null,
  ].filter(Boolean);

  return {
    key: 'speeding',
    label: stats.stretchSec > 0
      ? `${formatDuration(stats.stretchSec)} over the limit`
      : `${Math.round((stats.overShare ?? 0) * 100)}% over the limit`,
    detail: parts.join(' · '),
    points,
    severity: stats.bySeverity.severe > 0 ? 'severe' : severityOf(points),
  };
}

function topSpeedFactor(summary: RiskInput['summary']): RiskFactor | null {
  const maxMph = kphToMph(summary.maxSpeedKph);
  if (maxMph < FAST_MPH) return null;
  const fastSec = summary.histogramMph.at(-1) ?? 0;
  const points = maxMph >= VERY_FAST_MPH ? 15 : Math.min(15, 5 + (fastSec / 60) * 2);
  return {
    key: 'top-speed',
    label: `Reached ${Math.round(maxMph)} mph`,
    detail: `${formatDuration(fastSec)} at ${FAST_MPH}+ mph`,
    points,
    severity: maxMph >= VERY_FAST_MPH ? 'severe' : severityOf(points),
  };
}

/**
 * Scores a drive. Null for one too short to judge -- a one-minute parking clip
 * is not evidence of anything.
 */
export function assessRisk({ summary, adherence }: RiskInput): DriveRisk | null {
  const miles = summary.distanceMeters * MILES_PER_METER;
  if (miles < MIN_RISK_MILES) return null;
  const exposure = Math.max(miles, MIN_EXPOSURE_MILES);

  const speeding = speedingStats(adherence);
  const factors = [
    speeding && adherence ? speedingFactor(speeding, adherence, summary.movingSec) : null,
    topSpeedFactor(summary),
    eventFactor('braking', summary.harshEvents, exposure),
    eventFactor('acceleration', summary.harshEvents, exposure),
    eventFactor('cornering', summary.harshEvents, exposure),
  ].filter((factor): factor is RiskFactor => factor !== null)
    .sort((a, b) => b.points - a.points);

  let score = Math.max(0, 100 - factors.reduce((sum, factor) => sum + factor.points, 0));

  // The worst moment caps the score, so it cannot be averaged away.
  const caps: [number, string][] = [];
  if (kphToMph(summary.maxSpeedKph) >= VERY_FAST_MPH) caps.push([60, `reached ${VERY_FAST_MPH}+ mph`]);
  const signedSevere = adherence?.stretches.some(
    (stretch) => stretch.severity === 'severe' && stretch.limitSource !== 'inferred');
  if (signedSevere) caps.push([64, '20+ mph over a signed limit']);
  else if (speeding && speeding.bySeverity.severe > 0) caps.push([79, '20+ mph over an assumed limit']);
  if (summary.harshEvents.some((event) => event.severity === 'severe')) caps.push([84, 'a severe hard event']);

  let cappedBy: string | undefined;
  for (const [cap, reason] of caps) {
    if (score > cap) { score = cap; cappedBy = reason; }
  }

  const rounded = Math.round(score);
  return {
    score: rounded,
    band: bandFor(rounded),
    factors,
    speeding,
    includesSpeeding: adherence != null,
    cappedBy,
  };
}
