/**
 * Speed -> colour for the route line, legend and histogram.
 *
 * Speed is a magnitude, so this is a sequential ramp, not a categorical palette.
 * The bins are absolute (a colour means the same speed on every trip) so trips
 * can be compared and a fast stretch is recognisable at a glance.
 *
 * The obvious green->red traffic ramp fails badly for colour-blind readers:
 * validated with the dataviz palette checker, Tailwind's green/yellow pair sits
 * at deltaE 4.2 under protanopia, i.e. indistinguishable. These steps were
 * generated in OKLCH with *monotonically decreasing lightness*, so speed is
 * carried by lightness as well as hue and the ramp degrades to a readable
 * grayscale ramp under any colour vision deficiency.
 *
 * Validator results (light surface #fcfcfb / dark #1a1a19):
 *   normal-vision separation PASS (16.3 / 16.4, floor is 15)
 *   CVD separation WARN 7.2 / 6.4 -- inside the 6-8 band, which is permitted
 *     only alongside secondary encoding, so the legend is always present, the
 *     histogram is directly labelled and a table view exists.
 *   dark contrast PASS (all >= 3:1). The light ramp's pale end sits below 3:1,
 *     which is what the always-on legend and labels provide relief for.
 *
 * "Stopped" is a state rather than a magnitude, so it gets a neutral grey and
 * is deliberately outside the ramp.
 */

export interface SpeedBin {
  /** Inclusive lower bound in mph. */
  minMph: number;
  /** Exclusive upper bound in mph. */
  maxMph: number;
  label: string;
  /** What this speed usually means on the road, shown in the legend. */
  note: string;
  light: string;
  dark: string;
}

export const STOPPED_BIN: SpeedBin = {
  minMph: 0, maxMph: 1, label: 'Stopped', note: 'parked or waiting',
  light: '#8a8a85', dark: '#8f8f8a',
};

export const SPEED_BINS: SpeedBin[] = [
  { minMph: 1,  maxMph: 15,       label: '1-15',  note: 'crawl, parking', light: '#98d0ff', dark: '#9ed6ff' },
  { minMph: 15, maxMph: 30,       label: '15-30', note: 'residential',    light: '#23c987', dark: '#2adb94' },
  { minMph: 30, maxMph: 45,       label: '30-45', note: 'arterial',       light: '#aa9200', dark: '#bda500' },
  { minMph: 45, maxMph: 60,       label: '45-60', note: 'highway',        light: '#ca4f00', dark: '#e46300' },
  { minMph: 60, maxMph: Infinity, label: '60+',   note: 'fast',           light: '#9c003b', dark: '#c32e85' },
];

export type Theme = 'light' | 'dark';

export function binForMph(mph: number): SpeedBin {
  if (mph < STOPPED_BIN.maxMph) return STOPPED_BIN;
  return SPEED_BINS.find((b) => mph < b.maxMph) ?? SPEED_BINS.at(-1)!;
}

export function colorForMph(mph: number, theme: Theme): string {
  const bin = binForMph(mph);
  return theme === 'dark' ? bin.dark : bin.light;
}

/** Index into `SPEED_BINS`, or -1 for stopped. Aligns with `histogramMph`. */
export function binIndexForMph(mph: number): number {
  if (mph < STOPPED_BIN.maxMph) return -1;
  return SPEED_BINS.findIndex((b) => mph < b.maxMph);
}
