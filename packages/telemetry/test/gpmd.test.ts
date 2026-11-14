import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseTracks } from '../src/mp4.ts';
import {
  readTelemetry, findTelemetryTrack, resolveTimestamp, clipStartMs,
} from '../src/gpmd.ts';
import { cleanTrack } from '../src/clean.ts';
import { bearingDeg, haversineMeters, kphToMph } from '../src/geo.ts';
import { fileReader, CARD, REFERENCE_CLIP, REFERENCE_REAR } from './helpers.ts';

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
    // ddmm.mmmmm: 4145.97594 is 41 degrees 45.97594 minutes.
    assert.equal(first.latitude.toFixed(5), '41.76627');
    assert.equal(first.longitude.toFixed(5), '-70.58878');
    assert.equal(first.speedKnots, 59.379);
    assert.equal(first.speedKph, 109.974);
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

  // Heading agrees with the computed bearing under *either* coordinate reading,
  // because ddmm.mmmmm scales latitude and longitude deltas equally -- so this
  // check cannot pin the scale on its own. It is kept because it does catch a
  // swapped or misaligned coordinate pair.
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

  // The check that actually pins the coordinate scale. GPS-derived speed and
  // the reported speed must agree; reading the coordinates as decimal degrees
  // instead of ddmm.mmmmm shrinks every distance by a factor of ~1.67 and
  // breaks that agreement.
  test('GPS-derived speed matches the reported speed', async () => {
    const points = cleanTrack(await readTelemetry(reader));
    const moving = points.filter((p) => p.speedKph > 40);
    assert.ok(moving.length > 20, 'clip has a moving stretch to test against');

    let sumRatio = 0;
    let samples = 0;
    for (let i = 1; i < moving.length; i++) {
      const a = moving[i - 1]!;
      const b = moving[i]!;
      const seconds = (b.timestampMs - a.timestampMs) / 1000;
      if (seconds <= 0 || seconds > 2) continue;
      const derivedKph = (haversineMeters(a, b) / seconds) * 3.6;
      sumRatio += derivedKph / a.speedKph;
      samples++;
    }
    const ratio = sumRatio / samples;
    assert.ok(ratio > 0.9 && ratio < 1.1, `derived/reported speed ratio was ${ratio.toFixed(3)}`);
  });

  // The camera burns its own reading into the picture, which is independent
  // ground truth for the whole field table.
  test('matches the position the camera burned into the video', async () => {
    const clip = await fileReader(`${CARD}/front_norm/2026_08_04_133634_00.MP4`);
    try {
      const points = await readTelemetry(clip);
      // Overlay at 13:37:07 reads "W71.4938 N42.2969 64.1MPH".
      const at = points.find((p) => p.localTime.hour === 13 && p.localTime.minute === 37
        && p.localTime.second === 7)!;
      assert.ok(at, 'sample for 13:37:07 present');
      assert.equal(at.latitude.toFixed(4), '42.2969');
      assert.equal(at.longitude.toFixed(4), '-71.4938');
      assert.equal(kphToMph(at.speedKph).toFixed(0), '64');
    } finally {
      await clip.close();
    }
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
    assert.equal(sparse[0]!.latitude.toFixed(5), '41.76627');
  });
});

describe('cleanTrack', () => {
  const base = {
    index: 0,
    localTime: { year: 2026, month: 8, day: 1, hour: 11, minute: 23, second: 29 },
    utcTime: { hour: 19, minute: 23, second: 29 },
    timestampMs: Date.UTC(2026, 7, 1, 19, 23, 29),
    latitude: 42.1, longitude: -71.3, speedKph: 50, speedKnots: 27, headingDeg: 90,
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

describe('resolveTimestamp', () => {
  const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
  const local = (y: number, mo: number, d: number, h: number, mi = 0, sec = 0) =>
    ({ year: y, month: mo, day: d, hour: h, minute: mi, second: sec });

  test('pairs the local date with the UTC time of day', () => {
    // 11:23:29 local, 19:23:29 UTC -- an eight-hour offset, same date.
    assert.equal(
      resolveTimestamp(local(2026, 8, 1, 11, 23, 29), { hour: 19, minute: 23, second: 29 }),
      Date.UTC(2026, 7, 1, 19, 23, 29),
    );
  });

  // Without this the clip lands 24 hours in the past.
  test('rolls forward when UTC is already the next day', () => {
    // 20:00 local on 4 Aug in US Eastern is 00:00 UTC on 5 Aug.
    assert.equal(
      resolveTimestamp(local(2026, 8, 4, 20), { hour: 0, minute: 0, second: 0 }),
      utc(2026, 8, 5, 0),
    );
  });

  test('rolls back when UTC is still the previous day', () => {
    // 02:00 local on 1 Jan in Tokyo is 17:00 UTC on 31 Dec.
    assert.equal(
      resolveTimestamp(local(2026, 1, 1, 2), { hour: 17, minute: 0, second: 0 }),
      utc(2025, 12, 31, 17),
    );
  });

  test('leaves plausible offsets alone at both extremes', () => {
    // UTC-11 and UTC+13 are both real zones and must not be shifted.
    assert.equal(
      resolveTimestamp(local(2026, 8, 4, 1), { hour: 12, minute: 0, second: 0 }),
      utc(2026, 8, 4, 12),
    );
    assert.equal(
      resolveTimestamp(local(2026, 8, 4, 13), { hour: 0, minute: 0, second: 0 }),
      utc(2026, 8, 4, 0),
    );
  });
});

describe('no-fix date sentinel', () => {
  // Before the receiver gets a fix the camera writes 0xFFFFFFFF into the date
  // fields. Date.UTC turns that into NaN, which then propagates into every
  // downstream time comparison instead of failing loudly.
  const SENTINEL = 0xffffffff;

  test('resolveTimestamp rejects the sentinel rather than returning NaN silently', () => {
    const at = resolveTimestamp(
      { year: SENTINEL, month: SENTINEL, day: SENTINEL, hour: 21, minute: 33, second: 51 },
      { hour: 21, minute: 33, second: 51 },
    );
    assert.ok(Number.isNaN(at));
  });

  test('resolveTimestamp rejects implausible dates', () => {
    assert.ok(Number.isNaN(resolveTimestamp(
      { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
      { hour: 0, minute: 0, second: 0 })));
    assert.ok(Number.isNaN(resolveTimestamp(
      { year: 2026, month: 0, day: 1, hour: 0, minute: 0, second: 0 },
      { hour: 0, minute: 0, second: 0 })));
  });

  test('clipStartMs skips leading fixless samples and back-dates to video zero', () => {
    const anchor = Date.UTC(2026, 7, 4, 21, 33, 34);
    const points = [
      { index: 0, timestampMs: Number.NaN },
      { index: 1, timestampMs: Number.NaN },
      { index: 2, timestampMs: anchor + 2000 },
      { index: 3, timestampMs: anchor + 3000 },
    ] as any[];
    assert.equal(clipStartMs(points), anchor);
  });

  test('clipStartMs gives up when nothing in the clip ever had a fix', () => {
    assert.equal(clipStartMs([{ index: 0, timestampMs: Number.NaN }] as any[]), undefined);
  });
});

describe('anchoring a real clip that starts without a fix', { skip: existsSync(CARD) ? false : 'card not mounted' }, () => {
  // This clip's first sample has the sentinel date; anchoring playback to it
  // froze the map and the speed readout on the trip's first point.
  test('the anchor is the clip start, not the first sample', async () => {
    const clip = await fileReader(`${CARD}/front_norm/2026_08_04_133333_00.MP4`);
    try {
      const points = await readTelemetry(clip);
      assert.ok(Number.isNaN(points[0]!.timestampMs), 'first sample really has no date');

      const anchor = clipStartMs(points);
      assert.ok(anchor !== undefined && Number.isFinite(anchor));
      // Clips are 60s, so the next clip in the trip starts a minute later.
      const next = await fileReader(`${CARD}/front_norm/2026_08_04_133434_00.MP4`);
      try {
        const following = clipStartMs(await readTelemetry(next, { stride: 5 }))!;
        assert.equal((following - anchor!) / 1000, 60);
      } finally {
        await next.close();
      }
    } finally {
      await clip.close();
    }
  });
});

// On this clip the firmware writes one heading at a scale of 1000 instead of
// 100 (raw 9100 meaning 9.1 degrees). Read at a fixed /100 it came out as 91
// degrees in the middle of a northbound stretch -- or, on other clips, as 901.
const HEADING_SCALE_CLIP = `${CARD}/front_norm/2026_10_11_135913_00.MP4`;
describe('heading scale', {
  skip: existsSync(HEADING_SCALE_CLIP) ? false : `clip not on card (${HEADING_SCALE_CLIP})`,
}, () => {
  test('honours the per-sample scale factor', async () => {
    const reader = await fileReader(HEADING_SCALE_CLIP);
    try {
      const points = cleanTrack(await readTelemetry(reader));
      for (const p of points) assert.ok(p.headingDeg >= 0 && p.headingDeg < 360, `heading ${p.headingDeg}`);
      // No moving sample may disagree with both neighbours by more than a
      // car can turn in a second at speed.
      for (let i = 1; i < points.length - 1; i++) {
        const [a, b, c] = [points[i - 1]!, points[i]!, points[i + 1]!];
        if (b.smoothedSpeedKph < 30) continue;
        const d = (x: number, y: number) => Math.abs(((x - y + 540) % 360) - 180);
        const neighbours = d(a.headingDeg, c.headingDeg);
        assert.ok(!(d(a.headingDeg, b.headingDeg) > 30 && d(b.headingDeg, c.headingDeg) > 30 && neighbours < 10),
          `heading spike at sample ${i}: ${a.headingDeg} ${b.headingDeg} ${c.headingDeg}`);
      }
    } finally { await reader.close(); }
  });
});
