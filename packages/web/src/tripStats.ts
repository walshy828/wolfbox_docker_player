import { useEffect, useRef, useState } from 'react';
import { computeDriveScore, type DriveScore } from '@wolfbox/telemetry';
import type { CardTrip } from './card.ts';
import { loadTripTrack } from './track.ts';
import { reverseGeocode } from './geocode.ts';

export type TripStatsEntry =
  | { status: 'pending' }
  | { status: 'unavailable' }
  | {
      status: 'ready';
      distanceMeters: number;
      maxSpeedKph: number;
      /** Undefined while the place name is still being looked up, or has none. */
      startLabel?: string;
      endLabel?: string;
      /** Hard-braking/acceleration counts, from GPS alone -- no network involved. */
      harshEvents: { moderate: number; severe: number };
      /**
       * Behaviour-only score (braking/acceleration, not speed-limit adherence,
       * which needs a lookup this background pass deliberately never makes --
       * see `limits.ts`). Null for a trip too short to score.
       */
      score: DriveScore | null;
    };

/** Runs one microtask-free tick later, off the JS thread's busy stretches when possible. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 0);
  });
}

/**
 * Fills in distance, top speed, and start/end place names for every trip in
 * the list, in the background.
 *
 * Each figure comes from the same GPS decode the drive summary uses, so it is
 * expensive -- reading video files, not metadata -- which is why trips are
 * processed one at a time, off the interaction path, rather than all at once.
 * `loadTripTrack`'s own cache means a trip already opened, or already warmed
 * by a previous run of this queue, resolves instantly on repeat visits.
 */
export function useTripStats(trips: readonly CardTrip[]): ReadonlyMap<string, TripStatsEntry> {
  const [stats, setStats] = useState<ReadonlyMap<string, TripStatsEntry>>(() => new Map());
  const statsRef = useRef(stats);
  statsRef.current = stats;

  useEffect(() => {
    const known = new Set(trips.map((trip) => trip.id));
    setStats((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!known.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });

    const queue = trips.filter((trip) => !statsRef.current.has(trip.id));
    if (queue.length === 0) return;

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      for (const trip of queue) {
        if (cancelled) return;
        await idle();
        if (cancelled) return;

        setStats((prev) => new Map(prev).set(trip.id, { status: 'pending' }));
        try {
          const track = await loadTripTrack(trip, { signal: controller.signal });
          if (cancelled) return;
          const { summary } = track;
          if (!summary) {
            setStats((prev) => new Map(prev).set(trip.id, { status: 'unavailable' }));
            continue;
          }

          const harshEvents = {
            moderate: summary.harshEvents.filter((e) => e.severity === 'moderate').length,
            severe: summary.harshEvents.filter((e) => e.severity === 'severe').length,
          };

          setStats((prev) => new Map(prev).set(trip.id, {
            status: 'ready',
            distanceMeters: summary.distanceMeters,
            maxSpeedKph: summary.maxSpeedKph,
            harshEvents,
            score: computeDriveScore({
              harshEvents: summary.harshEvents,
              distanceMeters: summary.distanceMeters,
            }),
          }));

          const [startLabel, endLabel] = await Promise.all([
            summary.start
              ? reverseGeocode(summary.start.latitude, summary.start.longitude, controller.signal)
              : Promise.resolve(null),
            summary.end
              ? reverseGeocode(summary.end.latitude, summary.end.longitude, controller.signal)
              : Promise.resolve(null),
          ]);
          if (cancelled) return;

          setStats((prev) => {
            const existing = prev.get(trip.id);
            if (!existing || existing.status !== 'ready') return prev;
            return new Map(prev).set(trip.id, {
              ...existing,
              startLabel: startLabel ?? undefined,
              endLabel: endLabel ?? undefined,
            });
          });
        } catch {
          if (!cancelled) setStats((prev) => new Map(prev).set(trip.id, { status: 'unavailable' }));
        }
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [trips]);

  return stats;
}
