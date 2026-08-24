import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  pickCard, partitionTrips, directoryPickerBlocker,
  type Card, type CardTrip,
} from './card.ts';
import { loadTripTrack, type TripTrack } from './track.ts';
import { vehicleAt } from './vehicle.ts';
import { detectPlaybackMode, setPlaybackMode, type PlaybackMode } from './codec.ts';
import { TripList, type TripFilter, type TripSort } from './components/TripList.tsx';
import { RouteMap } from './components/RouteMap.tsx';
import { DualPlayer } from './components/DualPlayer.tsx';
import { SummaryPanel } from './components/SummaryPanel.tsx';
import { SpeedLegend } from './components/SpeedLegend.tsx';
import { ExpandButton } from './components/ExpandButton.tsx';
import {
  TIME_ZONES, useTimeZoneSetting, formatLocal, describeCameraDrift, type TimeContext,
} from './time.ts';
import type { Theme } from './speedScale.ts';

/** Which panel, if any, is filling the window. */
type Expanded = 'video' | 'map' | null;

export function App() {
  const [card, setCard] = useState<Card | null>(null);
  const [trip, setTrip] = useState<CardTrip | null>(null);
  const [track, setTrack] = useState<TripTrack | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [clockMs, setClockMs] = useState<number | null>(null);
  const [mode, setMode] = useState<PlaybackMode | null>(null);
  const [layout, setLayout] = useState<'split' | 'front' | 'rear'>('split');
  const [filter, setFilter] = useState<TripFilter>('drives');
  const [sort, setSort] = useState<TripSort>('newest');
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [error, setError] = useState<string | null>(null);
  const [zone, setZone] = useTimeZoneSetting();
  const theme = useTheme();

  const time: TimeContext = useMemo(
    () => ({ zone, cameraUtcOffsetMs: card?.cameraUtcOffsetMs }),
    [zone, card?.cameraUtcOffsetMs],
  );

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

  const { drives, events } = useMemo(
    () => (card ? partitionTrips(card.trips) : { drives: [], events: [] }),
    [card],
  );

  const openCard = useCallback(async () => {
    setError(null);
    try {
      const next = await pickCard();
      if (!next) return;
      setCard(next);
      setTrip(null);
      setTrack(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // Pull the selected trip's telemetry, abandoning it if the user moves on.
  useEffect(() => {
    if (!trip) { setTrack(null); return; }
    const controller = new AbortController();
    setTrack(null);
    setClipIndex(0);
    setClockMs(null);
    setProgress({ done: 0, total: trip.clips.length });

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
    });

    return () => controller.abort();
  }, [trip]);

  const seek = useCallback((timestampMs: number) => {
    if (!track) return;
    const index = track.clipStarts.findIndex((starts, i) => {
      const start = starts.front ?? starts.rear;
      const next = track.clipStarts[i + 1];
      const end = next ? (next.front ?? next.rear) : Infinity;
      return start !== undefined && timestampMs >= start && timestampMs < (end ?? Infinity);
    });
    if (index >= 0) setClipIndex(index);
    setClockMs(timestampMs);
  }, [track]);

  // The same interpolated state the map marker uses, so the readout and the
  // vehicle can never disagree about where the car is.
  const current = track ? vehicleAt(track.points, clockMs) : undefined;

  const blocker = directoryPickerBlocker();
  const drift = describeCameraDrift(card?.cameraUtcOffsetMs);

  return (
    <div className="app" data-theme={theme}>
      <header className="app-bar">
        <h1>WolfBox Player</h1>
        <button className="primary" onClick={openCard} disabled={blocker !== null}>
          {card ? 'Open another card' : 'Open SD card'}
        </button>
        {card && <span className="card-name">{card.name} · {card.clips.length} clips</span>}
        <span className="spacer" />
        <label className="zone-picker">
          Times in
          <select value={zone} onChange={(event) => setZone(event.target.value)}>
            {TIME_ZONES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        {drift && zone !== 'camera' && <span className="badge" title={drift}>{drift}</span>}
        {mode && <PlaybackBadge mode={mode} onOverride={(next) => { setPlaybackMode(next); setMode(next); }} />}
      </header>

      {blocker && <p className="notice notice--error">{blocker}</p>}
      {error && <p className="notice notice--error">{error}</p>}

      {!card && !blocker && (
        <div className="empty-state">
          <h2>Point the app at your dash cam card</h2>
          <p>
            Plug the SD card in, choose <strong>Open SD card</strong>, and pick the card in the
            folder dialog. Nothing is uploaded &mdash; the clips are read straight off the card.
          </p>
        </div>
      )}

      {card && (
        <main className="layout">
          <TripList
            drives={drives} events={events}
            filter={filter} sort={sort}
            onFilterChange={setFilter} onSortChange={setSort}
            selectedId={trip?.id ?? null} onSelect={setTrip}
            time={time}
          />

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
                  {(['split', 'front', 'rear'] as const).map((option) => (
                    <button
                      key={option}
                      className={layout === option ? 'chip selected' : 'chip'}
                      onClick={() => setLayout(option)}
                      aria-pressed={layout === option}
                    >
                      {option === 'split' ? 'Both' : option === 'front' ? 'Front' : 'Rear'}
                    </button>
                  ))}
                </div>
              )}
              <span className="spacer" />
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
                onClock={setClockMs} layout={layout}
              />
            )}

            <div className="workspace-scroll">
              {progress && (
                <p className="notice">
                  Reading GPS from clip {progress.done} of {progress.total}...
                </p>
              )}
              {track?.summary && <SummaryPanel summary={track.summary} theme={theme} time={time} />}
            </div>
          </section>

          <aside className={panelClass('map-column', expanded === 'map')}>
            <div className="readout">
              <div className="readout-main">
                <span className="readout-speed">
                  {current ? current.speedMph.toFixed(0) : '--'}
                  <small>mph</small>
                </span>
                <span className="spacer" />
                <ExpandButton
                  expanded={expanded === 'map'} label="map"
                  onToggle={() => setExpanded(expanded === 'map' ? null : 'map')}
                />
              </div>
              <span className="readout-position">
                {current
                  ? `${current.latitude.toFixed(5)}, ${current.longitude.toFixed(5)}`
                  : 'No GPS fix at this moment'}
              </span>
            </div>
            <RouteMap
              points={track?.points ?? []} cursorMs={clockMs}
              theme={theme} onSeek={seek}
            />
            <SpeedLegend theme={theme} />
          </aside>
        </main>
      )}
    </div>
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
