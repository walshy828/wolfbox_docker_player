import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardTrip } from '../card.ts';
import type { PlaybackMode } from '../codec.ts';
import { openClip, type ClipSource } from '../clipSource.ts';

/** Beyond this the slaved camera is seeked; under it, nudged by playback rate. */
const SYNC_TOLERANCE_SEC = 0.12;
/** Proxy width used when transcoding. Two 4K panes side by side help nobody. */
const PROXY_WIDTH = 1280;

interface Props {
  trip: CardTrip;
  clipStarts: { front?: number; rear?: number }[];
  mode: PlaybackMode;
  clipIndex: number;
  onClipIndexChange: (index: number) => void;
  /** Fires continuously with the absolute instant currently on screen. */
  onClock: (timestampMs: number | null) => void;
  layout: 'split' | 'front' | 'rear';
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
  trip, clipStarts, mode, clipIndex, onClipIndexChange, onClock, layout,
}: Props) {
  const frontRef = useRef<HTMLVideoElement>(null);
  const rearRef = useRef<HTMLVideoElement>(null);
  const [sources, setSources] = useState<{ front?: string; rear?: string }>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const pair = trip.clips[clipIndex];
  const starts = clipStarts[clipIndex] ?? {};

  // Load the current clip pair.
  useEffect(() => {
    if (!pair) return;
    const controller = new AbortController();
    const opened: ClipSource[] = [];
    let cancelled = false;

    setLoading(true);
    setError(null);

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
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const base = starts.front ?? starts.rear;
      onClock(base === undefined ? null : base + front.currentTime * 1000);

      const rear = rearRef.current;
      if (!rear || rear.readyState < 2 || starts.front === undefined || starts.rear === undefined) return;

      // Where the rear file should be for the instant the front is showing.
      const target = (starts.front - starts.rear) / 1000 + front.currentTime;
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

  const both = useCallback((run: (video: HTMLVideoElement) => void) => {
    for (const ref of [frontRef, rearRef]) if (ref.current) run(ref.current);
  }, []);

  const togglePlay = useCallback(() => {
    const front = frontRef.current;
    if (!front) return;
    if (front.paused) { void front.play(); void rearRef.current?.play(); setPlaying(true); }
    else { front.pause(); rearRef.current?.pause(); setPlaying(false); }
  }, []);

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

  useEffect(() => {
    const front = frontRef.current;
    if (!front || !playing || !sources.front) return;
    // Autoplay through a clip boundary once the new file is ready.
    const start = () => { void front.play(); void rearRef.current?.play(); };
    front.addEventListener('canplay', start, { once: true });
    return () => front.removeEventListener('canplay', start);
  }, [sources, playing]);

  if (!pair) return <div className="player-empty">No clip selected.</div>;

  return (
    <div className="player">
      <div className={`player-grid player-grid--${layout}`}>
        {layout !== 'rear' && (
          <figure className="pane">
            <video
              ref={frontRef} src={sources.front} playsInline preload="auto"
              onEnded={handleEnded}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            />
            <figcaption>Front{sources.front ? '' : ' - unavailable'}</figcaption>
          </figure>
        )}
        {layout !== 'front' && (
          <figure className="pane">
            <video ref={rearRef} src={sources.rear} playsInline preload="auto" muted />
            <figcaption>Rear{sources.rear ? '' : ' - unavailable'}</figcaption>
          </figure>
        )}
      </div>

      {loading && (
        <p className="player-status">
          {mode === 'transcode'
            ? 'Converting this clip so your browser can play it...'
            : 'Loading clip...'}
        </p>
      )}
      {error && <p className="player-status player-status--error">{error}</p>}

      <div className="player-controls">
        <button onClick={() => onClipIndexChange(Math.max(0, clipIndex - 1))} disabled={clipIndex === 0}>
          Previous clip
        </button>
        <button onClick={() => skip(-10)}>-10s</button>
        <button className="primary" onClick={togglePlay}>{playing ? 'Pause' : 'Play'}</button>
        <button onClick={() => skip(10)}>+10s</button>
        <button
          onClick={() => onClipIndexChange(Math.min(trip.clips.length - 1, clipIndex + 1))}
          disabled={clipIndex >= trip.clips.length - 1}
        >
          Next clip
        </button>
        <label className="player-rate">
          Speed
          <select
            defaultValue="1"
            onChange={(event) => both((video) => { video.playbackRate = Number(event.target.value); })}
          >
            {['0.5', '1', '1.5', '2', '4'].map((rate) => (
              <option key={rate} value={rate}>{rate}x</option>
            ))}
          </select>
        </label>
        <span className="player-position">Clip {clipIndex + 1} of {trip.clips.length}</span>
      </div>
    </div>
  );
}
