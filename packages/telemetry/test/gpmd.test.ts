import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseTracks } from '../src/mp4.ts';
import { readTelemetry, findTelemetryTrack } from '../src/gpmd.ts';
import { cleanTrack } from '../src/clean.ts';
import { bearingDeg, haversineMeters } from '../src/geo.ts';
import { fileReader, REFERENCE_CLIP, REFERENCE_REAR } from './helpers.ts';

const available = existsSync(REFERENCE_CLIP);
const skip = available ? false : `reference card not mounted (${REFERENCE_CLIP})`;

describe('WolfBox clip parsing', { skip }, () => {
  let reader: Awaited<ReturnType<typeof fileReader>>;
  before(async () => { reader = await fileReader(REFERENCE_CLIP); });
  after(async () => { await reader?.close(); });

  test('front clip exposes video, audio and telemetry tracks', async () => {
    const tracks = await parseTracks(reader);
    assert.equal(tracks.length, 3);

    const video = tracks.find((t) => t.handler === 'vide');
    assert.ok(video);
    assert.equal(video.format, 'hvc1', 'front camera records HEVC');
    assert.equal(video.width, 3840);
    assert.equal(video.height, 2160);

    assert.ok(tracks.find((t) => t.handler === 'soun')?.format === 'mp4a');

    const gpmd = findTelemetryTrack(tracks);
    assert.ok(gpmd, 'telemetry track present');
    assert.equal(gpmd.handler, 'meta');
    assert.equal(gpmd.samples.length, 60, 'one sample per second of a 60s clip');
    assert.ok(gpmd.samples.every((s) => s.size === 1000));
  });

  // Golden values recovered from the reference card. If these drift, the
  // field-offset table in gpmd.ts is wrong -- do not "fix" the test.
  test('decodes the first telemetry sample exactly', async () => {
    const points = await readTelemetry(reader);
    assert.equal(points.length, 60);

    const first = points[0]!;
    assert.deepEqual(first.localTime,
      { year: 2026, month: 8, day: 1, hour: 11, minute: 23, second: 29 });
    assert.deepEqual(first.utcTime, { hour: 19, minute: 23, second: 29 });
    assert.equal(first.latitude, 41.4597594);
    assert.equal(first.longitude, -70.3532704);
    assert.equal(first.speedKph, 59.379);
    assert.equal(first.headingDeg, 36.93);
    assert.deepEqual(first.accel, { x: -180, y: 12, z: 154 });
    assert.equal(first.hasFix, true);
  });

  test('samples are one second apart across the clip', async () => {
    const points = await readTelemetry(reader);
    const last = points.at(-1)!;
    assert.deepEqual(last.localTime,
      { year: 2026, month: 8, day: 1, hour: 11, minute: 24, second: 28 });
    assert.equal((last.timestampMs - points[0]!.timestampMs) / 1000, 59);
  });

  // This is the check that pins the coordinate scale. Reading the fields as
  // NMEA ddmm.mmmmm instead of 1e-7 degrees shifts the position ~34km and
  // breaks this agreement.
  test('reported heading agrees with the bearing between fixes', async () => {
    const points = cleanTrack(await readTelemetry(reader));
    const moving = points.filter((p) => p.speedKph > 20);
    assert.ok(moving.length > 30, 'clip has a moving stretch to test against');

    for (let i = 1; i < 10; i++) {
      const a = moving[i - 1]!;
      const b = moving[i]!;
      const computed = bearingDeg(a, b);
      const delta = Math.abs(((computed - a.headingDeg + 540) % 360) - 180);
      assert.ok(delta < 5, `bearing ${computed.toFixed(2)} vs reported ${a.headingDeg}`);
    }
  });

  test('straight-line distance stays under the speed-integrated path', async () => {
    const points = cleanTrack(await readTelemetry(reader));
    const window = points.slice(0, 21);
    const straight = haversineMeters(window[0]!, window.at(-1)!);
    const path = window.slice(0, -1).reduce((m, p) => m + p.speedKph / 3.6, 0);
    // A ddmm.mmmmm reading gives ~683m here against a ~335m path, which is
    // geometrically impossible; 1e-7 degrees gives ~368m.
    assert.ok(straight > 300 && straight < 420, `straight-line was ${straight.toFixed(0)}m`);
    assert.ok(straight / path < 1.2, `straight/path ratio ${(straight / path).toFixed(2)}`);
  });

  test('rear clip carries its own telemetry, at a lower resolution', async () => {
    const rear = await fileReader(REFERENCE_REAR);
    try {
      const tracks = await parseTracks(rear);
      const video = tracks.find((t) => t.handler === 'vide')!;
      assert.equal(video.format, 'hvc1');
      assert.equal(video.width, 2560);
      assert.equal(video.height, 1440);
      assert.equal(findTelemetryTrack(tracks)!.samples.length, 60);
    } finally {
      await rear.close();
    }
  });

  test('stride reads a sparse subset for cheap previews', async () => {
    const sparse = await readTelemetry(reader, { stride: 60 });
    assert.equal(sparse.length, 1, 'one point per clip');
    assert.equal(sparse[0]!.latitude, 41.4597594);
  });
});

describe('cleanTrack', () => {
  const base = {
    index: 0,
    localTime: { year: 2026, month: 8, day: 1, hour: 11, minute: 23, second: 29 },
    utcTime: { hour: 19, minute: 23, second: 29 },
    timestampMs: Date.UTC(2026, 7, 1, 19, 23, 29),
    latitude: 42.1, longitude: -71.3, speedKph: 50, headingDeg: 90,
    accel: { x: 0, y: 0, z: 0 }, hasFix: true,
  };
  const at = (i: number, over: Partial<typeof base> = {}) =>
    ({ ...base, index: i, timestampMs: base.timestampMs + i * 1000, ...over });

  test('drops no-fix rows written as 0,0', () => {
    const cleaned = cleanTrack([at(0), at(1, { hasFix: false, latitude: 0, longitude: 0 }), at(2)]);
    assert.equal(cleaned.length, 2);
    assert.ok(cleaned.every((p) => p.latitude !== 0));
  });

  test('drops the 671 km/h fix-loss spike seen on real cards', () => {
    const cleaned = cleanTrack([at(0), at(1, { speedKph: 671 }), at(2)]);
    assert.deepEqual(cleaned.map((p) => p.index), [0, 2]);
  });

  test('smooths an isolated spike without altering the reported speed', () => {
    const cleaned = cleanTrack([at(0), at(1, { speedKph: 150 }), at(2)]);
    assert.equal(cleaned[1]!.speedKph, 150, 'raw reading is preserved');
    assert.equal(cleaned[1]!.smoothedSpeedKph, 50, 'colouring uses the median');
  });

  test('keeps a genuinely fast but plausible stretch', () => {
    const cleaned = cleanTrack([at(0, { speedKph: 110 }), at(1, { speedKph: 112 })]);
    assert.equal(cleaned.length, 2);
  });
});
