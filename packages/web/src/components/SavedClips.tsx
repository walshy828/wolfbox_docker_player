import { useEffect, useMemo, useState } from 'react';
import {
  saveSegment, deleteSegment, renameSegment, segmentUrl, coveringSources,
  type ArchivedSegment, type SegmentProgress, type SegmentSource,
} from '../archive.ts';
import type { PlaybackMode } from '../codec.ts';
import { formatAbsolute, type TimeContext } from '../time.ts';
import { CollapsibleSection } from './CollapsibleSection.tsx';
import { LENGTHS, clipWindow, type Anchor } from '../segments.ts';
import { ConfirmInline, DeleteButton } from './ConfirmInline.tsx';

const MB = 1024 * 1024;

interface Props {
  tripId: string;
  /** The drive's camera files with their absolute starts. */
  sources: SegmentSource[];
  /** What is on screen now, on the GPS clock. */
  clockMs: number | null;
  saved: ArchivedSegment[];
  mode: PlaybackMode | null;
  time: TimeContext;
  /** Saves the drive's data to history if it is not there yet (a clip needs it). */
  ensureSaved: () => Promise<void>;
  /** The drive changed on the server: reload it. */
  onChanged: () => Promise<void>;
  /** Jumps the main player to an instant. */
  onSeek: (timestampMs: number) => void;
  /** A suggested name, e.g. the moment highlighted on the timeline. */
  suggestedLabel?: string;
}

/**
 * Save part of a drive's video -- 30 s around a hard stop, say -- instead of the
 * whole drive, and watch what was saved. Whole-drive video is still saved from
 * "Save video to history…" in the header.
 */
export function SavedClips({
  tripId, sources, clockMs, saved, mode, time, ensureSaved, onChanged, onSeek, suggestedLabel,
}: Props) {
  const [seconds, setSeconds] = useState<number>(30);
  const [anchor, setAnchor] = useState<Anchor>('around');
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState<SegmentProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [camera, setCamera] = useState<'front' | 'rear'>('front');
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => { setPlaying(null); setError(null); setLabel(''); }, [tripId]);

  const bounds = useMemo(() => {
    if (!sources.length) return null;
    return { startMs: Math.min(...sources.map((s) => s.startMs)), endMs: Math.max(...sources.map((s) => s.startMs)) + 60_000 };
  }, [sources]);
  const window = clockMs !== null && bounds ? clipWindow(clockMs, seconds, anchor, bounds) : null;
  const fromCard = window ? coveringSources(sources, window.startMs, window.endMs).filter((s) => s.file).length : 0;
  const clock = (ms: number) => formatAbsolute(ms, time, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  const save = async () => {
    if (!window) return;
    setError(null);
    setProgress({ phase: 'upload', sentBytes: 0, totalBytes: 0 });
    try {
      await ensureSaved();
      const segment = await saveSegment(tripId, { ...window, label: label.trim() || suggestedLabel }, sources,
        { onProgress: setProgress });
      setLabel('');
      await onChanged();
      setPlaying(segment.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProgress(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteSegment(tripId, id);
      if (playing === id) setPlaying(null);
      setConfirming(null);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const rename = async (segment: ArchivedSegment) => {
    const next = prompt('Name this clip', segment.label ?? '');
    if (next === null) return;
    try {
      await renameSegment(tripId, segment.id, next);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const current = saved.find((s) => s.id === playing);
  const cams = current?.files.map((f) => f.camera) ?? [];
  const shown = cams.includes(camera) ? camera : cams[0];

  return (
    <CollapsibleSection title="Saved clips" count={saved.length || undefined}>
      <div className="saved-clips">
        <div className="saved-clips-form">
          <label>
            Length{' '}
            <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={progress !== null}>
              {LENGTHS.map((s) => <option key={s} value={s}>{s < 60 ? `${s} s` : `${s / 60} min`}</option>)}
            </select>
          </label>
          <div className="segmented" role="group" aria-label="Where the clip sits">
            <button className={anchor === 'around' ? 'selected' : ''} onClick={() => setAnchor('around')} disabled={progress !== null}>Around playhead</button>
            <button className={anchor === 'from' ? 'selected' : ''} onClick={() => setAnchor('from')} disabled={progress !== null}>From playhead</button>
          </div>
          <input
            type="text" placeholder={suggestedLabel ?? 'Name (optional)'} value={label} maxLength={120}
            onChange={(e) => setLabel(e.target.value)} disabled={progress !== null} aria-label="Clip name"
          />
          <button className="primary" onClick={() => void save()} disabled={!window || progress !== null}>
            {progress ? (progress.phase === 'cut' ? 'Cutting…' : `Sending ${Math.round(progress.sentBytes / MB)} of ${Math.round(progress.totalBytes / MB)} MB…`) : 'Save clip'}
          </button>
        </div>
        <p className="muted saved-clips-hint">
          {window
            ? <>Saves {clock(window.startMs)} – {clock(window.endMs)}, front and rear{fromCard ? `; reads ${fromCard} file${fromCard === 1 ? '' : 's'} from the card` : ''}. Only the clip is kept.</>
            : 'Play or seek the video to choose where the clip goes.'}
        </p>
        {error && <p className="notice notice--error">{error}</p>}

        {saved.length > 0 && (
          <ul className="saved-clips-list">
            {saved.map((segment) => (
              <li key={segment.id} className={segment.id === playing ? 'selected' : ''}>
                <button className="link saved-clip-name" onClick={() => setPlaying(segment.id === playing ? null : segment.id)}>
                  {segment.id === playing ? '■' : '▶'} {segment.label || 'Clip'}
                </button>
                <span className="muted">
                  {clock(segment.startMs)} · {Math.round((segment.endMs - segment.startMs) / 1000)} s
                  {' · '}{Math.max(1, Math.round(segment.files.reduce((n, f) => n + f.size, 0) / MB))} MB
                </span>
                <span className="spacer" />
                <button className="link" onClick={() => onSeek(segment.startMs)} title="Jump the main player here">Go to</button>
                <button className="link" onClick={() => void rename(segment)}>Rename</button>
                {confirming === segment.id
                  ? <ConfirmInline question="this clip?" onConfirm={() => void remove(segment.id)} onCancel={() => setConfirming(null)} />
                  : <DeleteButton label="this clip" onClick={() => setConfirming(segment.id)} />}
              </li>
            ))}
          </ul>
        )}

        {current && shown && (
          <div className="saved-clip-player">
            {cams.length > 1 && (
              <div className="segmented" role="group" aria-label="Camera">
                {cams.map((c) => (
                  <button key={c} className={shown === c ? 'selected' : ''} onClick={() => setCamera(c)}>{c === 'front' ? 'Front' : 'Rear'}</button>
                ))}
              </div>
            )}
            <video
              key={`${current.id}-${shown}`} controls autoPlay playsInline
              src={segmentUrl(tripId, current.id, shown, mode === 'transcode')}
            />
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
