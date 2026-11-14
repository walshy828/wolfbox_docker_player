import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardTrip } from './card.ts';
import { getArchived, importTrip, type ArchivedTrip } from './archive.ts';
import { loadTripTrack } from './track.ts';
import { cachedAdherence, type TripStatsEntry } from './tripStats.ts';

/**
 * Saves every drive on the card to the archive's history, data only.
 *
 * A card is a rolling loop, so a drive that is not saved is a drive that will
 * eventually be missing from history and mileage. The background stats pass
 * already reads each drive's GPS and looks up its limits; once it has, the
 * drive's data is small (a few hundred KB) and cheap to save, so it is saved
 * without asking. Video stays a deliberate choice, made in the import sheet.
 *
 * A drive is saved once its limits lookup has finished (either way), so the
 * score that goes into history is the one that counts speeding. A drive saved
 * earlier without limits is saved again when limits become available; one
 * saved with them is left alone. The driver, notes and flag are never touched
 * by a save: the server keeps whatever is already set.
 */

const SETTING_KEY = 'wolfbox-autosave';

/** On unless turned off; the choice is per browser. */
export function useAutoSaveSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(SETTING_KEY) !== 'off'; } catch { return true; }
  });
  const set = useCallback((next: boolean) => {
    setOn(next);
    try { localStorage.setItem(SETTING_KEY, next ? 'on' : 'off'); } catch { /* private window */ }
  }, []);
  return [on, set];
}

/** The drives that are ready to save and need it, oldest first so history fills in order. Exported for tests. */
export function autosaveCandidates(
  drives: readonly CardTrip[],
  stats: ReadonlyMap<string, TripStatsEntry>,
  archived: ReadonlyMap<string, Pick<ArchivedTrip, 'risk'>>,
  attempted: ReadonlySet<string>,
): CardTrip[] {
  return drives.filter((trip) => {
    if (attempted.has(trip.id)) return false;
    const entry = stats.get(trip.id);
    if (entry?.status !== 'ready' || entry.limits === 'pending') return false;
    const saved = archived.get(trip.id);
    if (!saved) return true;
    // Upgrade a copy saved before limits were known.
    return entry.limits === 'ready' && !saved.risk?.includesSpeeding;
  }).sort((a, b) => a.startLocalMs - b.startLocalMs);
}

export interface AutoSaveState {
  /** Drives saved by this pass since the card was opened. */
  saved: number;
  failed: number;
  /** The drive being saved right now, if any. */
  current: string | null;
  lastError: string | null;
}

export function useAutoSave({
  enabled, drives, stats, archived, cameraOffsetMs, onSaved,
}: {
  enabled: boolean;
  drives: readonly CardTrip[];
  stats: ReadonlyMap<string, TripStatsEntry>;
  archived: ReadonlyMap<string, ArchivedTrip>;
  cameraOffsetMs?: number;
  onSaved: (trip: ArchivedTrip) => void;
}): AutoSaveState {
  const [state, setState] = useState<AutoSaveState>({ saved: 0, failed: 0, current: null, lastError: null });
  const attempted = useRef(new Set<string>());
  const running = useRef(false);
  // The loop outlives renders, so it reads the latest of everything through these.
  const latest = useRef({ enabled, drives, stats, archived, cameraOffsetMs, onSaved });
  latest.current = { enabled, drives, stats, archived, cameraOffsetMs, onSaved };
  const [wake, setWake] = useState(0);
  // Only unmounting stops a pass. Stats change every few seconds while a card
  // is read, and each change re-runs the effect below; tying the pass to that
  // effect's cleanup would stop it after every drive.
  const unmounted = useRef(false);
  useEffect(() => {
    // Reset on mount: StrictMode mounts, unmounts and mounts again in development.
    unmounted.current = false;
    return () => { unmounted.current = true; };
  }, []);

  useEffect(() => {
    if (!enabled || running.current) return;
    if (autosaveCandidates(drives, stats, archived, attempted.current).length === 0) return;
    running.current = true;

    void (async () => {
      try {
        for (;;) {
          const now = latest.current;
          if (unmounted.current || !now.enabled) break;
          const next = autosaveCandidates(now.drives, now.stats, now.archived, attempted.current)[0];
          if (!next) break;
          attempted.current.add(next.id);
          setState((s) => ({ ...s, current: next.id }));
          try {
            const track = await loadTripTrack(next);
            if (!track.summary) continue;
            const entry = now.stats.get(next.id);
            await importTrip({
              trip: next,
              points: track.points,
              summary: track.summary,
              clipStarts: track.clipStarts,
              adherence: cachedAdherence(next.id) ?? null,
              startLabel: entry?.status === 'ready' ? entry.startLabel : undefined,
              endLabel: entry?.status === 'ready' ? entry.endLabel : undefined,
              cameraOffsetMs: now.cameraOffsetMs,
              // Null keeps whatever driver the archive already has for this drive.
              driverId: null,
            }, { withVideo: false });
            latest.current.onSaved(await getArchived(next.id));
            setState((s) => ({ ...s, saved: s.saved + 1 }));
          } catch (cause) {
            setState((s) => ({
              ...s, failed: s.failed + 1, lastError: cause instanceof Error ? cause.message : String(cause),
            }));
          }
        }
      } finally {
        running.current = false;
        setState((s) => ({ ...s, current: null }));
        // Stats may have moved on while this pass ran; look again.
        if (!unmounted.current) setWake((n) => n + 1);
      }
    })();
    // `archived` is deliberately left out: each save updates it, and the loop
    // already reads the latest copy, so it must not restart the pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, drives, stats, wake]);

  return state;
}
