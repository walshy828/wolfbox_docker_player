import { clipTime, RATES } from './DualPlayer.tsx';
import { ConfirmInline } from './ConfirmInline.tsx';

/** Dashcams record at 30 fps; matches `FRAME_SEC` in DualPlayer.tsx. */
const FRAME_SEC = 1 / 30;

interface Props {
  playing: boolean;
  position: number;
  duration: number;
  visible: boolean;
  clipIndex: number;
  clipCount: number;
  rate: number;
  confirmingDelete: boolean;
  deleting: boolean;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  /** The pointer resting over the overlay generates no `mousemove` of its own
   * to keep re-arming the auto-hide timer, so DualPlayer needs to know when
   * it's entered and left to pause and resume the countdown around that. */
  onOverlayEnter: () => void;
  onOverlayLeave: () => void;
  onTogglePlay: () => void;
  onSkip: (seconds: number) => void;
  onSeek: (seconds: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  onStepFrame: (frames: number) => void;
  onPrevClip: () => void;
  onNextClip: () => void;
  onRateChange: (rate: number) => void;
  onRequestDelete?: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/**
 * The YouTube-style transport that floats over the video: a progress bar and
 * a row of transport buttons on a bottom scrim, with the less-used speed and
 * delete controls tucked behind a settings gear so the main row stays
 * readable. Purely presentational -- all the playback logic lives in
 * DualPlayer, which also owns whether this is `visible`.
 */
export function PlayerOverlay({
  playing, position, duration, visible, clipIndex, clipCount, rate, confirmingDelete, deleting,
  settingsOpen, onToggleSettings, onOverlayEnter, onOverlayLeave,
  onTogglePlay, onSkip, onSeek, onScrubStart, onScrubEnd, onStepFrame, onPrevClip, onNextClip,
  onRateChange, onRequestDelete, onConfirmDelete, onCancelDelete,
}: Props) {
  return (
    <div
      className={visible ? 'player-overlay player-overlay--visible' : 'player-overlay'}
      onClick={(event) => event.stopPropagation()}
      onMouseEnter={onOverlayEnter}
      onMouseLeave={onOverlayLeave}
    >
      <div className="player-overlay-scrim" />
      <div className="overlay-bar">
        <input
          type="range"
          className="overlay-scrub-range"
          min={0}
          max={duration || 0}
          step={FRAME_SEC}
          value={Math.min(position, duration || 0)}
          disabled={!duration}
          aria-label="Position in clip"
          aria-valuetext={`${clipTime(position)} of ${clipTime(duration)}`}
          onPointerDown={onScrubStart}
          onPointerUp={onScrubEnd}
          onPointerCancel={onScrubEnd}
          onKeyDown={onScrubStart}
          onKeyUp={onScrubEnd}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        <div className="overlay-buttons">
          <button
            className="overlay-icon-button" onClick={onPrevClip} disabled={clipIndex === 0}
            title="Previous clip" aria-label="Previous clip"
          >
            <TrackIcon back />
          </button>
          <button
            className="overlay-icon-button" onClick={() => onSkip(-10)}
            title="Back 10 seconds" aria-label="Back 10 seconds"
          >
            <SkipIcon back />
          </button>
          <button
            className="overlay-icon-button" onClick={() => onStepFrame(-1)}
            title="Back one frame" aria-label="Back one frame"
          >
            <FrameStepIcon back />
          </button>
          <button
            className="overlay-icon-button overlay-icon-button--play" onClick={onTogglePlay}
            title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            className="overlay-icon-button" onClick={() => onStepFrame(1)}
            title="Forward one frame" aria-label="Forward one frame"
          >
            <FrameStepIcon />
          </button>
          <button
            className="overlay-icon-button" onClick={() => onSkip(10)}
            title="Forward 10 seconds" aria-label="Forward 10 seconds"
          >
            <SkipIcon />
          </button>
          <button
            className="overlay-icon-button" onClick={onNextClip} disabled={clipIndex >= clipCount - 1}
            title="Next clip" aria-label="Next clip"
          >
            <TrackIcon />
          </button>
          <span className="overlay-time">{clipTime(position)} / {clipTime(duration)}</span>
          <span className="overlay-clip-position">Clip {clipIndex + 1} of {clipCount}</span>
          <div className="overlay-settings">
            <button
              className={settingsOpen ? 'overlay-icon-button selected' : 'overlay-icon-button'}
              onClick={onToggleSettings}
              aria-expanded={settingsOpen}
              title="Playback settings" aria-label="Playback settings"
            >
              <GearIcon />
            </button>
            {settingsOpen && (
              <div className="overlay-settings-panel">
                <label className="overlay-settings-row">
                  Speed
                  <select value={rate} onChange={(event) => onRateChange(Number(event.target.value))}>
                    {RATES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {onRequestDelete && <div className="overlay-settings-row">
                  {confirmingDelete ? (
                    <ConfirmInline
                      question="this clip?"
                      busy={deleting}
                      onConfirm={onConfirmDelete}
                      onCancel={onCancelDelete}
                    />
                  ) : (
                    <button className="danger" onClick={onRequestDelete}>Delete clip</button>
                  )}
                </div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d="M6 4l10 6-10 6z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <path d="M6 4h3v12H6zM11 4h3v12h-3z" fill="currentColor" />
    </svg>
  );
}

/** A ten-second skip: a circular arrow with the count inside its loop. */
function SkipIcon({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      {/* Mirrored around x=10, so the "10" label below stays upright and centred. */}
      <g transform={back ? undefined : 'scale(-1,1) translate(-20,0)'}>
        <path
          d="M4 6a6 6 0 1 1-1.2 4.2" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round"
        />
        <path d="M4 3v3.4H7.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </g>
      <text x="10" y="13" fontSize="6.5" textAnchor="middle" fill="currentColor">10</text>
    </svg>
  );
}

/** Previous/next clip: a bar and two stacked triangles, the classic media-player skip icon. */
function TrackIcon({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <g transform={back ? undefined : 'scale(-1,1) translate(-20,0)'}>
        <path d="M13 5v10l-7-5z" fill="currentColor" />
        <rect x="14.5" y="5" width="1.7" height="10" fill="currentColor" />
      </g>
    </svg>
  );
}

/** One frame: a small triangle butted against a thin bar, distinct from the track-skip icon. */
function FrameStepIcon({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <g transform={back ? 'scale(-1,1) translate(-20,0)' : undefined}>
        <path
          d="M5 5v10l8-5z" fill="none" stroke="currentColor"
          strokeWidth="1.4" strokeLinejoin="round"
        />
        <rect x="14" y="5" width="1.4" height="10" fill="currentColor" />
      </g>
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="2.6" />
        <path d="M10 3.4v1.7M10 14.9v1.7M16.6 10h-1.7M5.1 10H3.4M14.7 5.3l-1.2 1.2M6.5 13.5l-1.2 1.2M14.7 14.7l-1.2-1.2M6.5 6.5 5.3 5.3" />
      </g>
    </svg>
  );
}
