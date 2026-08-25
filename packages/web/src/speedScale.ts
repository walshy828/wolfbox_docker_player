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

/**
 * Excess over the speed limit -> colour, for the map's compliance view.
 *
 * This is a second, separate ramp rather than a re-use of the speed ramp: on
 * this view the same 45 mph is compliant on a trunk road and badly over in a
 * residential street, so the quantity being painted is the excess, not the
 * speed.
 *
 * It is sequential rather than diverging, and that is forced by the same
 * colour-vision constraint the speed ramp lives under. A diverging ramp puts
 * its lightest colour in the middle, so lightness stops encoding magnitude and
 * the two ends become indistinguishable without hue -- exactly what fails
 * under protanopia. So compliant driving is one flat, light, low-chroma
 * colour, and everything above the limit darkens steadily from there.
 */

/** Above this the colour stops changing, so the darkest colour means something. */
export const TOP_EXCESS_MPH = 20;

/**
 * Where the ramp starts biting.
 *
 * Deliberately the limit itself rather than the +5 tolerance: a driver sitting
 * three over should be able to see it on the map even though it will never be
 * reported as an event. The tolerance decides what is worth flagging, not what
 * is worth drawing.
 */
const EXCESS_FLOOR_MPH = 0;

/** Within the limit: a calm, light colour that reads as "nothing to see". */
const COMPLIANT_COLOR: Record<Theme, string> = { light: '#8fb8a8', dark: '#6f9c8c' };

/** Lightness descends throughout, as in the speed ramp. Hue runs amber -> red. */
const LIGHT_EXCESS_RAMP: { at: number; color: Oklch }[] = [
  { at: 0,  color: { l: 0.84, c: 0.09, h: 92 } },
  { at: 5,  color: { l: 0.72, c: 0.16, h: 70 } },
  { at: 10, color: { l: 0.60, c: 0.19, h: 40 } },
  { at: 15, color: { l: 0.49, c: 0.21, h: 20 } },
  { at: 20, color: { l: 0.38, c: 0.19, h: 350 } },
];

const DARK_EXCESS_RAMP: { at: number; color: Oklch }[] = [
  { at: 0,  color: { l: 0.90, c: 0.09, h: 92 } },
  { at: 5,  color: { l: 0.82, c: 0.16, h: 70 } },
  { at: 10, color: { l: 0.74, c: 0.19, h: 40 } },
  { at: 15, color: { l: 0.66, c: 0.21, h: 20 } },
  { at: 20, color: { l: 0.58, c: 0.20, h: 350 } },
];

const excessRamp = (theme: Theme) => (theme === 'dark' ? DARK_EXCESS_RAMP : LIGHT_EXCESS_RAMP);
const excessCache = new Map<string, string>();

/**
 * Colour for a speed relative to its limit.
 *
 * A route segment whose limit is unknown must not be passed a zero excess --
 * that would paint it as compliant, which is the one thing the data does not
 * say. Callers draw those in the neutral stopped colour, dashed.
 */
export function colorForExcessMph(excessMph: number, theme: Theme): string {
  if (!Number.isFinite(excessMph) || excessMph <= EXCESS_FLOOR_MPH) return COMPLIANT_COLOR[theme];
  const clamped = Math.min(excessMph, TOP_EXCESS_MPH);
  const key = `${theme}:${Math.round(clamped)}`;
  let hex = excessCache.get(key);
  if (!hex) {
    hex = oklchToHex(sampleRamp(excessRamp(theme), Math.round(clamped)));
    excessCache.set(key, hex);
  }
  return hex;
}

/** Named bands for the compliance legend, mirroring `SPEED_BANDS`. */
export const EXCESS_BANDS: SpeedBand[] = [
  { minMph: 0,  maxMph: 5,        label: 'At limit', note: 'within the limit' },
  { minMph: 5,  maxMph: 10,       label: '+5',       note: 'inside tolerance' },
  { minMph: 10, maxMph: 15,       label: '+10',      note: 'clearly over' },
  { minMph: 15, maxMph: Infinity, label: '+15',      note: 'well over' },
];

/** The colour for one excess band, for legend keys. */
export function colorForExcessBand(band: SpeedBand, theme: Theme): string {
  if (band.minMph === 0) return COMPLIANT_COLOR[theme];
  const midpoint = band.maxMph === Infinity
    ? TOP_EXCESS_MPH
    : (band.minMph + band.maxMph) / 2;
  return colorForExcessMph(midpoint, theme);
}

/** CSS gradient across the excess ramp, for the legend bar. */
export function excessRampGradient(theme: Theme, steps = 20): string {
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const mph = (i / steps) * TOP_EXCESS_MPH;
    stops.push(`${colorForExcessMph(Math.max(mph, 0.01), theme)} ${(i / steps) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** The colour for a segment whose limit could not be established. */
export const unknownLimitColor = (theme: Theme) => STOPPED_COLOR[theme];
