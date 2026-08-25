import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrips, type ClipRef } from '@wolfbox/telemetry';
import {
  clipKey, clipsInPair, clipsInTrips, deleteClips, describeSelection, describeTrips,
  findSuccessorTrip, successorClipIndex, tripTouched,
} from '../src/deletion.ts';
import { removeClipsFromCard, type Card, type CardClip } from '../src/card.ts';

const T0 = Date.UTC(2026, 7, 1, 11, 23, 28);
const minutes = (n: number) => n * 60_000;

/**
 * The handle is only ever passed back to the browser, so tests stand a plain
 * marker in for it.
 */
const clip = (
  name: string,
  camera: 'front' | 'rear',
  startLocalMs: number,
  kind: 'normal' | 'event' = 'normal',
): CardClip =>
  ({ name, camera, kind, startLocalMs, handle: name as unknown as FileSystemFileHandle });

/** A directory tree that records what was removed from it. */
function fakeRoot(options: { missing?: string[]; locked?: string[] } = {}) {
  const removed: string[] = [];
  const root = {
    getDirectoryHandle(folder: string) {
      return Promise.resolve({
        removeEntry(name: string) {
          const path = `${folder}/${name}`;
          if (options.missing?.includes(path)) {
            return Promise.reject(new DOMException('gone', 'NotFoundError'));
          }
          if (options.locked?.includes(path)) {
            return Promise.reject(new DOMException('in use', 'NoModificationAllowedError'));
          }
          removed.push(path);
          return Promise.resolve();
        },
      });
    },
  } as unknown as FileSystemDirectoryHandle;
  return { root, removed };
}

const card = (clips: CardClip[]): Card =>
  ({ name: 'CARD', root: fakeRoot().root, clips, trips: buildTrips(clips) });

describe('clipKey', () => {
  test('separates the same name in a normal and an event folder', () => {
    const name = '2026_08_01_112328_00.MP4';
    assert.equal(clipKey(clip(name, 'front', T0)), `front_norm/${name}`);
    assert.equal(clipKey(clip(name, 'front', T0, 'event')), `front_emer/${name}`);
  });

  test('separates the cameras', () => {
    assert.equal(clipKey(clip('a.MP4', 'rear', T0)), 'rear_norm/a.MP4');
  });
});

describe('clipsInPair / clipsInTrips', () => {
  test('collects both cameras, and tolerates a missing one', () => {
    const trips = buildTrips([
      clip('f0.MP4', 'front', T0), clip('r0.MP4', 'rear', T0),
      clip('f1.MP4', 'front', T0 + minutes(1)),
    ]);
    assert.equal(trips.length, 1);
    assert.deepEqual(clipsInPair(trips[0]!.clips[0]!).map((c) => c.name), ['f0.MP4', 'r0.MP4']);
    assert.deepEqual(clipsInPair(trips[0]!.clips[1]!).map((c) => c.name), ['f1.MP4']);
    assert.equal(clipsInTrips(trips).length, 3);
  });
});

describe('deleteClips', () => {
  test('removes each clip from the folder it belongs to', async () => {
    const { root, removed } = fakeRoot();
    const clips = [clip('f0.MP4', 'front', T0), clip('r0.MP4', 'rear', T0, 'event')];

    const result = await deleteClips(root, clips);

    assert.deepEqual(removed, ['front_norm/f0.MP4', 'rear_emer/r0.MP4']);
    assert.deepEqual([...result.removedKeys].sort(), ['front_norm/f0.MP4', 'rear_emer/r0.MP4']);
    assert.deepEqual(result.failures, []);
  });

  test('counts a file that is already gone as deleted', async () => {
    const { root } = fakeRoot({ missing: ['front_norm/f0.MP4'] });
    const result = await deleteClips(root, [clip('f0.MP4', 'front', T0)]);
    assert.deepEqual([...result.removedKeys], ['front_norm/f0.MP4']);
    assert.deepEqual(result.failures, []);
  });

  test('reports a locked file but still deletes the rest of the batch', async () => {
    const { root, removed } = fakeRoot({ locked: ['front_norm/f0.MP4'] });
    const clips = [clip('f0.MP4', 'front', T0), clip('f1.MP4', 'front', T0 + minutes(1))];

    const result = await deleteClips(root, clips);

    assert.deepEqual(removed, ['front_norm/f1.MP4']);
    assert.deepEqual([...result.removedKeys], ['front_norm/f1.MP4']);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]!.clip.name, 'f0.MP4');
  });
});

describe('removeClipsFromCard', () => {
  test('drops the clips and keeps the rest of the card', () => {
    const before = card([
      clip('f0.MP4', 'front', T0),
      clip('r0.MP4', 'rear', T0),
      clip('f1.MP4', 'front', T0 + minutes(1)),
    ]);

    const after = removeClipsFromCard(before, new Set(['rear_norm/r0.MP4']));

    assert.deepEqual(after.clips.map((c) => c.name), ['f0.MP4', 'f1.MP4']);
    assert.equal(after.name, before.name);
    assert.equal(after.trips.length, 1);
    assert.equal(after.trips[0]!.clips.length, 2);
  });

  test('splits a trip in two when a hole is opened in the middle of it', () => {
    const before = card([
      clip('f0.MP4', 'front', T0),
      clip('f1.MP4', 'front', T0 + minutes(1)),
      clip('f2.MP4', 'front', T0 + minutes(2)),
      clip('f3.MP4', 'front', T0 + minutes(3)),
    ]);
    assert.equal(before.trips.length, 1);

    // Losing two consecutive clips leaves a gap wider than TRIP_GAP_MS.
    const after = removeClipsFromCard(
      before,
      new Set(['front_norm/f1.MP4', 'front_norm/f2.MP4']),
    );

    assert.equal(after.trips.length, 2);
    assert.deepEqual(after.trips.map((t) => t.clips.length), [1, 1]);
  });
});

describe('findSuccessorTrip', () => {
  test('follows a trip whose id changed because its first clip went', () => {
    const before = card([
      clip('f0.MP4', 'front', T0),
      clip('f1.MP4', 'front', T0 + minutes(1)),
    ]);
    const removedKeys = new Set(['front_norm/f0.MP4']);
    const after = removeClipsFromCard(before, removedKeys);

    const successor = findSuccessorTrip(after.trips, before.trips[0]!, removedKeys);

    assert.ok(successor);
    assert.notEqual(successor.id, before.trips[0]!.id);
    assert.deepEqual(clipsInTrips([successor]).map((c) => c.name), ['f1.MP4']);
  });

  test('returns null once every clip of the trip has gone', () => {
    const before = card([clip('f0.MP4', 'front', T0)]);
    const removedKeys = new Set(['front_norm/f0.MP4']);
    const after = removeClipsFromCard(before, removedKeys);

    assert.equal(findSuccessorTrip(after.trips, before.trips[0]!, removedKeys), null);
  });

  test('ignores a different trip that survived', () => {
    const before = card([
      clip('f0.MP4', 'front', T0),
      clip('f9.MP4', 'front', T0 + minutes(30)),
    ]);
    assert.equal(before.trips.length, 2);
    const removedKeys = new Set(['front_norm/f0.MP4']);
    const after = removeClipsFromCard(before, removedKeys);

    assert.equal(findSuccessorTrip(after.trips, before.trips[0]!, removedKeys), null);
    const kept = findSuccessorTrip(after.trips, before.trips[1]!, removedKeys);
    assert.equal(kept?.id, before.trips[1]!.id);
  });
});

describe('successorClipIndex', () => {
  test('keeps the clip that was playing as the indices shift down', () => {
    const before = card([
      clip('f0.MP4', 'front', T0),
      clip('f1.MP4', 'front', T0 + minutes(1)),
      clip('f2.MP4', 'front', T0 + minutes(2)),
    ]);
    const removedKeys = new Set(['front_norm/f0.MP4']);
    const after = removeClipsFromCard(before, removedKeys);
    const successor = findSuccessorTrip(after.trips, before.trips[0]!, removedKeys)!;

    assert.equal(successorClipIndex(successor, before.trips[0]!, 2), 1);
  });

  test('clamps into range when the clip that was playing is the one deleted', () => {
    const before = card([
      clip('f0.MP4', 'front', T0),
      clip('f1.MP4', 'front', T0 + minutes(1)),
    ]);
    const removedKeys = new Set(['front_norm/f1.MP4']);
    const after = removeClipsFromCard(before, removedKeys);
    const successor = findSuccessorTrip(after.trips, before.trips[0]!, removedKeys)!;

    assert.equal(successorClipIndex(successor, before.trips[0]!, 1), 0);
  });
});

describe('confirmation copy', () => {
  const trips = card([
    clip('f0.MP4', 'front', T0),
    clip('r0.MP4', 'rear', T0),
    clip('f9.MP4', 'front', T0 + minutes(30)),
  ]).trips;

  test('names one trip and counts its clips', () => {
    assert.equal(describeTrips([trips[0]!], 'drive'), 'this drive and its 1 clip');
  });

  test('counts a batch', () => {
    assert.equal(describeTrips(trips, 'drive'), '2 drives and their 2 clips');
    assert.equal(describeSelection(trips), '2 selected · 2 clips');
  });
});

describe('tripTouched', () => {
  const trips = card([
    clip('f0.MP4', 'front', T0),
    clip('f9.MP4', 'front', T0 + minutes(30)),
  ]).trips;

  test('tells the trip that lost a clip from the one that did not', () => {
    const removedKeys = new Set(['front_norm/f9.MP4']);
    assert.equal(tripTouched(trips[0]!, removedKeys), false);
    assert.equal(tripTouched(trips[1]!, removedKeys), true);
  });
});
