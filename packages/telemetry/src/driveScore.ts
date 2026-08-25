import type { HarshEvent } from './harshEvents.ts';

/**
 * Boils a drive down to one number a parent can glance at in a list, without
 * pretending it means more than it does.
 *
 * Two very different kinds of evidence feed it. Harsh braking/acceleration is
 * derived from GPS alone and is always available, for free, the moment a
 * trip's track is read. Speed-limit adherence is not: it needs a network
 * lookup against OpenStreetMap that the app deliberately makes only for the
 * trip currently open (see `limits.ts` in the web package), so most trips in
 * a list will never have it. The score has to make sense either way, so it is
 * built from behaviour alone and adherence is blended in only when supplied,
 * rather than being required.
 *
 * Event counts are normalised per 100 miles rather than used raw, so a
 * 40-minute commute and a six-hour road trip are not judged on the same
 * absolute count.
 */

export interface DriveScoreInput {
  harshEvents: readonly HarshEvent[];
  distanceMeters: number;
  /**
   * Share of judged moving time spent at or under the limit plus tolerance,
   * 0-1. Pass `adherence.score ?? adherence.scoreWithInferred`, or leave
   * undefined where no lookup has been made for this trip.
   */
  adherenceScore?: number | null;
}

export type DriveScoreBand = 'good' | 'fair' | 'poor';

export interface DriveScore {
  /** 0-100, higher is better. */
  value: number;
  band: DriveScoreBand;
  /** Whether `value` reflects speed-limit adherence, or braking/acceleration alone. */
  includesAdherence: boolean;
}

const MILES_PER_METER = 1 / 1609.344;
/** Below this a trip is too short for a rate-based score to mean anything. */
const MIN_MILES = 0.5;
/** Points off per moderate/severe harsh event per 100 miles. */
const MODERATE_PENALTY = 4;
const SEVERE_PENALTY = 10;
/** However bad the event rate, behaviour alone cannot sink the score below this. */
const MIN_BEHAVIOR_SCORE = 20;
/** How much weight adherence carries once it's known, versus behaviour. */
const ADHERENCE_WEIGHT = 0.4;

export function bandFor(value: number): DriveScoreBand {
  if (value >= 85) return 'good';
  if (value >= 65) return 'fair';
  return 'poor';
}

/**
 * Scores a drive. Returns null for a trip too short to judge a rate against
 * -- a one-minute parking-lot clip is not evidence of anything.
 */
export function computeDriveScore(input: DriveScoreInput): DriveScore | null {
  const miles = input.distanceMeters * MILES_PER_METER;
  if (miles < MIN_MILES) return null;

  const per100 = (count: number) => (count / miles) * 100;
  const moderate = input.harshEvents.filter((e) => e.severity === 'moderate').length;
  const severe = input.harshEvents.filter((e) => e.severity === 'severe').length;

  const penalty = per100(moderate) * MODERATE_PENALTY + per100(severe) * SEVERE_PENALTY;
  const behaviorScore = Math.max(MIN_BEHAVIOR_SCORE, 100 - penalty);

  const includesAdherence = input.adherenceScore != null;
  const value = includesAdherence
    ? behaviorScore * (1 - ADHERENCE_WEIGHT) + input.adherenceScore! * 100 * ADHERENCE_WEIGHT
    : behaviorScore;

  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return { value: clamped, band: bandFor(clamped), includesAdherence };
}
