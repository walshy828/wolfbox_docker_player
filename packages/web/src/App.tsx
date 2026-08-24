import { useCallback, useEffect, useMemo, useState } from 'react';
import { kphToMph, type CleanPoint } from '@wolfbox/telemetry';
import {
  pickCard, partitionTrips, directoryPickerBlocker,
  type Card, type CardTrip,
} from './card.ts';
import { loadTripTrack, pointAt, type TripTrack } from './track.ts';
import { detectPlaybackMode, setPlaybackMode, type PlaybackMode } from './codec.ts';
import { TripList } from './components/TripList.tsx';
import { RouteMap } from './components/RouteMap.tsx';
import { DualPlayer } from './components/DualPlayer.tsx';
import { SummaryPanel } from './components/SummaryPanel.tsx';
import { SpeedLegend } from './components/SpeedLegend.tsx';
import type { Theme } from './speedScale.ts';

export function App() {
  const [card, setCard] = useState<Card | null>(null);
  const [trip, setTrip] = useState<CardTrip | null>(null);
  const [track, setTrack] = useState<TripTrack | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [clockMs, setClockMs] = useState<number | null>(null);
  const [mode, setMode] = useState<PlaybackMode | null>(null);
  const [layout, setLayout] = useState<'split' | 'front' | 'rear'>('split');
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();

  useEffect(() => { void detectPlaybackMode().then(setMode); }, []);

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
    if (!track || !trip) return;
    // Jump to the clip that contains this instant, then into it.
    const index = track.clipStarts.findIndex((starts, i) => {
      const start = starts.front ?? starts.rear;
      const next = track.clipStarts[i + 1];
      const end = next ? (next.front ?? next.rear) : Infinity;
      return start !== undefined && timestampMs >= start && timestampMs < (end ?? Infinity);
    });
    if (index >= 0) setClipIndex(index);
    setClockMs(timestampMs);
  }, [track, trip]);

  const current: CleanPoint | undefined =
    track && clockMs !== null ? pointAt(track.points, clockMs) : undefined;

  const blocker = directoryPickerBlocker();

  return (
    <div className="app" data-theme={theme}>
      <header className="app-bar">
        <h1>WolfBox Player</h1>
        <button className="primary" onClick={openCard} disabled={blocker !== null}>
          {card ? 'Open another card' : 'Open SD card'}
        </button>
        {card && <span className="card-name">{card.name} · {card.clips.length} clips</span>}
        <span className="spacer" />
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
            selectedId={trip?.id ?? null} onSelect={setTrip}
          />

          <div className="workspace">
            {!trip && <p className="muted pad">Choose a trip to review it.</p>}

            {trip && mode && (
              <DualPlayer
                trip={trip} clipStarts={track?.clipStarts ?? []} mode={mode}
                clipIndex={clipIndex} onClipIndexChange={setClipIndex}
                onClock={setClockMs} layout={layout}
              />
            )}

            {trip && (
              <div className="layout-controls" role="group" aria-label="Camera layout">
                {(['split', 'front', 'rear'] as const).map((option) => (
                  <button
                    key={option}
                    className={layout === option ? 'chip selected' : 'chip'}
                    onClick={() => setLayout(option)}
                    aria-pressed={layout === option}
                  >
                    {option === 'split' ? 'Both' : option === 'front' ? 'Front only' : 'Rear only'}
                  </button>
                ))}
              </div>
            )}

            {progress && (
              <p className="notice">
                Reading GPS from clip {progress.done} of {progress.total}...
              </p>
            )}

            {track?.summary && <SummaryPanel summary={track.summary} theme={theme} />}
          </div>

          <aside className="map-column">
            <div className="readout">
              <span className="readout-speed">
                {current ? kphToMph(current.speedKph).toFixed(0) : '--'}
                <small>mph</small>
              </span>
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
