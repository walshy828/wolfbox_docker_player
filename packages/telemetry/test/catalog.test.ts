import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import {
  parseClipName, pairClips, buildTrips, CLIP_FOLDERS, type ClipRef,
} from '../src/catalog.ts';
import { CARD } from './helpers.ts';

const clip = (name: string, camera: 'front' | 'rear', startLocalMs: number): ClipRef<string> =>
  ({ name, camera, kind: 'normal', startLocalMs, handle: name });
const T0 = Date.UTC(2026, 7, 1, 11, 23, 28);
const minutes = (n: number) => n * 60_000;

describe('parseClipName', () => {
  test('reads front and rear names', () => {
    const front = parseClipName('front_norm', '2026_08_01_112328_00.MP4');
    assert.deepEqual(front, {
      name: '2026_08_01_112328_00.MP4', camera: 'front', kind: 'normal', startLocalMs: T0,
    });
    const rear = parseClipName('rear_norm', '2026_08_01_112328_01_b.MP4');
    assert.equal(rear?.camera, 'rear');
    assert.equal(rear?.startLocalMs, T0);
  });

  test('flags event folders', () => {
    assert.equal(parseClipName('front_emer', '2026_01_21_155841_00.MP4')?.kind, 'event');
  });

  test('rejects the camera preallocation files and unknown folders', () => {
    assert.equal(parseClipName('front_photo', '.PreAllocFile_00'), null);
    assert.equal(parseClipName('front_norm', '._2026_08_01_112628_00.MP4'), null);
    assert.equal(parseClipName('System Volume Information', 'x.MP4'), null);
  });
});

describe('pairClips', () => {
  test('pairs cameras whose clocks drift apart', () => {
    // The reference card's rear camera runs ~60s ahead of the front.
    const pairs = pairClips([
      clip('f0', 'front', T0),
      clip('r0', 'rear', T0 - 30_000),
    ]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.front?.name, 'f0');
    assert.equal(pairs[0]!.rear?.name, 'r0');
  });

  test('keeps an unmatched clip as a single-camera entry', () => {
    const pairs = pairClips([
      clip('f0', 'front', T0),
      clip('r0', 'rear', T0),
      clip('r1', 'rear', T0 + minutes(1)),
    ]);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[1]!.front, undefined);
    assert.equal(pairs[1]!.rear?.name, 'r1');
  });

  test('does not pair clips a minute apart across a gap', () => {
    const pairs = pairClips([clip('f0', 'front', T0), clip('r0', 'rear', T0 + minutes(10))]);
    assert.equal(pairs.length, 2);
  });
});

describe('buildTrips', () => {
  test('splits on a gap longer than two clips', () => {
    const trips = buildTrips([
      clip('f0', 'front', T0),
      clip('f1', 'front', T0 + minutes(1)),
      clip('f2', 'front', T0 + minutes(30)),
    ]);
    assert.equal(trips.length, 2);
    assert.equal(trips[0]!.clips.length, 2);
    assert.equal(trips[1]!.clips.length, 1);
  });

  test('keeps consecutive clips in one trip', () => {
    const clips = Array.from({ length: 20 }, (_, i) => clip(`f${i}`, 'front', T0 + minutes(i)));
    const trips = buildTrips(clips);
    assert.equal(trips.length, 1);
    assert.equal(trips[0]!.endLocalMs - trips[0]!.startLocalMs, minutes(20));
  });

  test('marks a trip containing a locked clip', () => {
    const trips = buildTrips([
      clip('f0', 'front', T0),
      { ...clip('e0', 'front', T0 + minutes(1)), kind: 'event' as const },
    ]);
    assert.equal(trips[0]!.hasEvent, true);
  });
});

describe('the reference card', { skip: existsSync(CARD) ? false : 'card not mounted' }, () => {
  const clips: ClipRef<string>[] = [];
  for (const folder of CLIP_FOLDERS) {
    let names: string[];
    try { names = readdirSync(`${CARD}/${folder}`); } catch { continue; }
    for (const name of names) {
      const parsed = parseClipName(folder, name);
      if (parsed) clips.push({ ...parsed, handle: `${folder}/${name}` });
    }
  }

  test('indexes the whole card from filenames alone', () => {
    assert.equal(clips.filter((c) => c.camera === 'front' && c.kind === 'normal').length, 728);
    assert.equal(clips.filter((c) => c.camera === 'rear' && c.kind === 'normal').length, 729);
  });

  test('pairs more clips than exact filename matching does', () => {
    const normal = clips.filter((c) => c.kind === 'normal');
    const paired = pairClips(normal).filter((p) => p.front && p.rear);
    // Matching on the 17-character timestamp prefix yields 714.
    assert.ok(paired.length >= 714, `paired ${paired.length}`);
  });

  test('segments the card into trips', () => {
    const trips = buildTrips(clips.filter((c) => c.kind === 'normal'));
    assert.ok(trips.length > 40 && trips.length < 70, `${trips.length} trips`);
    const span = [trips[0]!.startLocalMs, trips.at(-1)!.endLocalMs].map((ms) =>
      new Date(ms).toISOString().slice(0, 10));
    assert.deepEqual(span, ['2026-08-01', '2026-08-24']);
  });
});
