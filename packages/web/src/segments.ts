/** Choosing which stretch of a drive a saved clip covers (components/SavedClips.tsx). */

/** Clip lengths offered, in seconds. */
export const LENGTHS = [15, 30, 60, 120] as const;
export type Anchor = 'around' | 'from';

/**
 * The window a clip of `seconds` would cover at the playhead: centred on it, or
 * starting at it, and kept inside the drive's video.
 */
export function clipWindow(atMs: number, seconds: number, anchor: Anchor, bounds: { startMs: number; endMs: number }) {
  const length = seconds * 1000;
  let startMs = anchor === 'around' ? atMs - length / 2 : atMs;
  startMs = Math.max(bounds.startMs, Math.min(startMs, bounds.endMs - length));
  return { startMs, endMs: Math.min(bounds.endMs, startMs + length) };
}
