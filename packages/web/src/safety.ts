import type { HarshEvent } from '@wolfbox/telemetry';

/**
 * How long before a hard-braking event to seek to.
 *
 * `startMs` is the first sample whose speed already reflects the braking --
 * the change happened during the second leading up to it, not at it -- so
 * seeking there alone drops the viewer already mid-stop, or past it. Rewinding
 * gives enough lead-in to actually see the brake happen, not just its result.
 */
export const BRAKE_LEAD_MS = 10_000;

/**
 * Where to seek the player to see a harsh event unfold, not just its aftermath.
 *
 * Hard acceleration does not get the same treatment: `startMs` there is the
 * first sample the car was already accelerating hard, and the run-up to a
 * launch is generally visible in frame already, unlike a stop.
 *
 * Clamped to `earliestMs` (the trip's first sample) so an event within the
 * lead-in of the very start of a trip does not seek before anything the
 * player has to show, which `seek()` silently ignores.
 */
export function seekTargetMs(event: HarshEvent, earliestMs?: number): number {
  const target = event.kind === 'braking' ? event.startMs - BRAKE_LEAD_MS : event.startMs;
  return earliestMs === undefined ? target : Math.max(earliestMs, target);
}
