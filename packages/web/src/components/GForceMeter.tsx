import type { CleanPoint } from '@wolfbox/telemetry';
import { accelAt } from '../accel.ts';
import { colorForG, gVectorToPoint, MODERATE_G, SEVERE_G, TOP_G } from '../accelScale.ts';
import type { Theme } from '../speedScale.ts';

export interface GForceMeterProps {
  points: CleanPoint[];
  clockMs: number | null;
  theme: Theme;
}

const SIZE = 64;
const CENTER = SIZE / 2;
const RADIUS = CENTER - 6;
const RING_STOPS = [MODERATE_G, SEVERE_G, TOP_G];

/**
 * Live braking/acceleration and lateral force, aligned to video playback.
 *
 * A single bullseye: the dot deflects up for acceleration, down for braking,
 * and side to side for lateral force, so both signals read as one combined
 * g-vector rather than two independent bars. Distance from centre and dot
 * colour both track magnitude (see accelScale.ts), reinforcing each other.
 *
 * Longitudinal g is calibrated against real GPS-confirmed harsh-braking
 * events; lateral g uses the same scale but is not independently validated
 * (see accel.ts), so the horizontal axis is drawn dashed rather than solid
 * to mark it as an estimate.
 */
export function GForceMeter({ points, clockMs, theme }: GForceMeterProps) {
  const current = accelAt(points, clockMs);
  const longitudinalG = current?.longitudinalG ?? 0;
  const lateralG = current?.lateralG ?? 0;
  const point = gVectorToPoint(longitudinalG, lateralG, RADIUS);
  const color = colorForG(Math.min(point.magnitude, TOP_G), theme);
  const title = `Accel / Brake: ${longitudinalG.toFixed(2)}g, Lateral (est.): ${lateralG.toFixed(2)}g`;

  return (
    <svg
      className="gforce-meter"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-hidden={!current}
      role={current ? 'img' : undefined}
      aria-label={current ? title : undefined}
    >
      <title>{title}</title>
      {RING_STOPS.map((g) => (
        <circle key={g} className="gforce-ring" cx={CENTER} cy={CENTER} r={(g / TOP_G) * RADIUS} />
      ))}
      <line className="gforce-axis gforce-axis--vertical" x1={CENTER} y1={CENTER - RADIUS} x2={CENTER} y2={CENTER + RADIUS} />
      <line className="gforce-axis gforce-axis--lateral" x1={CENTER - RADIUS} y1={CENTER} x2={CENTER + RADIUS} y2={CENTER} />
      <text className="gforce-tick" x={CENTER} y={CENTER - RADIUS - 2} textAnchor="middle">accel</text>
      <text className="gforce-tick" x={CENTER} y={CENTER + RADIUS + 8} textAnchor="middle">brake</text>
      <circle
        className="gforce-dot"
        cx={CENTER + point.x}
        cy={CENTER - point.y}
        r={4.5}
        fill={color}
      />
    </svg>
  );
}
