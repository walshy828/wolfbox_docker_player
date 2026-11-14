import type { ReviewTrip } from './card.ts';

export type TripFilter = 'all' | 'drives' | 'events';
export type TripSort = 'newest' | 'oldest' | 'longest' | 'riskiest';

export const tripDurationMs = (trip: ReviewTrip) => trip.endLocalMs - trip.startLocalMs;

/**
 * Applies the sidebar's filter and sort.
 *
 * Newest first is the default because a card is a rolling loop: the drive you
 * want to review is almost always the one that just happened, and the oldest
 * clips are the ones about to be overwritten.
 */
export function selectTrips(
  drives: ReviewTrip[],
  events: ReviewTrip[],
  filter: TripFilter,
  sort: TripSort,
  /** A trip's risk score, 0-100 with lower riskier, once known. Needed for 'riskiest'. */
  scoreOf: (trip: ReviewTrip) => number | undefined = () => undefined,
): ReviewTrip[] {
  const chosen =
    filter === 'drives' ? drives :
    filter === 'events' ? events :
    [...drives, ...events];

  const ordered = [...chosen];
  switch (sort) {
    case 'oldest':
      ordered.sort((a, b) => a.startLocalMs - b.startLocalMs);
      break;
    case 'riskiest':
      // Unscored trips -- still reading, or too short to judge -- go last, so
      // the top of the list is always something that has been judged risky.
      ordered.sort((a, b) =>
        (scoreOf(a) ?? Infinity) - (scoreOf(b) ?? Infinity) || b.startLocalMs - a.startLocalMs);
      break;
    case 'longest':
      ordered.sort((a, b) => tripDurationMs(b) - tripDurationMs(a));
      break;
    default:
      ordered.sort((a, b) => b.startLocalMs - a.startLocalMs);
  }
  return ordered;
}

/**
 * Adds or removes one trip from the sidebar selection.
 *
 * Selections are held as ids rather than trips because a delete rebuilds every
 * trip object on the card; ids that no longer exist are pruned by the caller.
 */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Shift-click: selects everything between the anchor and the clicked row.
 *
 * The range runs over the list as displayed, so it follows the current filter
 * and sort rather than the underlying card order. An anchor that has scrolled
 * out of the filtered list degrades to a plain toggle.
 */
export function rangeSelected(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
  anchorId: string | null,
  id: string,
): Set<string> {
  const from = anchorId === null ? -1 : visibleIds.indexOf(anchorId);
  const to = visibleIds.indexOf(id);
  if (from < 0 || to < 0) return toggleSelected(selected, id);

  const next = new Set(selected);
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(visibleIds[i]!);
  return next;
}
