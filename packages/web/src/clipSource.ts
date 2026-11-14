import type { PlaybackMode } from './codec.ts';
import { isRemoteClip, type ClipHandle, type RemoteClip } from './card.ts';

/**
 * Turns a clip on the card into something a <video> element can play.
 *
 * In `direct` mode the file is handed straight to the element and never leaves
 * the machine. In `transcode` mode it is posted to the local service, which
 * returns an H.264 proxy -- the only way to play these 4K HEVC files on a Linux
 * desktop, where Chromium refuses to decode HEVC without a hardware decoder.
 */

const TRANSCODE_ENDPOINT = '/api/transcode';

export interface ClipSource {
  url: string;
  release(): void;
}

const inFlight = new Map<string, Promise<ClipSource>>();

export async function openClip(
  handle: ClipHandle,
  mode: PlaybackMode,
  options: { width?: number; signal?: AbortSignal } = {},
): Promise<ClipSource> {
  if (isRemoteClip(handle)) return openRemote(handle, mode, options.width);
  const file = await handle.getFile();
  const key = `${mode}:${options.width ?? 0}:${file.name}:${file.size}:${file.lastModified}`;

  // Prefetching the next clip while the current one plays means the same clip
  // can be requested twice; share the request rather than transcoding twice.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = create(file, mode, options);
    inFlight.set(key, pending);
    pending.catch(() => inFlight.delete(key));
  }

  const source = await pending;
  return {
    url: source.url,
    release() {
      inFlight.delete(key);
      source.release();
    },
  };
}

async function create(
  file: File,
  mode: PlaybackMode,
  options: { width?: number; signal?: AbortSignal },
): Promise<ClipSource> {
  if (mode === 'direct') {
    const url = URL.createObjectURL(file);
    return { url, release: () => URL.revokeObjectURL(url) };
  }

  const query = options.width ? `?width=${options.width}` : '';
  const response = await fetch(`${TRANSCODE_ENDPOINT}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-clip-name': file.name },
    body: file,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `Transcoding failed (${response.status}). Is the WolfBox Player service running?`,
    );
  }
  const url = URL.createObjectURL(await response.blob());
  return { url, release: () => URL.revokeObjectURL(url) };
}

/**
 * An archived clip plays straight from the service: the original when the
 * browser decodes HEVC, otherwise the service's own proxy of it. Both are
 * served with range support, so there is nothing to download first.
 */
function openRemote(clip: RemoteClip, mode: PlaybackMode, width?: number): ClipSource {
  if (!clip.stored) throw new Error('This drive was archived without its video.');
  const url = mode === 'direct' ? clip.url : `${clip.url}/proxy${width ? `?width=${width}` : ''}`;
  return { url, release() {} };
}
