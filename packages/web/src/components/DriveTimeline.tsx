import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  kphToMph, type CleanPoint, type HarshEvent, type OverLimitStretch,
} from '@wolfbox/telemetry';
import { formatAbsolute, type TimeContext } from '../time.ts';
import { buildMoments, nearestIndex, neighbourMoment, speedPath, limitPath, type Moment } from '../timeline.ts';

/**
 * The whole drive along one strip under the video: speed as a filled trace,
 * the limit as a stepped line above it, every sustained speeding stretch as a
 * red band and every hard stop, launch and sharp turn as a marker.
 *
 * It exists because the question a parent brings to a drive is "show me the
 * bad bits", and before this the bad bits lived in lists in a side panel.
 * Here they sit on the same time axis as the playhead, so the next one is
 * visible coming, and a click -- or the previous/next buttons, or `[` and `]`
 * -- puts the video there.
 */

const W = 1000;
const H = 56;

export function DriveTimeline({
  points, events, stretches, limitKph, cursorMs, time, onSeek, onHighlight, selectedKey,
}: {
  points: CleanPoint[];
  events: HarshEvent[];
  stretches: OverLimitStretch[];
  /** The limit at each point, aligned with `points`. Undefined where unknown. */
  limitKph?: (number | undefined)[];
  cursorMs: number | null;
  time: TimeContext;
  onSeek: (timestampMs: number) => void;
  onHighlight: (range: { startMs: number; endMs: number }, key: string) => void;
  selectedKey?: string | null;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const startMs = points[0]?.timestampMs ?? 0;
  const endMs = points.at(-1)?.timestampMs ?? 0;
  const span = Math.max(1, endMs - startMs);

  const { area, limit, topKph } = useMemo(() => {
    const finiteLimits = (limitKph ?? []).filter((kph): kph is number => kph !== undefined && Number.isFinite(kph));
    const top = Math.max(40, ...points.map((p) => p.smoothedSpeedKph), ...finiteLimits) * 1.08;
    return {
      topKph: top,
      area: speedPath(points, startMs, span, top, W, H),
      limit: limitKph ? limitPath(points, limitKph, startMs, span, top, W, H) : '',
    };
  }, [points, limitKph, startMs, span]);

  const moments = useMemo(() => buildMoments(events, stretches, startMs), [events, stretches, startMs]);

  // `[` and `]` step through moments from anywhere on the page, not only with
  // the timeline focused -- the video usually has focus while reviewing.
  const stepRef = useRef<(direction: 1 | -1) => void>(() => {});
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '[' && event.key !== ']') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      stepRef.current(event.key === ']' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (points.length < 2) return null;

  const pct = (ms: number) => `${((ms - startMs) / span) * 100}%`;
  const msAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return startMs + x * span;
  };

  const go = (moment: Moment) => {
    onSeek(moment.seekMs);
    onHighlight({ startMs: moment.startMs, endMs: moment.endMs }, moment.key);
  };
  const step = (direction: 1 | -1) => {
    const next = neighbourMoment(moments, cursorMs ?? startMs, direction);
    if (next) go(next);
  };
  stepRef.current = step;

  const hover = hoverMs === null ? null : points[nearestIndex(points, hoverMs)];
  const hoverLimit = hover && limitKph ? limitKph[nearestIndex(points, hoverMs!)] : undefined;
  const clock = (ms: number) => formatAbsolute(ms, time, { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="timeline">
      <div className="timeline-head">
        <span className="timeline-title">
          {moments.length === 0 ? 'Nothing flagged on this drive' : `${moments.length} moment${moments.length === 1 ? '' : 's'} to review`}
        </span>
        <span className="timeline-legend" aria-hidden="true">
          <span className="timeline-key timeline-key--speed">Speed</span>
          {limit && <span className="timeline-key timeline-key--limit">Limit</span>}
          {stretches.length > 0 && <span className="timeline-key timeline-key--over">Over limit</span>}
        </span>
        <span className="spacer" />
        <div className="timeline-nav" role="group" aria-label="Step through flagged moments">
          <button className="chip" onClick={() => step(-1)} disabled={moments.length === 0} title="Previous moment ( [ )">
            &lsaquo; Prev
          </button>
          <button className="chip" onClick={() => step(1)} disabled={moments.length === 0} title="Next moment ( ] )">
            Next &rsaquo;
          </button>
        </div>
      </div>

      <div
        ref={trackRef}
        className="timeline-track"
        onPointerMove={(event: PointerEvent) => setHoverMs(msAt(event.clientX))}
        onPointerLeave={() => setHoverMs(null)}
        onClick={(event) => onSeek(msAt(event.clientX))}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {stretches.map((stretch) => (
            <rect
              key={stretch.startMs}
              className={`timeline-over timeline-over--${stretch.severity}`}
              x={((stretch.startMs - startMs) / span) * W}
              width={Math.max(2, (stretch.durationSec * 1000 / span) * W)}
              y={0} height={H}
            />
          ))}
          <path className="timeline-speed" d={area} />
          {limit && <path className="timeline-limit" d={limit} />}
        </svg>

        {moments.map((moment) => (
          <button
            key={moment.key}
            className={[
              'timeline-mark',
              `timeline-mark--${moment.kind}`,
              `timeline-mark--${moment.severity}`,
              moment.key === selectedKey ? 'selected' : '',
            ].join(' ')}
            style={{ left: pct(moment.startMs) }}
            title={`${moment.label} at ${clock(moment.startMs)}`}
            aria-label={`${moment.label} at ${clock(moment.startMs)}`}
            onClick={(event) => { event.stopPropagation(); go(moment); }}
          />
        ))}

        {cursorMs !== null && cursorMs >= startMs && cursorMs <= endMs && (
          <span className="timeline-playhead" style={{ left: pct(cursorMs) }} />
        )}
        {hover && hoverMs !== null && (
          <span className="timeline-hover" style={{ left: pct(hoverMs) }}>
            <span className="timeline-tip">
              {clock(hover.timestampMs)} &middot; {Math.round(kphToMph(hover.smoothedSpeedKph))} mph
              {hoverLimit !== undefined && Number.isFinite(hoverLimit) && ` / ${Math.round(kphToMph(hoverLimit))}`}
            </span>
          </span>
        )}
      </div>

      <div className="timeline-axis" aria-hidden="true">
        <span>{clock(startMs)}</span>
        <span>{Math.round(kphToMph(topKph / 1.08))} mph peak scale</span>
        <span>{clock(endMs)}</span>
      </div>
    </div>
  );
}
