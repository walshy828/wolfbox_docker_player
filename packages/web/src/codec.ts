/**
 * Decides whether this browser can play the camera's HEVC directly.
 *
 * Chrome and Chromium on Linux and ChromeOS decode HEVC only when the machine
 * has a hardware decoder -- Google ships no software fallback for patent
 * reasons -- and Firefox on Linux generally cannot at all. Since the front
 * camera records 4K HEVC, playback cannot be assumed on exactly the platforms
 * this app exists to serve, so anything that cannot decode is routed through
 * the transcoder.
 */

/** Main profile, level 5.1 -- what the front camera writes. */
const FRONT_CODEC = 'video/mp4; codecs="hvc1.1.6.L153.B0"';

export type PlaybackMode = 'direct' | 'transcode';

let cached: Promise<PlaybackMode> | null = null;

async function probe(): Promise<PlaybackMode> {
  const video = document.createElement('video');
  const canPlay = video.canPlayType(FRONT_CODEC);

  // MediaCapabilities is the authoritative answer: `canPlayType` reports
  // "maybe" on machines that then fail to render a frame.
  if (navigator.mediaCapabilities?.decodingInfo) {
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        video: {
          contentType: FRONT_CODEC,
          width: 3840, height: 2160, bitrate: 20_000_000, framerate: 30,
        },
      });
      return info.supported ? 'direct' : 'transcode';
    } catch {
      // Fall through to canPlayType.
    }
  }
  return canPlay === 'probably' ? 'direct' : 'transcode';
}

export function detectPlaybackMode(): Promise<PlaybackMode> {
  cached ??= probe();
  return cached;
}

/** Lets the user override a wrong probe result from the UI. */
export function setPlaybackMode(mode: PlaybackMode): void {
  cached = Promise.resolve(mode);
}
