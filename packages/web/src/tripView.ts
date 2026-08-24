import type { CardTrip } from './card.ts';

export type TripFilter = 'all' | 'drives' | 'events';
export type TripSort = 'newest' | 'oldest' | 'longest';

export const tripDurationMs = (trip: CardTrip) => trip.endLocalMs - trip.startLocalMs;

/**
 * Applies the sidebar's filter and sort.
 *
 * Newest first is the default because a card is a rolling loop: the drive you
 * want to review is almost always the one that just happened, and the oldest
 * clips are the ones about to be overwritten.
 */
export function selectTrips(
  drives: CardTrip[],
  events: CardTrip[],
  filter: TripFilter,
  sort: TripSort,
): CardTrip[] {
  const chosen =
    filter === 'drives' ? drives :
    filter === 'events' ? events :
    [...drives, ...events];

  const ordered = [...chosen];
  switch (sort) {
    case 'oldest':
      ordered.sort((a, b) => a.startLocalMs - b.startLocalMs);
      break;
    case 'longest':
      ordered.sort((a, b) => tripDurationMs(b) - tripDurationMs(a));
      break;
    default:
      ordered.sort((a, b) => b.startLocalMs - a.startLocalMs);
  }
  return ordered;
}
