import { oklchToHex, sampleRamp, type Oklch } from './color.ts';

/**
 * Speed -> colour for the route line, legend and histogram.
 *
 * Speed is a magnitude, so this is a continuous sequential ramp: the route line
 * blends between colours as the car speeds up and slows down rather than
 * stepping between blocks, which makes an acceleration or a braking event read
 * as a gradient along the road.
 *
 * The stops are defined in OKLCH with **monotonically decreasing lightness**,
 * and that is the part that must not be broken. A green-to-red traffic ramp is
 * unreadable for colour-blind viewers -- Tailwind's green/yellow pair sits at
 * deltaE 4.2 under protanopia, i.e. indistinguishable. Because lightness falls
 * steadily from the slow end to the fast end here, speed survives as a
 * grayscale ramp under any colour vision deficiency, and hue is a redundant
 * second channel rather than the only one.
 *
 * The ramp tops out at 80 mph so the deepest colour means something definite;
 * above that it stays pinned rather than continuing to darken into black.
 */

/** Above this the colour stops changing, so the top of the ramp is meaningful. */
export const TOP_SPEED_MPH = 80;
/** Below this the vehicle is treated as stopped and painted neutral grey. */
export const STOPPED_MPH = 1;

export type Theme = 'light' | 'dark';

/**
 * Control stops. Lightness descends throughout; hue runs blue -> green ->
 * amber -> red -> deep purple, crossing zero the short way at the top end.
 */
const LIGHT_RAMP: { at: number; color: Oklch }[] = [
  { at: 1,  color: { l: 0.88, c: 0.08, h: 262 } },
  { at: 15, color: { l: 0.78, c: 0.16, h: 162 } },
  { at: 35, color: { l: 0.68, c: 0.17, h: 112 } },
  { at: 50, color: { l: 0.60, c: 0.18, h: 68 } },
  { at: 65, color: { l: 0.51, c: 0.20, h: 28 } },
  { at: 80, color: { l: 0.40, c: 0.19, h: 336 } },
];

/** Same path, lifted so every step clears 3:1 against the dark surface. */
const DARK_RAMP: { at: number; color: Oklch }[] = [
  { at: 1,  color: { l: 0.90, c: 0.08, h: 262 } },
  { at: 15, color: { l: 0.83, c: 0.17, h: 162 } },
  { at: 35, color: { l: 0.77, c: 0.18, h: 112 } },
  { at: 50, color: { l: 0.71, c: 0.19, h: 68 } },
  { at: 65, color: { l: 0.65, c: 0.22, h: 28 } },
  { at: 80, color: { l: 0.57, c: 0.22, h: 336 } },
];

const STOPPED_COLOR: Record<Theme, string> = { light: '#8a8a85', dark: '#8f8f8a' };

const ramp = (theme: Theme) => (theme === 'dark' ? DARK_RAMP : LIGHT_RAMP);

/** Cache: the route draws one colour lookup per second of footage. */
const cache = new Map<string, string>();

export function colorForMph(mph: number, theme: Theme): string {
  if (!Number.isFinite(mph) || mph < STOPPED_MPH) return STOPPED_COLOR[theme];
  const clamped = Math.min(mph, TOP_SPEED_MPH);
  // Quantise to whole mph; finer steps are indistinguishable on a 5px line.
  const key = `${theme}:${Math.round(clamped)}`;
  let hex = cache.get(key);
  if (!hex) {
    hex = oklchToHex(sampleRamp(ramp(theme), Math.round(clamped)));
    cache.set(key, hex);
  }
  return hex;
}

export interface SpeedBand {
  /** Inclusive lower bound in mph. */
  minMph: number;
  /** Exclusive upper bound in mph. */
  maxMph: number;
  label: string;
  /** What this speed usually means on the road, shown in the legend. */
  note: string;
}

/**
 * Named bands for the legend and the trip histogram.
 *
 * These label the continuous ramp rather than dividing it: the line itself
 * blends across the boundaries.
 */
export const SPEED_BANDS: SpeedBand[] = [
  { minMph: 1,  maxMph: 15,       label: '1-15',  note: 'crawl, parking' },
  { minMph: 15, maxMph: 35,       label: '15-35', note: 'residential' },
  { minMph: 35, maxMph: 60,       label: '35-60', note: 'route' },
  { minMph: 60, maxMph: 80,       label: '60-80', note: 'highway' },
  { minMph: 80, maxMph: Infinity, label: '80+',   note: 'very fast' },
];

export const STOPPED_BAND: SpeedBand = {
  minMph: 0, maxMph: STOPPED_MPH, label: 'Stopped', note: 'parked or waiting',
};

/** The colour that best represents a band, for legend keys and histogram bars. */
export function colorForBand(band: SpeedBand, theme: Theme): string {
  if (band.maxMph <= STOPPED_MPH) return STOPPED_COLOR[theme];
  const midpoint = band.maxMph === Infinity
    ? TOP_SPEED_MPH
    : (band.minMph + band.maxMph) / 2;
  return colorForMph(midpoint, theme);
}

/** Index into `SPEED_BANDS`, or -1 for stopped. Aligns with `histogramMph`. */
export function bandIndexForMph(mph: number): number {
  if (!Number.isFinite(mph) || mph < STOPPED_MPH) return -1;
  return SPEED_BANDS.findIndex((band) => mph < band.maxMph);
}

/** CSS gradient across the whole ramp, for the legend bar. */
export function rampGradient(theme: Theme, steps = 24): string {
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const mph = (i / steps) * TOP_SPEED_MPH;
    stops.push(`${colorForMph(Math.max(mph, STOPPED_MPH), theme)} ${(i / steps) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
