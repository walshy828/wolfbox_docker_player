/**
 * Scans a dash cam card and reports its trips.
 *
 *   node --experimental-strip-types tools/scan.ts "/Volumes/NO NAME"
 *   node --experimental-strip-types tools/scan.ts "/Volumes/NO NAME" --trip 3
 *
 * Without --trip this uses one GPS sample per clip, so it stays fast on a card
 * with hundreds of clips. --trip reads a single trip's full 1 Hz track.
 */
import { readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ByteReader } from '../src/reader.ts';
import { parseClipName, buildTrips, CLIP_FOLDERS, type ClipRef } from '../src/catalog.ts';
import { readTelemetry, type TelemetryPoint } from '../src/gpmd.ts';
import { cleanTrack } from '../src/clean.ts';
import { summarize } from '../src/summary.ts';
import { kphToMph } from '../src/geo.ts';

const root = process.argv[2] ?? '/Volumes/NO NAME';
const tripArg = process.argv.indexOf('--trip');
const tripIndex = tripArg > 0 ? Number(process.argv[tripArg + 1]) : null;

async function readerFor(path: string): Promise<ByteReader & { close(): Promise<void> }> {
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const buf = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      if (buf.length === 0) return buf;
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      return buf.subarray(0, bytesRead);
    },
    close: () => handle.close(),
  };
}

const clips: ClipRef<string>[] = [];
for (const folder of CLIP_FOLDERS) {
  let names: string[];
  try { names = readdirSync(`${root}/${folder}`); } catch { continue; }
  for (const name of names) {
    const parsed = parseClipName(folder, name);
    if (parsed) clips.push({ ...parsed, handle: `${root}/${folder}/${name}` });
  }
}

const trips = buildTrips(clips);
const paired = trips.flatMap((t) => t.clips).filter((c) => c.front && c.rear).length;
const localDate = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

console.log(`card      ${root}`);
console.log(`clips     ${clips.length} (${paired} front/rear pairs)`);
console.log(`trips     ${trips.length}`);
console.log(`span      ${localDate(trips[0]!.startLocalMs)} .. ${localDate(trips.at(-1)!.endLocalMs)}\n`);

async function trackFor(trip: (typeof trips)[number], stride: number): Promise<TelemetryPoint[]> {
  const points: TelemetryPoint[] = [];
  for (const pair of trip.clips) {
    const clip = pair.front ?? pair.rear;
    if (!clip) continue;
    const reader = await readerFor(clip.handle);
    try { points.push(...(await readTelemetry(reader, { stride }))); }
    catch { /* a truncated clip should not abort the scan */ }
    finally { await reader.close(); }
  }
  return points.sort((a, b) => a.timestampMs - b.timestampMs);
}

if (tripIndex === null) {
  console.log('  #  when              clips  span     approx distance  max speed');
  for (const [i, trip] of trips.entries()) {
    const summary = summarize(cleanTrack(await trackFor(trip, 60)));
    const minutes = Math.round((trip.endLocalMs - trip.startLocalMs) / 60_000);
    const km = summary ? (summary.distanceMeters / 1000).toFixed(1) : '  - ';
    const mph = summary ? kphToMph(summary.maxSpeedKph).toFixed(0) : ' -';
    console.log(
      `${String(i).padStart(3)}  ${localDate(trip.startLocalMs)}  ` +
      `${String(trip.clips.length).padStart(5)}  ${String(minutes).padStart(4)}m  ` +
      `${km.padStart(13)} km  ${mph.padStart(7)} mph${trip.hasEvent ? '  [event]' : ''}`,
    );
  }
} else {
  const trip = trips[tripIndex];
  if (!trip) { console.error(`no trip ${tripIndex}`); process.exit(1); }
  const started = Date.now();
  const points = cleanTrack(await trackFor(trip, 1));
  const s = summarize(points)!;
  const f = (n: number) => n.toFixed(1);
  console.log(`trip ${tripIndex}: ${trip.clips.length} clips, ${points.length} GPS points ` +
              `(read in ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`  duration     ${f(s.durationSec / 60)} min  (${f(s.movingSec / 60)} moving, ${f(s.stoppedSec / 60)} stopped)`);
  console.log(`  distance     ${f(s.distanceMeters / 1000)} km / ${f(s.distanceMeters / 1609.344)} mi`);
  console.log(`  avg speed    ${f(kphToMph(s.averageSpeedKph))} mph overall, ${f(kphToMph(s.averageMovingSpeedKph))} mph moving`);
  console.log(`  max speed    ${f(kphToMph(s.maxSpeedKph))} mph`);
  console.log(`  start        ${s.start!.latitude.toFixed(5)}, ${s.start!.longitude.toFixed(5)}`);
  console.log(`  end          ${s.end!.latitude.toFixed(5)}, ${s.end!.longitude.toFixed(5)}`);
  console.log(`  harsh events ${s.harshEvents.length}`);
  const labels = ['0-15', '15-30', '30-45', '45-60', '60+'];
  console.log('  time by speed (mph):');
  for (const [i, label] of labels.entries()) {
    const sec = s.histogramMph[i] ?? 0;
    const bar = '#'.repeat(Math.round((sec / Math.max(...s.histogramMph, 1)) * 40));
    console.log(`    ${label.padStart(5)}  ${String(Math.round(sec)).padStart(5)}s  ${bar}`);
  }
}
