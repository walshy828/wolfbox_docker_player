import { MODERATE_G, SEVERE_G } from '@wolfbox/telemetry';
import { oklchToHex, sampleRamp, type Oklch } from './color.ts';
import type { Theme } from './speedScale.ts';

export { MODERATE_G, SEVERE_G };

/**
 * G-force magnitude -> colour for the live meter.
 *
 * Like excess speed, g-force is a deflection from zero rather than an
 * absolute value, so this mirrors `colorForExcessMph`: a sequential ramp with
 * monotonically decreasing lightness (colourblind-safe; see speedScale.ts),
 * reused for both bars and both directions -- direction is shown by which way
 * the bar deflects, not by colour.
 */

/** Above this the colour stops changing, so the darkest colour means something. */
export const TOP_G = 0.8;

const LIGHT_G_RAMP: { at: number; color: Oklch }[] = [
  { at: 0,          color: { l: 0.84, c: 0.05, h: 145 } },
  { at: MODERATE_G, color: { l: 0.72, c: 0.16, h: 70 } },
  { at: SEVERE_G,   color: { l: 0.55, c: 0.20, h: 25 } },
  { at: TOP_G,      color: { l: 0.42, c: 0.20, h: 15 } },
];

const DARK_G_RAMP: { at: number; color: Oklch }[] = [
  { at: 0,          color: { l: 0.90, c: 0.05, h: 145 } },
  { at: MODERATE_G, color: { l: 0.82, c: 0.17, h: 70 } },
  { at: SEVERE_G,   color: { l: 0.68, c: 0.21, h: 25 } },
  { at: TOP_G,      color: { l: 0.56, c: 0.21, h: 15 } },
];

const ramp = (theme: Theme) => (theme === 'dark' ? DARK_G_RAMP : LIGHT_G_RAMP);
const cache = new Map<string, string>();

/** Colour for a g-force magnitude (always pass an absolute value; sign is shown by bar geometry). */
export function colorForG(absG: number, theme: Theme): string {
  const clamped = Math.min(Math.max(absG, 0), TOP_G);
  const key = `${theme}:${clamped.toFixed(2)}`;
  let hex = cache.get(key);
  if (!hex) {
    hex = oklchToHex(sampleRamp(ramp(theme), clamped));
    cache.set(key, hex);
  }
  return hex;
}

export interface GPoint {
  /** Offset from centre, right is positive. */
  x: number;
  /** Offset from centre, up is positive. */
  y: number;
  /** Vector magnitude before clamping to `TOP_G`, so callers can tell a maxed-out reading apart from one that merely reaches the edge. */
  magnitude: number;
}

/**
 * Maps a longitudinal/lateral g-force pair onto a point within a circle of
 * the given radius, for the bullseye display.
 *
 * The vector is clamped by scaling it down along its own direction rather
 * than clamping each axis independently, so a reading that pins one axis
 * hard still lands on the ring in the correct direction instead of being
 * squared off.
 */
export function gVectorToPoint(longitudinalG: number, lateralG: number, radius: number): GPoint {
  const magnitude = Math.hypot(longitudinalG, lateralG);
  const scale = magnitude > TOP_G ? TOP_G / magnitude : 1;
  return {
    x: (lateralG * scale * radius) / TOP_G,
    y: (longitudinalG * scale * radius) / TOP_G,
    magnitude,
  };
}
