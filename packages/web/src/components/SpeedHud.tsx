import type { CleanPoint } from '@wolfbox/telemetry';
import { GForceMeter } from './GForceMeter.tsx';
import { formatAbsolute, type TimeContext } from '../time.ts';

/**
 * Speed, the road's limit, the time and the g-force, laid over the top-left
 * corner of the video like a dash display.
 *
 * These used to sit in the panel header, which cost a full-height row above
 * the picture and put the numbers a long way from the footage they describe.
 * On the video they read together with what is happening, they come along
 * into full screen, and the header is left free for the review actions.
 * The rear camera's inset sits in the opposite corner, so the two never meet.
 */
export function SpeedHud({
  speedMph, severity, limitMph, limitKnown, atMs, time, points, clockMs,
}: {
  speedMph?: number;
  /** How far over the limit, once it is a sustained stretch. */
  severity?: 'minor' | 'moderate' | 'severe';
  /** The limit here; Infinity for an unlimited road. */
  limitMph?: number;
  /** False while limits are loading or unavailable. */
  limitKnown: boolean;
  atMs: number | null;
  time: TimeContext;
  points: CleanPoint[];
  clockMs: number | null;
}) {
  const hasLimit = limitKnown && limitMph !== undefined && Number.isFinite(limitMph);
  return (
    <div className="hud" aria-label="Speed and time at this moment">
      <div
        className={hasLimit ? 'hud-limit' : 'hud-limit hud-limit--unknown'}
        title={!limitKnown ? 'Speed limit unknown here'
          : hasLimit ? `${limitMph!.toFixed(0)} mph limit` : 'No posted limit'}
      >
        <span className="hud-limit-caption">LIMIT</span>
        <span className="hud-limit-value">{hasLimit ? limitMph!.toFixed(0) : '–'}</span>
      </div>
      <div className="hud-main">
        <span className={severity && severity !== 'minor' ? `hud-speed hud-speed--${severity}` : 'hud-speed'}>
          {speedMph !== undefined ? speedMph.toFixed(0) : '--'}
          <small>mph</small>
        </span>
        <span className="hud-clock">
          {atMs === null ? '--:--' : formatAbsolute(atMs, time, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
      <GForceMeter points={points} clockMs={clockMs} theme="dark" />
    </div>
  );
}
