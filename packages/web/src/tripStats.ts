import { useEffect, useRef, useState } from 'react';
import { assessRisk, type DriveRisk, type TripAdherence, type TripSummary } from '@wolfbox/telemetry';
import type { CardTrip } from './card.ts';
import { loadTripTrack } from './track.ts';
import { reverseGeocode } from './geocode.ts';
import { computeAdherence } from './limits.ts';

export type LimitsState = 'pending' | 'ready' | 'unavailable';

export type TripStatsEntry =
  | { status: 'pending' }
  | { status: 'unavailable' }
  | {
      status: 'ready';
      distanceMeters: number;
      maxSpeedKph: number;
      averageMovingSpeedKph: number;
      movingSec: number;
      /** Undefined while the place name is still being looked up, or has none. */
      startLabel?: string;
      endLabel?: string;
      /** Hard braking, acceleration and cornering counts, from GPS alone. */
      harshEvents: { moderate: number; severe: number };
      /**
       * Where the speed-limit lookup has got to. The risk score is shown from
       * the start, from behaviour alone, and is replaced once limits arrive;
       * `risk.includesSpeeding` says which one is on screen.
       */
      limits: LimitsState;
      risk: DriveRisk | null;
    };

/** Lets the browser breathe between trips, off its busy stretches when it can. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 0);
  });
}

/** Speeding results outlive a re-render of the list: the same trip is never looked up twice in a tab. */
const adherenceCache = new Map<string, TripAdherence | null>();

/**
 * Fills in every trip's figures and risk score, in the background.
 *
 * Two passes. The first reads each trip's GPS off the card -- local, but slow,
 * about 0.7 s a clip -- and gives the list distance, speeds, place names and a
 * behaviour-only score. The second looks up speed limits for each drive, one
 * at a time, and replaces the score with one that includes speeding. Running
 * all of the local pass first means the list is useful within seconds, and
 * sequential lookups keep the load on the volunteer-run OpenStreetMap service
 * to one trip's tiles at a time (the local service caches every tile for a
 * month, so a card's second visit costs nothing upstream).
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

    const queue = trips.filter((trip) => {
      const entry = statsRef.current.get(trip.id);
      return !entry || (entry.status === 'ready' && entry.limits === 'pending');
    });
    if (queue.length === 0) return;

    const controller = new AbortController();
    let cancelled = false;
    const update = (id: string, patch: (entry: TripStatsEntry | undefined) => TripStatsEntry | undefined) =>
      setStats((prev) => {
        const next = patch(prev.get(id));
        return next ? new Map(prev).set(id, next) : prev;
      });

    void (async () => {
      const summaries = new Map<string, { summary: TripSummary; points: Parameters<typeof computeAdherence>[0] }>();

      // Pass one: the card.
      for (const trip of queue) {
        if (cancelled) return;
        await idle();
        if (cancelled) return;
        if (!statsRef.current.has(trip.id)) update(trip.id, () => ({ status: 'pending' }));
        try {
          const track = await loadTripTrack(trip, { signal: controller.signal });
          if (cancelled) return;
          const { summary } = track;
          if (!summary) { update(trip.id, () => ({ status: 'unavailable' })); continue; }
          summaries.set(trip.id, { summary, points: track.points });

          const cachedAdherence = adherenceCache.get(trip.id);
          update(trip.id, (existing) => ({
            status: 'ready',
            distanceMeters: summary.distanceMeters,
            maxSpeedKph: summary.maxSpeedKph,
            averageMovingSpeedKph: summary.averageMovingSpeedKph,
            movingSec: summary.movingSec,
            startLabel: existing?.status === 'ready' ? existing.startLabel : undefined,
            endLabel: existing?.status === 'ready' ? existing.endLabel : undefined,
            harshEvents: {
              moderate: summary.harshEvents.filter((e) => e.severity === 'moderate').length,
              severe: summary.harshEvents.filter((e) => e.severity === 'severe').length,
            },
            limits: cachedAdherence === undefined ? 'pending' : cachedAdherence ? 'ready' : 'unavailable',
            risk: assessRisk({ summary, adherence: cachedAdherence }),
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
          update(trip.id, (existing) => existing?.status === 'ready'
            ? { ...existing, startLabel: startLabel ?? undefined, endLabel: endLabel ?? undefined }
            : undefined);
        } catch {
          if (!cancelled) update(trip.id, () => ({ status: 'unavailable' }));
        }
      }

      // Pass two: speed limits, newest drive first, since that is the one most
      // likely to be reviewed next.
      const pending = queue
        .filter((trip) => summaries.has(trip.id) && !adherenceCache.has(trip.id))
        .sort((a, b) => b.startLocalMs - a.startLocalMs);
      for (const trip of pending) {
        if (cancelled) return;
        const { summary, points } = summaries.get(trip.id)!;
        let adherence: TripAdherence | null = null;
        try {
          adherence = (await computeAdherence(points, controller.signal))?.adherence ?? null;
        } catch {
          if (cancelled) return;
        }
        if (cancelled) return;
        adherenceCache.set(trip.id, adherence);
        update(trip.id, (existing) => existing?.status === 'ready'
          ? {
              ...existing,
              limits: adherence ? 'ready' : 'unavailable',
              risk: assessRisk({ summary, adherence }),
            }
          : undefined);
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [trips]);

  return stats;
}
