import {
  parseClipName, buildTrips, CLIP_FOLDERS,
  type ClipRef, type Trip,
} from '@wolfbox/telemetry';

/** A clip on a card the user has granted access to. */
export type CardClip = ClipRef<FileSystemFileHandle>;
export type CardTrip = Trip<FileSystemFileHandle>;

export interface Card {
  name: string;
  clips: CardClip[];
  trips: CardTrip[];
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

  return { name: root.name, clips, trips: buildTrips(clips) };
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
    if (trip.hasEvent && trip.clips.length <= 2) events.push(trip);
    else drives.push(trip);
  }
  return { drives, events };
}
