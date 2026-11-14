import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assessRisk } from '@wolfbox/telemetry';
import {
  pickCard, partitionTrips, directoryPickerBlocker, ensureWritable, removeClipsFromCard, isCardTrip,
  type Card, type CardClip, type CardTrip, type ReviewTrip,
} from './card.ts';
import {
  archiveStatus, listArchived, listDrivers, addDriver, setTripDriver, deleteArchived, toReviewTrip, toStatsEntry,
  type ArchiveStatus, type ArchivedTrip, type Driver,
} from './archive.ts';
import {
  clipsInPair, clipsInTrips, deleteClips, findSuccessorTrip, successorClipIndex, tripTouched,
} from './deletion.ts';
import { loadTripTrack, type TripTrack } from './track.ts';
import { useTripStats } from './tripStats.ts';
import { vehicleAt } from './vehicle.ts';
import { detectPlaybackMode, setPlaybackMode, type PlaybackMode } from './codec.ts';
import { TripList, type TripFilter, type TripSort } from './components/TripList.tsx';
import { RouteMap } from './components/RouteMap.tsx';
import { DualPlayer } from './components/DualPlayer.tsx';
import { ClipStrip } from './components/ClipStrip.tsx';
import { DriveTimeline } from './components/DriveTimeline.tsx';
import { DriveOverview } from './components/DriveOverview.tsx';
import { ImportSheet } from './components/ImportSheet.tsx';
import { ConfirmInline } from './components/ConfirmInline.tsx';
import { SummaryPanel } from './components/SummaryPanel.tsx';
import { AdherencePanel } from './components/AdherencePanel.tsx';
import { SafetyPanel } from './components/SafetyPanel.tsx';
import { GForceMeter } from './components/GForceMeter.tsx';
import { SpeedRamp, SpeedBands } from './components/SpeedLegend.tsx';
import { CollapsibleSection } from './components/CollapsibleSection.tsx';
import { ExpandButton } from './components/ExpandButton.tsx';
import { PinButton } from './components/PinButton.tsx';
import { PanelDock } from './components/PanelDock.tsx';
import { usePinnedPanels } from './panels.ts';
import { useTripLimits, currentLimit } from './limits.ts';
import {
  TIME_ZONES, useTimeZoneSetting, formatLocal, formatAbsolute, describeCameraDrift,
  type TimeContext,
} from './time.ts';
import type { Theme } from './speedScale.ts';

type CameraLayout = 'split' | 'pip' | 'front' | 'rear';

const LAYOUT_LABEL: Record<CameraLayout, [string, string]> = {
  split: ['Both', 'Front and rear side by side'],
  pip: ['PiP', 'Front, with the rear camera inset'],
  front: ['Front', 'Front camera only'],
  rear: ['Rear', 'Rear camera only'],
};

/** Which panel, if any, is filling the window. */
type Expanded = 'video' | 'map' | null;

export function App() {
  const [card, setCard] = useState<Card | null>(null);
  const [trip, setTrip] = useState<ReviewTrip | null>(null);
  /** Where drives come from: the card in the reader, or the archive on the service. */
  const [source, setSource] = useState<'card' | 'archive'>('card');
  /** Null until the service answers; stays null when there is no archive to use. */
  const [archive, setArchive] = useState<ArchiveStatus | null>(null);
  const [archived, setArchived] = useState<ArchivedTrip[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  /** Open while choosing drives to save; holds the drives to start with ticked. */
  const [importing, setImporting] = useState<{ preselected?: string[] } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [track, setTrack] = useState<TripTrack | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [clockMs, setClockMs] = useState<number | null>(null);
  /**
   * A pending seek within the current clip, requested by clicking the route
   * line or another timestamp-driven control. The token forces the player to
   * re-seek even when the click lands back on the clip it's already showing.
   */
  const [seekRequest, setSeekRequest] = useState<
    { clipIndex: number; seconds: number; token: number } | null
  >(null);
  const seekToken = useRef(0);
  const [mode, setMode] = useState<PlaybackMode | null>(null);
  const [layout, setLayout] = useState<CameraLayout>('split');
  const [filter, setFilter] = useState<TripFilter>('drives');
  const [sort, setSort] = useState<TripSort>('newest');
  /** The overview leads with the drives worth watching. */
  const [overviewSort, setOverviewSort] = useState<TripSort>('riskiest');
  const [view, setView] = useState<'drives' | 'review'>('drives');
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  /**
   * Whether the speed-limit panel is open. It gates the lookup: road data is
   * fetched from a third party, so it is asked for only when the panel showing
   * it is actually on screen.
   */
  const [limitsOpen, setLimitsOpen] = useState(true);
  /** Which quantity the route line paints: speed driven, or speed over the limit. */
  const [mapMode, setMapMode] = useState<'speed' | 'excess'>('speed');
  /**
   * The event or over-limit stretch selected from the Safety/Adherence panel,
   * so the map can pick out and fly to where it happened. `key` identifies
   * which row is selected, so clicking it again clears the highlight.
   */
  const [highlight, setHighlight] = useState<{ startMs: number; endMs: number; key: string } | null>(null);
  const onHighlight = useCallback(
    (range: { startMs: number; endMs: number }, key: string) => {
      setHighlight((prev) => (prev?.key === key ? null : { ...range, key }));
    },
    [],
  );
  /**
   * Which clip to land on when the next trip loads. Selecting a trip normally
   * starts it from the beginning, but a delete re-selects the trip the user is
   * already watching, and should not throw away their place in it.
   */
  const resumeClipIndex = useRef<number | null>(null);
  const [zone, setZone] = useTimeZoneSetting();
  const [pinned, setPinned] = usePinnedPanels();
  const theme = useTheme();
  const { status: limitStatus, limits } = useTripLimits(track, limitsOpen);

  // Archived drives carry the offset of the card they came from.
  const cameraUtcOffsetMs = source === 'archive'
    ? (trip?.archived?.cameraOffsetMs ?? archived.find((a) => a.cameraOffsetMs !== null)?.cameraOffsetMs ?? undefined)
    : card?.cameraUtcOffsetMs;
  const time: TimeContext = useMemo(
    () => ({ zone, cameraUtcOffsetMs }),
    [zone, cameraUtcOffsetMs],
  );

  const refreshArchive = useCallback(async () => {
    const status = await archiveStatus();
    setArchive(status);
    if (!status) return;
    try {
      const [trips, people] = await Promise.all([listArchived(), listDrivers()]);
      setArchived(trips);
      setDrivers(people);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => { void refreshArchive(); }, [refreshArchive]);

  useEffect(() => { void detectPlaybackMode().then(setMode); }, []);

  // Escape leaves full screen, which is what every other viewer does.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const cardTrips = useMemo(
    () => (card ? partitionTrips(card.trips) : { drives: [], events: [] }),
    [card],
  );
  // Every trip on the card, not just the one being viewed, so the lists can
  // fill in distance, top speed, score and place names while the user browses.
  const allCardTrips = useMemo(() => [...cardTrips.drives, ...cardTrips.events], [cardTrips]);
  const cardStats = useTripStats(allCardTrips);

  const archivedById = useMemo(() => new Map(archived.map((a) => [a.id, a])), [archived]);
  const archiveTrips = useMemo(() => partitionTrips(archived.map(toReviewTrip)), [archived]);
  const archiveStats = useMemo(
    () => new Map(archived.map((a) => [a.id, toStatsEntry(a)] as const)),
    [archived],
  );

  const { drives, events } = source === 'archive' ? archiveTrips : cardTrips;
  const tripStats = source === 'archive' ? archiveStats : cardStats;
  const archiveOn = archive !== null;

  const openCard = useCallback(async () => {
    setError(null);
    try {
      const next = await pickCard();
      if (!next) return;
      setCard(next);
      setSource('card');
      setTrip(null);
      setView('drives');
      setTrack(null);
      setCheckedIds(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // Pull the selected trip's telemetry, abandoning it if the user moves on.
  useEffect(() => {
    if (!trip) { setTrack(null); return; }
    const controller = new AbortController();
    setTrack(null);
    setClipIndex(resumeClipIndex.current ?? 0);
    resumeClipIndex.current = null;
    setClockMs(null);
    setProgress({ done: 0, total: trip.clips.length });
    // A compliance view of the previous drive must not linger over the new one.
    setMapMode('speed');
    setHighlight(null);

    void loadTripTrack(trip, {
      signal: controller.signal,
      onProgress: (done, total) => setProgress({ done, total }),
    }).then((result) => {
      if (controller.signal.aborted) return;
      setTrack(result);
      setProgress(null);
      // Put the vehicle on the map at the trip's starting point straight away,
      // before anything is played.
      setClockMs((existing) => existing ?? result.points[0]?.timestampMs ?? null);
    }, (cause) => {
      if (controller.signal.aborted) return;
      setProgress(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    setConfirmRemove(false);

    return () => controller.abort();
  }, [trip]);

  /**
   * The one path every delete goes through.
   *
   * Removing clips rebuilds the card's trips from scratch, so the open trip has
   * to be found again rather than trusted: its id moves if it loses its first
   * clip, and a hole in the middle of one splits it in two.
   */
  const removeClips = useCallback(async (clips: CardClip[]) => {
    if (!card || clips.length === 0) return;
    setError(null);
    setDeleting(true);
    try {
      if (!await ensureWritable(card.root)) {
        setError('Deleting needs permission to edit the card. Nothing was deleted.');
        return;
      }

      const { removedKeys, failures } = await deleteClips(card.root, clips);
      if (removedKeys.size > 0) {
        const next = removeClipsFromCard(card, removedKeys);
        setCard(next);

        // Only re-point the workspace when the delete actually reached the trip
        // being watched: every trip object is rebuilt, and swapping in an equal
        // one would reload the video and lose the playhead for nothing.
        if (trip && isCardTrip(trip) && tripTouched(trip, removedKeys)) {
          const successor = findSuccessorTrip(next.trips, trip, removedKeys);
          resumeClipIndex.current =
            successor ? successorClipIndex(successor, trip, clipIndex) : null;
          setTrip(successor);
        }

        const surviving = new Set(next.trips.map((candidate) => candidate.id));
        setCheckedIds((ids) => new Set([...ids].filter((id) => surviving.has(id))));
      }

      if (failures.length > 0) {
        const first = failures[0]!;
        setError(failures.length === 1
          ? `Could not delete ${first.clip.name}: ${first.message}`
          : `Could not delete ${failures.length} files, starting with ${first.clip.name}: ${first.message}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  }, [card, trip, clipIndex]);

  const deleteTrips = useCallback(
    (trips: ReviewTrip[]) => { void removeClips(clipsInTrips(trips.filter(isCardTrip))); },
    [removeClips],
  );

  const deleteClipAt = useCallback((index: number) => {
    if (!trip || !isCardTrip(trip)) return;
    const pair = trip.clips[index];
    if (pair) void removeClips(clipsInPair(pair));
  }, [removeClips, trip]);

  /** Deleting is for the card. An archived drive is removed from the archive instead, from the review header. */
  const canDelete = source === 'card' && trip !== null && isCardTrip(trip);

  const removeFromArchive = useCallback(async (tripId: string) => {
    try {
      await deleteArchived(tripId);
      setTrip(null);
      setView('drives');
      await refreshArchive();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refreshArchive]);

  const changeDriver = useCallback(async (tripId: string, driverId: number | null) => {
    try {
      const updated = await setTripDriver(tripId, driverId);
      setArchived((all) => all.map((a) => (a.id === tripId ? updated : a)));
      setTrip((current) => (current?.id === tripId ? toReviewTrip(updated) : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const switchSource = useCallback((next: 'card' | 'archive') => {
    setSource(next);
    setTrip(null);
    setCheckedIds(new Set());
  }, []);

  const seek = useCallback((timestampMs: number) => {
    if (!track) return;
    const index = track.clipStarts.findIndex((starts, i) => {
      const start = starts.front ?? starts.rear;
      const next = track.clipStarts[i + 1];
      const end = next ? (next.front ?? next.rear) : Infinity;
      return start !== undefined && timestampMs >= start && timestampMs < (end ?? Infinity);
    });
    if (index >= 0) {
      setClipIndex(index);
      const base = track.clipStarts[index]!.front ?? track.clipStarts[index]!.rear;
      if (base !== undefined) {
        seekToken.current += 1;
        setSeekRequest({
          clipIndex: index,
          seconds: Math.max(0, (timestampMs - base) / 1000),
          token: seekToken.current,
        });
      }
    }
    setClockMs(timestampMs);
  }, [track]);

  // The same interpolated state the map marker uses, so the readout and the
  // vehicle can never disagree about where the car is.
  const current = track ? vehicleAt(track.points, clockMs) : undefined;

  // What clock to quote in the readout. The vehicle state's instant is the
  // time the speed and position belong to; with no fix at this moment there is
  // still a playback position worth showing, so fall back to the clock.
  const atMs = current?.timestampMs ?? clockMs;

  const roadLimit = track ? currentLimit(track.points, limits?.adherence, atMs) : undefined;

  // The same function the trip list scores with, so the ring in the list and
  // the gauge on the drive can only differ while limits are still loading.
  const risk = useMemo(
    () => (track?.summary ? assessRisk({ summary: track.summary, adherence: limits?.adherence }) : null),
    [track, limits],
  );

  const openTrip = useCallback((next: ReviewTrip) => { setTrip(next); setView('review'); }, []);

  const blocker = directoryPickerBlocker();
  const drift = describeCameraDrift(card?.cameraUtcOffsetMs);

  const hasSource = source === 'archive' ? archiveOn : card !== null;
  const archivedTrip = trip?.archived ? archivedById.get(trip.id) ?? trip.archived : undefined;
  const savedCopy = trip && !trip.archived ? archivedById.get(trip.id) : undefined;

  return (
    <div className="app" data-theme={theme}>
      <header className="app-bar glass">
        <div className="brand">
          <BrandMark />
          <h1>WolfBox</h1>
        </div>
        {hasSource && (
          <nav className="view-switch" aria-label="View">
            {([['drives', 'Drives'], ['review', 'Review']] as const).map(([value, label]) => (
              <button
                key={value}
                className={view === value ? 'selected' : ''}
                aria-current={view === value ? 'page' : undefined}
                onClick={() => setView(value)}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
        <span className="spacer" />
        {archiveOn && (card || archived.length > 0) && (
          <div className="segmented source-switch" role="group" aria-label="Source">
            <button
              className={source === 'card' ? 'selected' : ''} aria-pressed={source === 'card'}
              disabled={!card} onClick={() => switchSource('card')}
              title={card ? `${card.name} · ${card.clips.length} clips` : 'No card open'}
            >
              SD card
            </button>
            <button
              className={source === 'archive' ? 'selected' : ''} aria-pressed={source === 'archive'}
              onClick={() => switchSource('archive')}
            >
              Archive <span className="count">{archived.length}</span>
            </button>
          </div>
        )}
        {!archiveOn && card && <span className="card-name" title={`${card.clips.length} clips`}>{card.name}</span>}
        <label className="zone-picker">
          <span className="zone-picker-label">Times in</span>
          <select value={zone} onChange={(event) => setZone(event.target.value)}>
            {TIME_ZONES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        {drift && zone !== 'camera' && <span className="badge" title={drift}>{drift}</span>}
        {mode && <PlaybackBadge mode={mode} onOverride={(next) => { setPlaybackMode(next); setMode(next); }} />}
        <button className="primary" onClick={openCard} disabled={blocker !== null}>
          {card ? 'Open card' : 'Open SD card'}
        </button>
      </header>

      {blocker && <p className="notice notice--error">{blocker}</p>}
      {error && <p className="notice notice--error">{error}</p>}

      {!hasSource && !blocker && (
        <div className="empty-state glass">
          <BrandMark size={56} />
          <h2>Review your dash cam drives</h2>
          <p>
            Plug in the SD card and open it. Every drive is scored for speeding, hard
            braking, hard acceleration and sharp turns, so the ones worth watching are at
            the top. Footage is read straight off the card and never uploaded.
          </p>
          <div className="empty-actions">
            <button className="primary large" onClick={openCard}>Open SD card</button>
            {archiveOn && archived.length > 0 && (
              <button className="large" onClick={() => switchSource('archive')}>
                Browse archive · {archived.length} drive{archived.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </div>
      )}

      {hasSource && view === 'drives' && (
        <main className="overview-scroll">
          <DriveOverview
            drives={drives} events={events} stats={tripStats}
            sort={overviewSort} onSortChange={setOverviewSort}
            onOpen={openTrip} time={time} theme={theme}
            source={source}
            archived={archiveOn ? archivedById : undefined}
            onImport={archiveOn && source === 'card' && card ? () => setImporting({}) : undefined}
          />
        </main>
      )}

      {importing && card && (
        <ImportSheet
          drives={cardTrips.drives} preselected={importing.preselected}
          archived={archivedById} stats={cardStats} drivers={drivers}
          onAddDriver={async (name) => {
            const driver = await addDriver(name);
            setDrivers((all) => [...all.filter((d) => d.id !== driver.id), driver].sort((a, b) => a.name.localeCompare(b.name)));
            return driver;
          }}
          cameraOffsetMs={card.cameraUtcOffsetMs}
          time={time}
          onClose={() => setImporting(null)}
          onImported={() => void refreshArchive()}
        />
      )}

      {hasSource && view === 'review' && (
        <main
          className="layout"
          data-trips={pinned.trips ? 'pinned' : 'auto'}
          data-map={pinned.map ? 'pinned' : 'auto'}
        >
          <PanelDock
            side="left" label="Trips"
            pinned={pinned.trips} onPin={() => setPinned('trips', true)}
          >
            <TripList
              drives={drives} events={events}
              filter={filter} sort={sort}
              onFilterChange={setFilter} onSortChange={setSort}
              selectedId={trip?.id ?? null} onSelect={setTrip}
              checkedIds={checkedIds} onCheckedChange={setCheckedIds}
              onDelete={source === 'card' ? deleteTrips : undefined} deleting={deleting}
              time={time} stats={tripStats}
              actions={
                <PinButton
                  pinned={pinned.trips} label="trip list"
                  onToggle={() => setPinned('trips', !pinned.trips)}
                />
              }
            />
          </PanelDock>

          <section className={panelClass('workspace', expanded === 'video')}>
            <div className="panel-head">
              <h2>
                {trip
                  ? formatLocal(trip.startLocalMs, time,
                      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                  : 'No trip selected'}
              </h2>
              {trip && (
                <div className="layout-controls" role="group" aria-label="Camera layout">
                  {(Object.keys(LAYOUT_LABEL) as CameraLayout[]).map((option) => (
                    <button
                      key={option}
                      className={layout === option ? 'chip selected' : 'chip'}
                      onClick={() => setLayout(option)}
                      aria-pressed={layout === option}
                      title={LAYOUT_LABEL[option][1]}
                    >
                      {LAYOUT_LABEL[option][0]}
                    </button>
                  ))}
                </div>
              )}
              <span className="spacer" />
              {trip && (
                <div className="readout-main">
                  <div className="readout-speed-block">
                    <span
                      className={roadLimit?.severity
                        ? `readout-speed readout-speed--${roadLimit.severity}` : 'readout-speed'}
                    >
                      {current ? current.speedMph.toFixed(0) : '--'}
                      <small>mph</small>
                    </span>
                    <span className="readout-limit">
                      {roadLimit
                        ? (Number.isFinite(roadLimit.limitMph)
                            ? `${roadLimit.limitMph.toFixed(0)} mph limit`
                            : 'No limit')
                        : 'Limit unknown'}
                    </span>
                  </div>
                  <span className="readout-when">
                    {atMs === null ? (
                      <span className="readout-clock">--:--</span>
                    ) : (
                      <>
                        <span className="readout-clock">
                          {formatAbsolute(atMs, time,
                            { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                        </span>
                        <span className="readout-date">
                          {formatAbsolute(atMs, time,
                            { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </>
                    )}
                  </span>
                  <GForceMeter points={track?.points ?? []} clockMs={clockMs} theme={theme} />
                </div>
              )}
              {trip && (
                <ExpandButton
                  expanded={expanded === 'video'} label="video"
                  onToggle={() => setExpanded(expanded === 'video' ? null : 'video')}
                />
              )}
            </div>
            {!trip && <p className="muted pad">Choose a trip to review it.</p>}

            {trip && mode && (
              <DualPlayer
                trip={trip} clipStarts={track?.clipStarts ?? []} mode={mode}
                clipIndex={clipIndex} onClipIndexChange={setClipIndex}
                seekRequest={seekRequest}
                onClock={setClockMs} layout={layout}
                onDeleteClip={canDelete ? deleteClipAt : undefined} deleting={deleting}
              />
            )}

            {trip && archiveOn && (
              <div className="archive-bar">
                {archivedTrip ? (
                  <>
                    <span className="archive-pill">Archive</span>
                    <label className="archive-driver">
                      Driver
                      <select
                        value={archivedTrip.driverId ?? ''}
                        onChange={(event) => void changeDriver(trip.id, event.target.value ? Number(event.target.value) : null)}
                      >
                        <option value="">Not assigned</option>
                        {drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
                      </select>
                    </label>
                    <span className="muted">
                      {archivedTrip.clips.some((clip) => clip.stored) ? 'Video saved' : 'Drive data only'}
                    </span>
                    <span className="spacer" />
                    {confirmRemove ? (
                      <ConfirmInline
                        question="this drive from the archive, with any saved video?"
                        busy={false}
                        onConfirm={() => void removeFromArchive(trip.id)}
                        onCancel={() => setConfirmRemove(false)}
                      />
                    ) : (
                      <button className="link danger-link" onClick={() => setConfirmRemove(true)}>Remove from archive</button>
                    )}
                  </>
                ) : (
                  <>
                    <span className={savedCopy ? 'archive-pill archive-pill--saved' : 'archive-pill archive-pill--card'}>
                      {savedCopy ? 'Saved' : 'Only on card'}
                    </span>
                    <span className="muted">
                      {savedCopy
                        ? `In the archive${savedCopy.driverName ? ` · ${savedCopy.driverName}` : ''}${savedCopy.clips.some((c) => c.stored) ? ' · with video' : ''}`
                        : 'This drive will be lost when the card loops over it.'}
                    </span>
                    <span className="spacer" />
                    <button className="chip" onClick={() => setImporting({ preselected: [trip.id] })}>
                      {savedCopy ? 'Save again…' : 'Save to archive…'}
                    </button>
                  </>
                )}
              </div>
            )}

            {track && track.points.length > 1 && (
              <DriveTimeline
                points={track.points}
                events={track.summary?.harshEvents ?? []}
                stretches={limits?.adherence.stretches ?? []}
                limitKph={limits?.adherence.limitKph}
                cursorMs={clockMs} time={time} onSeek={seek}
                onHighlight={onHighlight} selectedKey={highlight?.key}
              />
            )}

            <div className="workspace-scroll">
              {progress && (
                <p className="notice">
                  Reading GPS from clip {progress.done} of {progress.total}...
                </p>
              )}
              {track?.summary && (
                <SummaryPanel
                  summary={track.summary} theme={theme} time={time}
                  limitStatus={limitStatus} risk={risk}
                />
              )}
              {trip && (
                <ClipStrip
                  trip={trip} clipIndex={clipIndex} onSelect={setClipIndex}
                  onDelete={canDelete ? deleteClipAt : undefined} deleting={deleting} time={time}
                />
              )}
            </div>
          </section>

          <PanelDock
            side="right" label="Map"
            pinned={pinned.map} onPin={() => setPinned('map', true)}
          >
            <aside className={panelClass('map-column', expanded === 'map')}>
              <div className="panel-head">
                <h2>Map</h2>
                {trip && (
                  <span className="readout-position">
                    {current
                      ? `${current.latitude.toFixed(5)}, ${current.longitude.toFixed(5)}`
                      : 'No GPS fix'}
                  </span>
                )}
                <span className="spacer" />
                <PinButton
                  pinned={pinned.map} label="map"
                  onToggle={() => setPinned('map', !pinned.map)}
                />
                <ExpandButton
                  expanded={expanded === 'map'} label="map"
                  onToggle={() => setExpanded(expanded === 'map' ? null : 'map')}
                />
              </div>
              <RouteMap
                points={track?.points ?? []} cursorMs={clockMs}
                theme={theme} onSeek={seek}
                mode={mapMode} excessMph={limits?.excessMph}
                events={track?.summary?.harshEvents}
                highlight={highlight}
              />
              <div className="legend">
                <div className="legend-head">
                  <h3>{mapMode === 'excess' ? 'Over the limit' : 'Speed'} <span className="legend-unit">mph</span></h3>
                  {limits?.excessMph && (
                    <div className="legend-modes" role="group" aria-label="Route colour">
                      {([['speed', 'Speed'], ['excess', 'vs limit']] as const).map(([value, label]) => (
                        <button
                          key={value}
                          className={mapMode === value ? 'chip selected' : 'chip'}
                          aria-pressed={mapMode === value}
                          onClick={() => setMapMode(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <SpeedRamp theme={theme} mode={mapMode} />
              </div>
              <div className="map-scroll">
                {track && track.points.length > 0 && (
                  <AdherencePanel
                    status={limitStatus} adherence={limits?.adherence}
                    time={time} onSeek={seek} onOpen={setLimitsOpen}
                    selectedKey={highlight?.key} onHighlight={onHighlight}
                  />
                )}
                {track?.summary && (
                  <SafetyPanel
                    events={track.summary.harshEvents} distanceMeters={track.summary.distanceMeters}
                    tripStartMs={track.summary.startMs} time={time} onSeek={seek}
                    selectedKey={highlight?.key} onHighlight={onHighlight}
                  />
                )}
                <CollapsibleSection title="Legend" defaultOpen={false}>
                  <SpeedBands theme={theme} mode={mapMode} />
                </CollapsibleSection>
              </div>
            </aside>
          </PanelDock>
        </main>
      )}
    </div>
  );
}

function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="brand-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5ac8fa" />
          <stop offset="1" stopColor="#0a63ff" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#brand-grad)" />
      <path d="M8 20.5 C11 13, 16 11.5, 24 12" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="24" cy="12" r="2.6" fill="#fff" />
      <circle cx="8" cy="20.5" r="2" fill="#fff" opacity="0.7" />
    </svg>
  );
}

const panelClass = (base: string, expanded: boolean) =>
  expanded ? `${base} panel panel--expanded` : `${base} panel`;

function PlaybackBadge({ mode, onOverride }: { mode: PlaybackMode; onOverride: (m: PlaybackMode) => void }) {
  if (mode === 'direct') {
    return <span className="badge badge--ok" title="Your browser decodes the camera's HEVC directly.">
      Direct playback
    </span>;
  }
  return (
    <span className="badge badge--warn">
      Converting video
      <button
        className="link"
        title="This browser reports no HEVC decoder, so clips are converted by the local service before playing."
        onClick={() => onOverride('direct')}
      >
        try direct
      </button>
    </span>
  );
}

/** Follows the viewer's colour scheme; the speed ramp has steps for each. */
function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setTheme(query.matches ? 'dark' : 'light');
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return theme;
}
