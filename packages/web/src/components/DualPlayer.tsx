import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { CardTrip } from '../card.ts';
import type { PlaybackMode } from '../codec.ts';
import { openClip, type ClipSource } from '../clipSource.ts';
import { PlayerOverlay } from './PlayerOverlay.tsx';

/** Beyond this the slaved camera is seeked; under it, nudged by playback rate. */
const SYNC_TOLERANCE_SEC = 0.12;
/**
 * How often the clock is published. Telemetry is only 1 Hz, so reporting every
 * animation frame would re-render the map and readout 60 times a second to show
 * the same values.
 */
const CLOCK_INTERVAL_MS = 200;
/** Proxy width used when transcoding. Two 4K panes side by side help nobody. */
const PROXY_WIDTH = 1280;
/**
 * How often the scrub bar's position is refreshed. Faster than the telemetry
 * clock because a handle that steps five times a second reads as broken, and
 * the bar is cheap to move -- nothing downstream depends on it.
 */
const SCRUB_INTERVAL_MS = 80;
/**
 * Dashcams record at 30 fps, so this is one frame. Nothing exposes the real
 * frame rate to script, and stepping slightly past a frame boundary still
 * lands on the next frame, which is what stepping is for.
 */
const FRAME_SEC = 1 / 30;
/**
 * Playback rates, slowest first. Below about 0.06 browsers mute the audio and
 * some refuse the rate outright; 0.1 is the slowest that plays everywhere, and
 * is slow enough to read a plate as it goes by.
 */
export const RATES = [
  { value: 0.1, label: '0.1x super slow' },
  { value: 0.25, label: '0.25x slow' },
  { value: 0.5, label: '0.5x' },
  { value: 1, label: '1x' },
  { value: 1.5, label: '1.5x' },
  { value: 2, label: '2x' },
  { value: 4, label: '4x' },
];

/** m:ss, for the scrub bar's readouts. */
export function clipTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

interface Props {
  trip: CardTrip;
  clipStarts: { front?: number; rear?: number }[];
  mode: PlaybackMode;
  clipIndex: number;
  onClipIndexChange: (index: number) => void;
  /**
   * A pending seek to an exact offset within `clipIndex`'s clip. A new `token`
   * re-applies the seek even if `clipIndex` and `seconds` are unchanged, so
   * clicking the same spot on the route line twice still snaps the video back.
   */
  seekRequest: { clipIndex: number; seconds: number; token: number } | null;
  /** Fires continuously with the absolute instant currently on screen. */
  onClock: (timestampMs: number | null) => void;
  layout: 'split' | 'front' | 'rear';
  /** Deletes the clip on screen, front and rear together. */
  onDeleteClip: (index: number) => void;
  deleting: boolean;
}

/**
 * Plays a trip's front and rear cameras together.
 *
 * The front camera is the clock and the rear is slaved to it. The two files are
 * aligned by their embedded GPS timestamps rather than by position in the file:
 * the cameras start independently, so the same wall-clock second sits at a
 * different offset in each. Small drift is corrected by easing `playbackRate`,
 * which is inaudible, and only a real divergence forces a seek.
 */
export function DualPlayer({
  trip, clipStarts, mode, clipIndex, onClipIndexChange, seekRequest, onClock, layout,
  onDeleteClip, deleting,
}: Props) {
  const frontRef = useRef<HTMLVideoElement>(null);
  const rearRef = useRef<HTMLVideoElement>(null);
  const [sources, setSources] = useState<{ front?: string; rear?: string }>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** Whether the overlay transport is on screen. Always true while paused. */
  const [controlsVisible, setControlsVisible] = useState(true);
  /** Whether the settings popover (speed, delete) is open. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  /** Set on every pointerdown, so a tap can be told apart from a click. */
  const lastPointerType = useRef<string>('mouse');
  /** Where the playhead is, and how long the clip runs, for the scrub bar. */
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  /**
   * True while the scrub handle is held. The clock loop must not write the
   * handle back to the video's position underneath a dragging finger.
   */
  const scrubbing = useRef(false);
  /**
   * True while the current clip's files are being swapped in. Pointing a video
   * element at a new `src` makes it fire `pause`, and taking that at face value
   * would clear the intent to keep playing at exactly the moment a trip rolls
   * into its next clip.
   */
  const swapping = useRef(false);

  const pair = trip.clips[clipIndex];
  const starts = clipStarts[clipIndex] ?? {};

  // A confirmation, or an open settings popover, must never outlive the clip
  // it was asked about: trips roll into the next clip on their own as one ends.
  useEffect(() => { setConfirmingDelete(false); setSettingsOpen(false); }, [pair]);

  // Load the current clip pair.
  useEffect(() => {
    if (!pair) return;
    const controller = new AbortController();
    const opened: ClipSource[] = [];
    let cancelled = false;

    setLoading(true);
    setError(null);
    swapping.current = true;

    (async () => {
      try {
        const next: { front?: string; rear?: string } = {};
        for (const camera of ['front', 'rear'] as const) {
          const clip = pair[camera];
          if (!clip) continue;
          const source = await openClip(clip.handle, mode, {
            width: PROXY_WIDTH, signal: controller.signal,
          });
          opened.push(source);
          next[camera] = source.url;
        }
        if (!cancelled) setSources(next);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      for (const source of opened) source.release();
    };
  }, [pair, mode]);

  // Report the absolute instant on screen, and keep the rear camera aligned.
  useEffect(() => {
    const front = frontRef.current;
    if (!front) return;

    let frame = 0;
    let lastPublished = 0;
    let lastScrub = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);

      const now = performance.now();
      if (now - lastScrub >= SCRUB_INTERVAL_MS && !scrubbing.current) {
        lastScrub = now;
        setPosition(front.currentTime);
      }
      if (now - lastPublished >= CLOCK_INTERVAL_MS) {
        lastPublished = now;
        // A clip whose telemetry never got a fix has no anchor, and NaN here
        // would silently freeze every downstream lookup rather than clear it.
        const base = starts.front ?? starts.rear;
        onClock(Number.isFinite(base) ? base! + front.currentTime * 1000 : null);
      }

      const rear = rearRef.current;
      if (!rear || rear.readyState < 2) return;
      if (!Number.isFinite(starts.front) || !Number.isFinite(starts.rear)) return;

      // Where the rear file should be for the instant the front is showing.
      const target = (starts.front! - starts.rear!) / 1000 + front.currentTime;
      if (target < 0 || target > rear.duration) return;
      const drift = target - rear.currentTime;

      if (Math.abs(drift) > SYNC_TOLERANCE_SEC) {
        rear.currentTime = target;
        rear.playbackRate = front.playbackRate;
      } else {
        // Ease back rather than seeking, which would stutter the picture.
        rear.playbackRate = front.playbackRate * (1 + Math.max(-0.05, Math.min(0.05, drift)));
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [starts.front, starts.rear, onClock, sources]);

  // Jump to an exact point within the clip -- e.g. a click on the route line --
  // rather than leaving the video wherever the clip swap left it. The clip may
  // still be loading its new source, so the seek waits for metadata if needed.
  useEffect(() => {
    if (!seekRequest || seekRequest.clipIndex !== clipIndex) return;
    const front = frontRef.current;
    if (!front) return;
    const apply = () => {
      front.currentTime = seekRequest.seconds;
      setPosition(seekRequest.seconds);
    };
    if (front.readyState >= 1) { apply(); return; }
    front.addEventListener('loadedmetadata', apply, { once: true });
    return () => front.removeEventListener('loadedmetadata', apply);
  }, [seekRequest, clipIndex, sources]);

  // Only a real pause stops playback: not the `src` swap between clips, and not
  // the pause a browser fires as a clip reaches its end.
  const handlePause = useCallback(() => {
    if (swapping.current) return;
    if (frontRef.current?.ended) return;
    setPlaying(false);
  }, []);

  const both = useCallback((run: (video: HTMLVideoElement) => void) => {
    for (const ref of [frontRef, rearRef]) if (ref.current) run(ref.current);
  }, []);

  /**
   * Reveals the overlay transport and, only while playing and no popover is
   * open, arms a timer to fade it back out. Paused playback has no timer, so
   * the controls stay put -- there's nothing moving underneath them to
   * watch -- and neither does an open settings popover, which would
   * otherwise vanish out from under someone reading it.
   */
  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    if (playing && !settingsOpen) hideTimer.current = setTimeout(() => setControlsVisible(false), 2500);
  }, [playing, settingsOpen]);

  // Whenever playback starts/stops or the settings popover opens/closes,
  // re-evaluate: starting arms the auto-hide timer, stopping or opening the
  // popover cancels it and leaves the controls up.
  useEffect(() => { showControls(); }, [playing, settingsOpen, showControls]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  /** While the pointer rests over the overlay itself, don't count down -- a
   * still pointer generates no `mousemove` to keep re-arming the timer. */
  const pauseHideTimer = useCallback(() => { clearTimeout(hideTimer.current); }, []);

  const togglePlay = useCallback(() => {
    const front = frontRef.current;
    if (!front) return;
    if (front.paused) { void front.play(); void rearRef.current?.play(); setPlaying(true); }
    else { front.pause(); rearRef.current?.pause(); setPlaying(false); }
  }, []);

  /**
   * Click/tap on the video itself. A touch tap while the overlay is hidden
   * only reveals it -- matching how YouTube's mobile player treats a first
   * tap as "show me the controls" rather than "pause the video I can't see
   * a scrubber on yet". Any other click toggles play/pause directly.
   */
  const handleStageClick = useCallback(() => {
    if (lastPointerType.current === 'touch' && !controlsVisible) { showControls(); return; }
    togglePlay();
  }, [togglePlay, showControls, controlsVisible]);

  const handleStagePointerDown = useCallback((event: PointerEvent) => {
    lastPointerType.current = event.pointerType;
  }, []);

  const handleStageKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault();
    togglePlay();
  }, [togglePlay]);

  const skip = useCallback((seconds: number) => {
    const front = frontRef.current;
    if (!front) return;
    const next = front.currentTime + seconds;
    if (next < 0 && clipIndex > 0) { onClipIndexChange(clipIndex - 1); return; }
    if (next > front.duration && clipIndex < trip.clips.length - 1) {
      onClipIndexChange(clipIndex + 1);
      return;
    }
    front.currentTime = Math.max(0, Math.min(front.duration || 0, next));
  }, [clipIndex, onClipIndexChange, trip.clips.length]);

  // Roll into the next clip so a trip plays end to end.
  const handleEnded = useCallback(() => {
    if (clipIndex < trip.clips.length - 1) onClipIndexChange(clipIndex + 1);
    else setPlaying(false);
  }, [clipIndex, onClipIndexChange, trip.clips.length]);

  // Autoplay through a clip boundary once the new file is ready, so a trip --
  // a drive or a group of parking events -- plays from end to end.
  useEffect(() => {
    const front = frontRef.current;
    if (!front || !sources.front) return;
    const start = () => {
      swapping.current = false;
      if (!playing) return;
      void front.play();
      void rearRef.current?.play();
    };
    if (front.readyState >= 3) { start(); return; }
    front.addEventListener('canplay', start, { once: true });
    return () => front.removeEventListener('canplay', start);
  }, [sources, playing]);

  // Loading a file resets `playbackRate` to `defaultPlaybackRate`, so the rate
  // is written to both: setting the live one alone would be undone by the very
  // clip swap it needs to survive, and slow motion would quietly end at the
  // boundary -- which is exactly where you were watching closely.
  useEffect(() => {
    both((video) => {
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
    });
  }, [both, rate, sources]);

  const seekTo = useCallback((seconds: number) => {
    const front = frontRef.current;
    if (!front) return;
    const target = Math.max(0, Math.min(front.duration || 0, seconds));
    front.currentTime = target;
    setPosition(target);
  }, []);

  /**
   * Nudge by a single frame, paused.
   *
   * Stepping while playing would be undone by the next frame the video renders
   * on its own, so a step pauses first. The rear camera is left to the sync
   * loop, which seeks it once the step puts it out of tolerance.
   */
  const stepFrame = useCallback((frames: number) => {
    const front = frontRef.current;
    if (!front) return;
    front.pause();
    rearRef.current?.pause();
    setPlaying(false);
    seekTo(front.currentTime + frames * FRAME_SEC);
  }, [seekTo]);

  if (!pair) return <div className="player-empty">No clip selected.</div>;

  return (
    <div className="player">
      <div
        className="player-stage"
        onMouseMove={showControls}
        onMouseEnter={showControls}
        onMouseLeave={() => { if (playing) setControlsVisible(false); }}
      >
        <div className={`player-grid player-grid--${layout}`}>
          {/*
            Both elements stay mounted whatever the layout: the front camera is the
            clock and the only source of `ended`, so unmounting it in the rear-only
            layout would leave the transport with nothing to drive.
          */}
          <figure className={paneClass(layout === 'rear')}>
            <video
              ref={frontRef} src={sources.front} playsInline preload="auto"
              onEnded={handleEnded}
              onLoadedMetadata={(event) => {
                setDuration(event.currentTarget.duration);
                setPosition(event.currentTarget.currentTime);
              }}
              onPlay={() => setPlaying(true)} onPause={handlePause}
            />
            <figcaption>Front{sources.front ? '' : ' - unavailable'}</figcaption>
          </figure>
          <figure className={paneClass(layout === 'front')}>
            <video ref={rearRef} src={sources.rear} playsInline preload="auto" muted />
            <figcaption>Rear{sources.rear ? '' : ' - unavailable'}</figcaption>
          </figure>
        </div>

        {/*
          A transparent button the size of the whole stage: clicking or
          tapping the video toggles play/pause, same as YouTube. It sits above
          the video but below the overlay bar, so dragging the scrub bar or
          pressing a transport button doesn't also toggle playback.
        */}
        <button
          type="button"
          className="player-click-catcher"
          onClick={handleStageClick}
          onPointerDown={handleStagePointerDown}
          onKeyDown={handleStageKeyDown}
          aria-label={playing ? 'Pause' : 'Play'}
        />

        {/*
          The overlay transport. Bound to the front camera only: it is the
          clock, and the rear follows it through the sync loop, so playing,
          pausing or seeking one plays, pauses or seeks both.
        */}
        <PlayerOverlay
          playing={playing}
          position={position}
          duration={duration}
          visible={controlsVisible}
          clipIndex={clipIndex}
          clipCount={trip.clips.length}
          rate={rate}
          confirmingDelete={confirmingDelete}
          deleting={deleting}
          settingsOpen={settingsOpen}
          onToggleSettings={() => setSettingsOpen((open) => !open)}
          onOverlayEnter={pauseHideTimer}
          onOverlayLeave={showControls}
          onTogglePlay={togglePlay}
          onSkip={skip}
          onSeek={seekTo}
          onScrubStart={() => { scrubbing.current = true; }}
          onScrubEnd={() => { scrubbing.current = false; }}
          onStepFrame={stepFrame}
          onPrevClip={() => onClipIndexChange(Math.max(0, clipIndex - 1))}
          onNextClip={() => onClipIndexChange(Math.min(trip.clips.length - 1, clipIndex + 1))}
          onRateChange={setRate}
          onRequestDelete={() => setConfirmingDelete(true)}
          onConfirmDelete={() => { setConfirmingDelete(false); onDeleteClip(clipIndex); }}
          onCancelDelete={() => setConfirmingDelete(false)}
        />
      </div>

      {loading && (
        <p className="player-status">
          {mode === 'transcode'
            ? 'Converting this clip so your browser can play it...'
            : 'Loading clip...'}
        </p>
      )}
      {error && <p className="player-status player-status--error">{error}</p>}
    </div>
  );
}

const paneClass = (hidden: boolean) => (hidden ? 'pane pane--hidden' : 'pane');
