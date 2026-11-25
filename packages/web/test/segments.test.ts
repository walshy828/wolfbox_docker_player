import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clipWindow } from '../src/segments.ts';
import { coveringSources, segmentSources, type SegmentSource } from '../src/archive.ts';
import type { ReviewTrip } from '../src/card.ts';

const bounds = { startMs: 0, endMs: 300_000 };

describe('clipWindow', () => {
  it('centres on the playhead', () => {
    assert.deepEqual(clipWindow(100_000, 30, 'around', bounds), { startMs: 85_000, endMs: 115_000 });
  });
  it('starts at the playhead', () => {
    assert.deepEqual(clipWindow(100_000, 60, 'from', bounds), { startMs: 100_000, endMs: 160_000 });
  });
  it('stays inside the video at either end', () => {
    assert.deepEqual(clipWindow(5_000, 30, 'around', bounds), { startMs: 0, endMs: 30_000 });
    assert.deepEqual(clipWindow(295_000, 30, 'from', bounds), { startMs: 270_000, endMs: 300_000 });
  });
  it('never runs past a drive shorter than the clip', () => {
    assert.deepEqual(clipWindow(10_000, 120, 'around', { startMs: 0, endMs: 60_000 }), { startMs: 0, endMs: 60_000 });
  });
});

describe('coveringSources', () => {
  const s = (name: string, camera: 'front' | 'rear', startMs: number): SegmentSource => ({ name, camera, startMs });
  const all = [s('a', 'front', 0), s('b', 'front', 60_000), s('c', 'front', 120_000), s('x', 'rear', 700)];
  it('takes only the files that overlap the window', () => {
    assert.deepEqual(coveringSources(all, 45_000, 75_000).map((x) => x.name), ['a', 'b', 'x']);
    assert.deepEqual(coveringSources(all, 125_000, 130_000).map((x) => x.name), ['c']);
  });
});

describe('segmentSources', () => {
  it('pairs each camera file with its measured start and skips unknown starts', () => {
    const handle = { getFile: async () => new File([], 'f') } as unknown as FileSystemFileHandle;
    const clip = (name: string, camera: 'front' | 'rear') => ({ name, camera, kind: 'normal' as const, startLocalMs: 0, handle });
    const trip = { id: 't', startLocalMs: 0, endLocalMs: 0, hasEvent: false,
      clips: [{ front: clip('f0', 'front'), rear: clip('r0', 'rear') }, { front: clip('f1', 'front') }] } as unknown as ReviewTrip;
    const out = segmentSources(trip, [{ front: 1_000, rear: 1_700 }, { front: undefined }]);
    assert.deepEqual(out.map((x) => [x.name, x.camera, x.startMs]), [['f0', 'front', 1_000], ['r0', 'rear', 1_700]]);
    assert.equal(typeof out[0]!.file, 'function');
  });
});
