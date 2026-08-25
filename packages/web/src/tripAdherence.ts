import { useCallback, useState } from 'react';
import {
  assessAdherence, inferRegion, matchRoads, severityFor, type Severity,
} from '@wolfbox/telemetry';
import type { CardTrip } from './card.ts';
import { loadRoadWays } from './limits.ts';
import { loadTripTrack } from './track.ts';

export type TripAdherenceEntry =
  | { status: 'pending' }
  | { status: 'unavailable' }
  | {
      status: 'ready';
      /** Share of judged moving time at or under the limit, 0-1. Null if too little was known to score. */
      withinShare: number | null;
      /** Severity of the drive's worst moment over a known limit, or null if it never went over. */
      peakSeverity: Severity | null;
    };

/** Results are kept for the life of the tab: the same trip revisited later, or scrolled past again, must not re-query OSM. */
const cache = new Map<string, TripAdherenceEntry>();
const inFlight = new Set<string>();

/**
 * Lazily scores trips against speed limits for display in the trip list.
 *
 * Unlike `useTripStats` (which reads every trip's track locally, for free),
 * this needs the same OpenStreetMap lookup `useTripLimits` makes for the open
 * drive -- so it is never run eagerly for a whole list. Callers request a
 * trip only once its row is actually visible (see `TripList`'s intersection
 * observer), and the module-level cache means scrolling back to an
 * already-scored row costs nothing more.
 */
export function useTripAdherence(): {
  entries: ReadonlyMap<string, TripAdherenceEntry>;
  request: (trip: CardTrip) => void;
} {
  const [entries, setEntries] = useState<ReadonlyMap<string, TripAdherenceEntry>>(() => new Map(cache));

  const request = useCallback((trip: CardTrip) => {
    if (cache.has(trip.id) || inFlight.has(trip.id)) return;
    inFlight.add(trip.id);
    cache.set(trip.id, { status: 'pending' });
    setEntries(new Map(cache));

    void (async () => {
      let result: TripAdherenceEntry;
      try {
        const track = await loadTripTrack(trip);
        if (track.points.length === 0) {
          result = { status: 'unavailable' };
        } else {
          const ways = await loadRoadWays(track.points);
          if (ways.length === 0) {
            result = { status: 'unavailable' };
          } else {
            const region = inferRegion(ways.map((way) => way.tags), track.points[0]);
            const matches = matchRoads(track.points, ways);
            const adherence = assessAdherence(track.points, matches, ways, region);
            result = {
              status: 'ready',
              withinShare: adherence.score ?? adherence.scoreWithInferred,
              peakSeverity: adherence.peakExcessKph > 0 ? severityFor(adherence.peakExcessKph) : null,
            };
          }
        }
      } catch {
        result = { status: 'unavailable' };
      }
      cache.set(trip.id, result);
      inFlight.delete(trip.id);
      setEntries(new Map(cache));
    })();
  }, []);

  return { entries, request };
}
