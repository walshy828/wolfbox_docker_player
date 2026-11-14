import { useEffect, useMemo, useRef, useState } from 'react';
import type { CardTrip } from '../card.ts';
import { importTrip, type ArchivedTrip, type Driver } from '../archive.ts';
import { loadTripTrack } from '../track.ts';
import { computeAdherence } from '../limits.ts';
import { cachedAdherence, type TripStatsEntry } from '../tripStats.ts';
import { formatLocal, type TimeContext } from '../time.ts';
import { metersToMiles } from '../units.ts';
import { RiskRing } from './Risk.tsx';

type RowState =
  | { status: 'waiting' }
  | { status: 'data' }
  | { status: 'video'; sent: number; total: number }
  | { status: 'done' }
  | { status: 'error'; message: string };

const WHEN: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/**
 * Copies drives from the card into the archive.
 *
 * Drive data always goes -- it is small, and it is what history and mileage
 * are built from. Video is a choice, made with its size in front of you,
 * because it is roughly 9 GB an hour and the reason to archive at all is that
 * a card cannot hold much of it.
 */
export function ImportSheet({
  drives, preselected, archived, stats, drivers, onAddDriver, cameraOffsetMs, time, onClose, onImported,
}: {
  drives: CardTrip[];
  preselected?: readonly string[];
  archived: ReadonlyMap<string, ArchivedTrip>;
  stats: ReadonlyMap<string, TripStatsEntry>;
  drivers: Driver[];
  onAddDriver: (name: string) => Promise<Driver>;
  cameraOffsetMs?: number;
  time: TimeContext;
  onClose: () => void;
  onImported: () => void;
}) {
  const ordered = useMemo(() => [...drives].sort((a, b) => b.startLocalMs - a.startLocalMs), [drives]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(
    preselected ?? ordered.filter((trip) => !archived.has(trip.id)).map((trip) => trip.id),
  ));
  const [driverId, setDriverId] = useState<number | null>(drivers[0]?.id ?? null);
  const [newDriver, setNewDriver] = useState('');
  const [withVideo, setWithVideo] = useState(false);
  const [videoBytes, setVideoBytes] = useState<number | null>(null);
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const selected = ordered.filter((trip) => checked.has(trip.id));
  const finished = rows.size > 0 && !running;

  // Size up the video, from file metadata only, whenever the selection changes.
  useEffect(() => {
    let cancelled = false;
    setVideoBytes(null);
    void (async () => {
      let total = 0;
      for (const trip of selected) {
        for (const pair of trip.clips) {
          for (const clip of [pair.front, pair.rear]) {
            if (clip) total += (await clip.handle.getFile()).size;
          }
        }
      }
      if (!cancelled) setVideoBytes(total);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !running) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, onClose]);

  const toggle = (id: string) => setChecked((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const run = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setRows(new Map(selected.map((trip) => [trip.id, { status: 'waiting' } as RowState])));
    const set = (id: string, state: RowState) => setRows((prev) => new Map(prev).set(id, state));

    for (const trip of selected) {
      if (abort.signal.aborted) break;
      set(trip.id, { status: 'data' });
      try {
        const track = await loadTripTrack(trip, { signal: abort.signal });
        if (!track.summary) throw new Error('No GPS in this drive.');
        let adherence = cachedAdherence(trip.id);
        if (adherence === undefined) {
          adherence = (await computeAdherence(track.points, abort.signal).catch(() => null))?.adherence ?? null;
        }
        const entry = stats.get(trip.id);
        await importTrip({
          trip,
          points: track.points,
          summary: track.summary,
          clipStarts: track.clipStarts,
          adherence,
          startLabel: entry?.status === 'ready' ? entry.startLabel : undefined,
          endLabel: entry?.status === 'ready' ? entry.endLabel : undefined,
          cameraOffsetMs,
          driverId,
        }, {
          withVideo,
          signal: abort.signal,
          onProgress: (progress) => {
            if (progress.phase === 'video') set(trip.id, { status: 'video', sent: progress.sentBytes, total: progress.totalBytes });
          },
        });
        set(trip.id, { status: 'done' });
      } catch (cause) {
        if (abort.signal.aborted) { set(trip.id, { status: 'error', message: 'Stopped' }); break; }
        set(trip.id, { status: 'error', message: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    setRunning(false);
    onImported();
  };

  const createDriver = async () => {
    const name = newDriver.trim();
    if (!name) return;
    const driver = await onAddDriver(name);
    setDriverId(driver.id);
    setNewDriver('');
  };

  const done = [...rows.values()].filter((row) => row.status === 'done').length;
  const failed = [...rows.values()].filter((row) => row.status === 'error').length;

  return (
    <div className="sheet-backdrop" onClick={() => { if (!running) onClose(); }}>
      <div
        className="sheet glass" role="dialog" aria-modal="true" aria-labelledby="import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <div>
            <h2 id="import-title">Save to archive</h2>
            <p className="muted">
              Drive data is always saved: route, speeds, limits, events and score.
              Video is optional.
            </p>
          </div>
          <button className="icon-toggle" onClick={onClose} disabled={running} aria-label="Close">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3 3 L13 13 M13 3 L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="sheet-options">
          <label className="field">
            <span>Driver</span>
            <select
              value={driverId ?? ''} disabled={running}
              onChange={(event) => setDriverId(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">Not assigned</option>
              {drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
            </select>
          </label>
          <form className="field field--inline" onSubmit={(event) => { event.preventDefault(); void createDriver(); }}>
            <input
              value={newDriver} onChange={(event) => setNewDriver(event.target.value)}
              placeholder="Add a driver" aria-label="New driver's name" disabled={running} maxLength={40}
            />
            <button type="submit" disabled={running || !newDriver.trim()}>Add</button>
          </form>
          <label className="switch">
            <input type="checkbox" checked={withVideo} disabled={running} onChange={(event) => setWithVideo(event.target.checked)} />
            <span className="switch-track" aria-hidden="true" />
            <span>
              Include video
              <small>{videoBytes === null ? 'Sizing…' : `${formatBytes(videoBytes)} for ${selected.length} drive${selected.length === 1 ? '' : 's'}`}</small>
            </span>
          </label>
        </div>

        <div className="sheet-list-head">
          <span>{selected.length} of {ordered.length} selected</span>
          <span className="spacer" />
          <button className="link" disabled={running} onClick={() => setChecked(new Set(ordered.filter((t) => !archived.has(t.id)).map((t) => t.id)))}>Not yet saved</button>
          <button className="link" disabled={running} onClick={() => setChecked(new Set(ordered.map((t) => t.id)))}>All</button>
          <button className="link" disabled={running} onClick={() => setChecked(new Set())}>None</button>
        </div>
        <ul className="sheet-list">
          {ordered.map((trip) => {
            const entry = stats.get(trip.id);
            const ready = entry?.status === 'ready' ? entry : undefined;
            const saved = archived.get(trip.id);
            const row = rows.get(trip.id);
            return (
              <li key={trip.id}>
                <label className="sheet-row">
                  <input type="checkbox" checked={checked.has(trip.id)} disabled={running} onChange={() => toggle(trip.id)} />
                  <RiskRing entry={entry} size={30} />
                  <span className="sheet-row-text">
                    <strong>{formatLocal(trip.startLocalMs, time, WHEN)}</strong>
                    <span className="muted">
                      {ready ? `${metersToMiles(ready.distanceMeters).toFixed(1)} mi` : 'Reading GPS…'}
                      {ready?.startLabel && ` · ${ready.startLabel} → ${ready.endLabel ?? '?'}`}
                    </span>
                  </span>
                  <RowStatus row={row} saved={saved} />
                </label>
              </li>
            );
          })}
        </ul>

        <footer className="sheet-foot">
          {finished && (
            <span className={failed ? 'sheet-result sheet-result--error' : 'sheet-result'}>
              {done} saved{failed ? ` · ${failed} failed` : ''}
            </span>
          )}
          <span className="spacer" />
          {running
            ? <button onClick={() => controller.current?.abort()}>Stop after this upload</button>
            : <button onClick={onClose}>{finished ? 'Done' : 'Cancel'}</button>}
          {!finished && (
            <button className="primary" disabled={running || selected.length === 0} onClick={() => void run()}>
              {running ? 'Saving…' : `Save ${selected.length} drive${selected.length === 1 ? '' : 's'}`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function RowStatus({ row, saved }: { row?: RowState; saved?: ArchivedTrip }) {
  if (row?.status === 'data') return <span className="row-status">Saving data…</span>;
  if (row?.status === 'video') {
    const pct = row.total > 0 ? Math.round((row.sent / row.total) * 100) : 100;
    return (
      <span className="row-status">
        <span className="progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
        {pct}%
      </span>
    );
  }
  if (row?.status === 'done') return <span className="row-status row-status--ok">Saved</span>;
  if (row?.status === 'error') return <span className="row-status row-status--error" title={row.message}>{row.message}</span>;
  if (row?.status === 'waiting') return <span className="row-status">Queued</span>;
  if (saved) {
    const video = saved.clips.some((clip) => clip.stored);
    return <span className="row-status row-status--saved">{video ? 'Saved with video' : 'Saved'}</span>;
  }
  return null;
}
