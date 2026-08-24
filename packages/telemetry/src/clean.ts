import type { TelemetryPoint } from './gpmd.ts';
import { haversineMeters } from './geo.ts';

export interface CleanOptions {
  /** Speeds above this are treated as fix-loss artefacts. */
  maxSpeedKph?: number;
  /** Implied speed between consecutive fixes above this rejects the later fix. */
  maxImpliedSpeedKph?: number;
}

const DEFAULTS: Required<CleanOptions> = {
  maxSpeedKph: 200,
  maxImpliedSpeedKph: 250,
};

export interface CleanPoint extends TelemetryPoint {
  /** Speed after median smoothing. Use this for map colouring. */
  smoothedSpeedKph: number;
}

/**
 * Drops points the receiver could not have produced, then median-smooths speed.
 *
 * Real cards contain both failure modes this guards against: rows with no fix
 * are written as latitude/longitude 0,0 (which would otherwise drag a route
 * line to Null Island), and speed spikes to 671 km/h were observed during fix
 * loss on the reference card.
 *
 * Raw `speedKph` is preserved so the readout can show what the camera reported;
 * `smoothedSpeedKph` exists so a single noisy sample cannot paint a red segment
 * across an otherwise steady stretch of road.
 */
export function cleanTrack(points: TelemetryPoint[], options: CleanOptions = {}): CleanPoint[] {
  const { maxSpeedKph, maxImpliedSpeedKph } = { ...DEFAULTS, ...options };

  const plausible: TelemetryPoint[] = [];
  let previous: TelemetryPoint | undefined;
  for (const point of points) {
    if (!point.hasFix) continue;
    if (point.latitude === 0 && point.longitude === 0) continue;
    if (Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) continue;
    if (!Number.isFinite(point.speedKph) || point.speedKph < 0 || point.speedKph > maxSpeedKph) continue;

    if (previous) {
      const seconds = (point.timestampMs - previous.timestampMs) / 1000;
      if (seconds > 0) {
        const impliedKph = (haversineMeters(previous, point) / seconds) * 3.6;
        if (impliedKph > maxImpliedSpeedKph) continue;
      }
    }
    plausible.push(point);
    previous = point;
  }

  return plausible.map((point, i) => ({
    ...point,
    smoothedSpeedKph: median3(
      plausible[i - 1]?.speedKph ?? point.speedKph,
      point.speedKph,
      plausible[i + 1]?.speedKph ?? point.speedKph,
    ),
  }));
}

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}
