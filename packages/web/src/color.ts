/**
 * Minimal OKLCH -> sRGB conversion, enough to build a perceptual ramp.
 *
 * The speed scale blends between control stops, and blending in sRGB produces
 * muddy, uneven transitions -- the midpoint of two equally bright colours comes
 * out darker than both. OKLab is perceptually uniform, so interpolating there
 * keeps the ramp's lightness moving at a constant rate, which is what makes it
 * readable as a magnitude.
 */

export interface Oklch {
  /** Perceptual lightness, 0-1. */
  l: number;
  /** Chroma, roughly 0-0.4. */
  c: number;
  /** Hue angle in degrees. */
  h: number;
}

function oklchToLinearRgb({ l, c, h }: Oklch): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const lCube = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCube = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3;

  return [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.7076147010 * sCube,
  ];
}

const inGamut = ([r, g, b]: [number, number, number]) =>
  [r, g, b].every((channel) => channel >= -0.0001 && channel <= 1.0001);

function encode(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel));
  const srgb = clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
}

/**
 * Converts to a hex colour, reducing chroma until the result is displayable.
 *
 * Clipping each channel independently is the usual shortcut, and it shifts hue
 * badly at high chroma -- a saturated deep red clips to something visibly
 * orange. Backing off chroma preserves the hue the ramp was designed around.
 */
export function oklchToHex(color: Oklch): string {
  let low = 0;
  let high = color.c;
  let best = oklchToLinearRgb({ ...color, c: 0 });

  if (inGamut(oklchToLinearRgb(color))) {
    best = oklchToLinearRgb(color);
  } else {
    for (let i = 0; i < 16; i++) {
      const mid = (low + high) / 2;
      const candidate = oklchToLinearRgb({ ...color, c: mid });
      if (inGamut(candidate)) { best = candidate; low = mid; } else { high = mid; }
    }
  }

  return '#' + best.map((channel) => encode(channel).toString(16).padStart(2, '0')).join('');
}

/** Interpolates hue the short way round, so 350 -> 10 crosses zero. */
export function lerpHue(from: number, to: number, t: number): number {
  let delta = ((to - from) % 360 + 540) % 360 - 180;
  return (from + delta * t + 360) % 360;
}

export function lerpOklch(from: Oklch, to: Oklch, t: number): Oklch {
  return {
    l: from.l + (to.l - from.l) * t,
    c: from.c + (to.c - from.c) * t,
    h: lerpHue(from.h, to.h, t),
  };
}

/** Samples a ramp of `{ at, color }` stops, sorted by `at`. */
export function sampleRamp(stops: { at: number; color: Oklch }[], value: number): Oklch {
  const first = stops[0]!;
  const last = stops.at(-1)!;
  if (value <= first.at) return first.color;
  if (value >= last.at) return last.color;

  for (let i = 1; i < stops.length; i++) {
    const previous = stops[i - 1]!;
    const next = stops[i]!;
    if (value <= next.at) {
      const span = next.at - previous.at;
      const t = span === 0 ? 0 : (value - previous.at) / span;
      return lerpOklch(previous.color, next.color, t);
    }
  }
  return last.color;
}
