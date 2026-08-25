/**
 * Removing clips from the card.
 *
 * Deletion is permanent -- the File System Access API has no trash -- so every
 * caller is expected to have taken a confirmation first. The logic lives here
 * rather than in the components because rebuilding a card around a hole is the
 * fiddly part: `Trip.id` is derived from a trip's first clip, so deleting that
 * clip renames the trip, and deleting one in the middle can split the trip in
 * two. Nothing downstream may assume trip identity survives a delete.
 */

import { clipFolder, type ClipPair, type ClipRef } from '@wolfbox/telemetry';
import type { CardClip, CardTrip } from './card.ts';

/**
 * Identifies a clip across the whole card.
 *
 * Names are unique only within a folder: the same minute can appear as
 * `front_norm/2026_08_01_112328_00.MP4` and, once the camera locks it,
 * `front_emer/2026_08_01_112328_00.MP4`.
 */
export function clipKey(clip: ClipRef<unknown>): string {
  return `${clipFolder(clip.camera, clip.kind)}/${clip.name}`;
}

/** The files behind one clip: front and rear are deleted together. */
export function clipsInPair(pair: ClipPair<FileSystemFileHandle>): CardClip[] {
  return [pair.front, pair.rear].filter((clip): clip is CardClip => clip !== undefined);
}

export function clipsInTrips(trips: CardTrip[]): CardClip[] {
  return trips.flatMap((trip) => trip.clips.flatMap(clipsInPair));
}

export interface DeleteFailure {
  clip: CardClip;
  message: string;
}

export interface DeleteResult {
  removedKeys: Set<string>;
  failures: DeleteFailure[];
}

/**
 * Deletes clips from the card, reporting per-file failures rather than
 * stopping at the first one -- a single clip the OS has locked should not
 * strand the rest of a 40-clip drive half deleted with no explanation.
 */
export async function deleteClips(
  root: FileSystemDirectoryHandle,
  clips: CardClip[],
): Promise<DeleteResult> {
  const folders = new Map<string, Promise<FileSystemDirectoryHandle>>();
  const removedKeys = new Set<string>();
  const failures: DeleteFailure[] = [];

  for (const clip of clips) {
    const folder = clipFolder(clip.camera, clip.kind);
    try {
      let directory = folders.get(folder);
      if (!directory) {
        directory = root.getDirectoryHandle(folder);
        folders.set(folder, directory);
      }
      await (await directory).removeEntry(clip.name);
      removedKeys.add(clipKey(clip));
    } catch (cause) {
      // Already gone is the outcome the caller wanted, however it happened.
      if (cause instanceof DOMException && cause.name === 'NotFoundError') {
        removedKeys.add(clipKey(clip));
        continue;
      }
      failures.push({
        clip,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { removedKeys, failures };
}

/** Whether a delete reached into this trip at all. */
export function tripTouched(trip: CardTrip, removedKeys: Set<string>): boolean {
  return clipsInTrips([trip]).some((clip) => removedKeys.has(clipKey(clip)));
}

/**
 * Finds the open trip again in a rebuilt card.
 *
 * Matching by `id` is not enough: losing a trip's first clip moves its start,
 * and therefore its id. What does survive is the clips themselves, so the trip
 * still holding one of them is the same drive from the user's point of view.
 * Returns null when every clip of the trip went.
 */
export function findSuccessorTrip(
  trips: CardTrip[],
  previous: CardTrip,
  removedKeys: Set<string>,
): CardTrip | null {
  const survivors = new Set(
    clipsInTrips([previous]).map(clipKey).filter((key) => !removedKeys.has(key)),
  );
  if (survivors.size === 0) return null;
  return trips.find((trip) =>
    clipsInTrips([trip]).some((clip) => survivors.has(clipKey(clip)))) ?? null;
}

/**
 * Where playback should resume once clips have gone.
 *
 * Keeping the clip that was on screen matters more than keeping its index: the
 * indices shift by however many earlier clips were deleted.
 */
export function successorClipIndex(
  next: CardTrip,
  previous: CardTrip,
  previousIndex: number,
): number {
  const playing = previous.clips[previousIndex];
  if (playing) {
    const keys = new Set(clipsInPair(playing).map(clipKey));
    const found = next.clips.findIndex((pair) =>
      clipsInPair(pair).some((clip) => keys.has(clipKey(clip))));
    if (found >= 0) return found;
  }
  return Math.max(0, Math.min(previousIndex, next.clips.length - 1));
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Confirmation copy: what is about to go, counted the way the user sees it. */
export function describeTrips(trips: CardTrip[], noun = 'trip'): string {
  const clips = trips.reduce((total, trip) => total + trip.clips.length, 0);
  if (trips.length === 1) return `this ${noun} and its ${plural(clips, 'clip')}`;
  return `${plural(trips.length, noun)} and their ${plural(clips, 'clip')}`;
}

/** Sidebar summary of what is selected. */
export function describeSelection(trips: CardTrip[]): string {
  const clips = trips.reduce((total, trip) => total + trip.clips.length, 0);
  return `${trips.length} selected · ${plural(clips, 'clip')}`;
}
