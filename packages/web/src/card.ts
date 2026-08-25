import {
  parseClipName, buildTrips, CLIP_FOLDERS, blobReader, readTelemetry, clipStartMs,
  type ClipRef, type Trip,
} from '@wolfbox/telemetry';
import { clipKey } from './deletion.ts';

/** A clip on a card the user has granted access to. */
export type CardClip = ClipRef<FileSystemFileHandle>;
export type CardTrip = Trip<FileSystemFileHandle>;

export interface Card {
  name: string;
  /** Kept so clips can be reached again -- deleting one needs its folder. */
  root: FileSystemDirectoryHandle;
  clips: CardClip[];
  trips: CardTrip[];
  /**
   * How far the camera's own clock sits from real time, in milliseconds.
   *
   * Filenames carry a naive local reading with no zone attached, so this is
   * what places them on the real timeline. Cameras are routinely set to the
   * wrong zone -- the reference card was recorded in Massachusetts by a camera
   * still on UTC-8 -- which is why displaying times in a chosen zone needs it.
   * Undefined when no clip on the card ever got a GPS fix.
   */
  cameraUtcOffsetMs?: number;
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Why the picker is unavailable, phrased for the user. */
export function directoryPickerBlocker(): string | null {
  if (supportsDirectoryPicker()) return null;
  if (!window.isSecureContext) {
    return 'Reading a card directly needs a secure context. Open this page on ' +
      'http://localhost (or over HTTPS) rather than by IP address.';
  }
  return 'This browser has no directory picker. Chrome or Edge can read the ' +
    'card directly; in Firefox, run the server with the card mounted instead.';
}

/**
 * Asks the user for the SD card and indexes it from filenames alone.
 *
 * This deliberately reads no file contents: a card holds ~1,500 clips and
 * pulling GPS from each costs ~700ms, so the trip list has to come from the
 * directory listing and telemetry is layered on lazily per trip.
 */
export async function pickCard(): Promise<Card | null> {
  let root: FileSystemDirectoryHandle;
  try {
    root = await window.showDirectoryPicker({ id: 'wolfbox-card', mode: 'read' });
  } catch (error) {
    // The user dismissing the picker is not an error worth surfacing.
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
  return readCard(root);
}

export async function readCard(root: FileSystemDirectoryHandle): Promise<Card> {
  const clips: CardClip[] = [];

  for (const folder of CLIP_FOLDERS) {
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await root.getDirectoryHandle(folder);
    } catch {
      continue; // Not every card has every folder.
    }
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== 'file') continue;
      const parsed = parseClipName(folder, name);
      if (parsed) clips.push({ ...parsed, handle: handle as FileSystemFileHandle });
    }
  }

  return {
    name: root.name,
    root,
    clips,
    trips: buildTrips(clips),
    cameraUtcOffsetMs: await detectCameraOffset(clips),
  };
}

/**
 * Asks for write access to the card, if it is not already granted.
 *
 * The picker deliberately opens read-only, so browsing a card can never put the
 * footage at risk. Write access is raised only when the user confirms a delete,
 * which is the user gesture `requestPermission` requires.
 */
export async function ensureWritable(root: FileSystemDirectoryHandle): Promise<boolean> {
  const descriptor = { mode: 'readwrite' } as const;
  if (await root.queryPermission(descriptor) === 'granted') return true;
  return await root.requestPermission(descriptor) === 'granted';
}

/** Clips to try before giving up on learning the camera's clock offset. */
const OFFSET_PROBE_LIMIT = 4;

/**
 * Measures the camera's clock error from the first clip that has a GPS fix.
 *
 * Telemetry carries both the camera's local reading and the receiver's UTC
 * time, so one clip is enough. Reading a clip's telemetry is expensive, hence
 * the small probe budget: a card whose first few clips never got a fix falls
 * back to showing the camera's clock as recorded.
 */
async function detectCameraOffset(clips: CardClip[]): Promise<number | undefined> {
  const candidates = clips
    .filter((clip) => clip.kind === 'normal')
    .sort((a, b) => a.startLocalMs - b.startLocalMs)
    .slice(0, OFFSET_PROBE_LIMIT);

  for (const clip of candidates) {
    try {
      const file = await clip.handle.getFile();
      const points = await readTelemetry(blobReader(file), { stride: 5 });
      const absolute = clipStartMs(points);
      if (absolute !== undefined) return clip.startLocalMs - absolute;
    } catch {
      // A truncated clip is not worth failing the whole card over.
    }
  }
  return undefined;
}

/**
 * The card as it stands once the named clips are gone.
 *
 * Trips are regrouped from scratch rather than patched, because removing a clip
 * can change a trip's identity: `Trip.id` comes from its first clip, and a gap
 * opened in the middle of one splits it in two.
 */
export function removeClipsFromCard(card: Card, removedKeys: Set<string>): Card {
  const clips = card.clips.filter((clip) => !removedKeys.has(clipKey(clip)));
  return { ...card, clips, trips: buildTrips(clips) };
}

/**
 * Splits trips into drives and standalone parking events.
 *
 * Parking-mode impacts are written as isolated one-minute clips, so treating
 * them as trips buries the real drives: the reference card has 54 drives and
 * 130 such events. They belong in their own list.
 */
export function partitionTrips(trips: CardTrip[]): { drives: CardTrip[]; events: CardTrip[] } {
  const drives: CardTrip[] = [];
  const events: CardTrip[] = [];
  for (const trip of trips) {
    if (isParkingEvent(trip)) events.push(trip);
    else drives.push(trip);
  }
  return { drives, events };
}

/** True for the isolated one-minute impacts, as opposed to a real drive. */
export const isParkingEvent = (trip: CardTrip) => trip.hasEvent && trip.clips.length <= 2;
