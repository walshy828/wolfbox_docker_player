import {
  assessRisk, type CleanPoint, type DriveRisk, type HarshEvent, type OverLimitStretch,
  type TripAdherence, type TripSummary, type LimitSource, type ClipRef, pairClips,
} from '@wolfbox/telemetry';
import type { CardTrip, RemoteClip, ReviewTrip } from './card.ts';
import type { RoutePreview, TripStatsEntry } from './tripStats.ts';
import { previewRoute } from './tripStats.ts';
import { vehicleAt } from './vehicle.ts';

/**
 * Talks to the drive archive on the local service (server/archive.py).
 *
 * Importing sends what the app already knows about a drive -- the cleaned
 * 1 Hz track, the limit at each sample, events, score and place names -- and
 * then, if asked, each clip's video. The server keys drives by trip id, so
 * importing again updates rather than duplicates, and clips it already holds
 * at the right size are skipped.
 */

const BASE = '/api/archive';
/** Infinity (an unlimited road) cannot travel as JSON; the server uses this. */
export const UNLIMITED_KPH = 9999;

export interface ArchiveStatus {
  enabled: boolean;
  trips: number;
  storedClips: number;
  videoBytes: number;
  freeBytes: number;
}

export interface Driver { id: number; name: string }

export interface ArchivedClip {
  name: string;
  camera: 'front' | 'rear';
  kind: 'normal' | 'event' | 'photo';
  startLocalMs: number;
  startMs: number | null;
  size: number;
  stored: boolean;
}

/** A drive as the archive lists it: everything but the track. */
export interface ArchivedTrip {
  id: string;
  startLocalMs: number;
  endLocalMs: number;
  startMs: number | null;
  endMs: number | null;
  cameraOffsetMs: number | null;
  driverId: number | null;
  driverName: string | null;
  hasEvent: boolean;
  distanceMeters: number;
  durationSec: number | null;
  movingSec: number | null;
  maxSpeedKph: number | null;
  averageMovingSpeedKph: number | null;
  hardEvents: number;
  severeEvents: number;
  overLimitSec: number;
  startLabel: string | null;
  endLabel: string | null;
  summary: Partial<TripSummary>;
  risk: DriveRisk | null;
  route: RoutePreview;
  importedMs: number;
  clips: ArchivedClip[];
}

interface PointColumns {
  t: number[]; lat: number[]; lon: number[]; kph: number[]; skph: number[]; hdg: number[];
  ax: number[]; ay: number[]; az: number[];
  limit: (number | null)[]; src: (LimitSource | null)[];
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `${response.status}`;
    try { detail = (await response.json()).detail ?? detail; } catch { /* not JSON */ }
    throw new Error(`Archive: ${detail}`);
  }
  return response.json() as Promise<T>;
}

/** Null when there is no service, or it has no archive -- the app then works from the card alone. */
export async function archiveStatus(): Promise<ArchiveStatus | null> {
  try {
    const response = await fetch(`${BASE}/status`);
    if (!response.ok) return null;
    return await response.json() as ArchiveStatus;
  } catch {
    return null;
  }
}

export const listArchived = () => fetch(`${BASE}/trips`).then((r) => json<ArchivedTrip[]>(r));
export const listDrivers = () => fetch(`${BASE}/drivers`).then((r) => json<Driver[]>(r));

export const addDriver = (name: string) => fetch(`${BASE}/drivers`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
}).then((r) => json<Driver>(r));

export const setTripDriver = (tripId: string, driverId: number | null) => fetch(`${BASE}/trips/${tripId}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ driverId }),
}).then((r) => json<ArchivedTrip>(r));

export const deleteArchived = (tripId: string) =>
  fetch(`${BASE}/trips/${tripId}`, { method: 'DELETE' }).then((r) => json<unknown>(r));

export const clipUrl = (tripId: string, name: string) => `${BASE}/trips/${tripId}/clips/${name}`;

// --- importing ---------------------------------------------------------------

export interface ImportInput {
  trip: CardTrip;
  points: CleanPoint[];
  summary: TripSummary;
  clipStarts: { front?: number; rear?: number }[];
  adherence: TripAdherence | null;
  startLabel?: string;
  endLabel?: string;
  cameraOffsetMs?: number;
  driverId: number | null;
}

/** The body of `POST /api/archive/trips`. Exported for tests. */
export function buildImportPayload(input: ImportInput) {
  const { trip, points, summary, adherence } = input;
  const risk = assessRisk({ summary, adherence });
  const limit = (i: number) => {
    const kph = adherence?.limitKph[i];
    return kph === undefined ? null : Number.isFinite(kph) ? kph : UNLIMITED_KPH;
  };

  const at = (ms: number) => vehicleAt(points, ms);
  const events = [
    ...summary.harshEvents.map((event: HarshEvent) => {
      const where = at(event.peakAtMs);
      return {
        kind: event.kind, severity: event.severity,
        startMs: event.startMs, endMs: event.endMs, peakAtMs: event.peakAtMs,
        lat: where?.latitude ?? null, lon: where?.longitude ?? null,
        value: event.peakG,
        detail: { direction: event.direction ?? null, speedKph: event.speedKph, peakDeltaKph: event.peakDeltaKph },
      };
    }),
    ...(adherence?.stretches ?? []).map((stretch: OverLimitStretch) => {
      const where = at(stretch.startMs);
      return {
        kind: 'speeding', severity: stretch.severity,
        startMs: stretch.startMs, endMs: stretch.endMs, peakAtMs: null,
        lat: where?.latitude ?? null, lon: where?.longitude ?? null,
        value: stretch.peakExcessKph,
        detail: {
          limitKph: stretch.limitKph, limitSource: stretch.limitSource, roadName: stretch.roadName ?? null,
          peakSpeedKph: stretch.peakSpeedKph, durationSec: stretch.durationSec,
        },
      };
    }),
  ];

  const clips = trip.clips.flatMap((pair, i) => (['front', 'rear'] as const).flatMap((camera) => {
    const clip = pair[camera];
    return clip ? [{
      name: clip.name, camera, kind: clip.kind, startLocalMs: clip.startLocalMs,
      startMs: input.clipStarts[i]?.[camera] ?? null,
      size: 0, // filled in from the file by `importTrip`
    }] : [];
  }));

  const { harshEvents: _events, ...summaryFields } = summary;
  return {
    id: trip.id,
    startLocalMs: trip.startLocalMs,
    endLocalMs: trip.endLocalMs,
    cameraOffsetMs: input.cameraOffsetMs ?? null,
    hasEvent: trip.hasEvent,
    driverId: input.driverId,
    summary: summaryFields,
    risk,
    route: previewRoute(points),
    startLabel: input.startLabel ?? null,
    endLabel: input.endLabel ?? null,
    points: {
      t: points.map((p) => p.timestampMs),
      lat: points.map((p) => p.latitude),
      lon: points.map((p) => p.longitude),
      kph: points.map((p) => p.speedKph),
      skph: points.map((p) => p.smoothedSpeedKph),
      hdg: points.map((p) => p.headingDeg),
      ax: points.map((p) => p.accel.x),
      ay: points.map((p) => p.accel.y),
      az: points.map((p) => p.accel.z),
      limit: points.map((_, i) => limit(i)),
      src: points.map((_, i) => adherence?.limitSource[i] ?? null),
    } satisfies PointColumns,
    events,
    clips,
  };
}

export interface ImportProgress {
  phase: 'data' | 'video' | 'done';
  /** Bytes of video sent so far, and in total, for this drive. */
  sentBytes: number;
  totalBytes: number;
}

/**
 * Imports one drive: its data, then -- if `withVideo` -- each clip the archive
 * does not already hold. Clips upload one at a time; the card reader, not the
 * network, is usually the bottleneck, and one at a time keeps progress honest.
 */
export async function importTrip(
  input: ImportInput,
  options: { withVideo: boolean; signal?: AbortSignal; onProgress?: (progress: ImportProgress) => void },
): Promise<void> {
  const body = buildImportPayload(input);
  const files = new Map<string, File>();
  for (const pair of input.trip.clips) {
    for (const clip of [pair.front, pair.rear]) {
      if (clip) files.set(clip.name, await clip.handle.getFile());
    }
  }
  for (const clip of body.clips) clip.size = files.get(clip.name)?.size ?? 0;

  options.onProgress?.({ phase: 'data', sentBytes: 0, totalBytes: 0 });
  const result = await json<{ storedClips: string[] }>(await fetch(`${BASE}/trips`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  }));

  if (options.withVideo) {
    const already = new Set(result.storedClips);
    const pending = [...files.entries()].filter(([name]) => !already.has(name));
    const totalBytes = pending.reduce((sum, [, file]) => sum + file.size, 0);
    let sentBytes = 0;
    options.onProgress?.({ phase: 'video', sentBytes, totalBytes });
    for (const [name, file] of pending) {
      await json(await fetch(clipUrl(input.trip.id, name), {
        method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: file, signal: options.signal,
      }));
      sentBytes += file.size;
      options.onProgress?.({ phase: 'video', sentBytes, totalBytes });
    }
  }
  options.onProgress?.({ phase: 'done', sentBytes: 0, totalBytes: 0 });
}

// --- reading back ------------------------------------------------------------

/**
 * An archived drive as a trip the review screen can open. Front and rear are
 * re-paired the way the card is, by start time within the drift tolerance, so
 * an archived drive plays exactly as it did from the card.
 */
export function toReviewTrip(archived: ArchivedTrip): ReviewTrip {
  const refs: ClipRef<RemoteClip>[] = archived.clips.map((clip) => ({
    name: clip.name,
    camera: clip.camera,
    kind: clip.kind,
    startLocalMs: clip.startLocalMs,
    handle: {
      kind: 'remote', url: clipUrl(archived.id, clip.name), name: clip.name,
      size: clip.size, stored: clip.stored,
    },
  }));
  return {
    id: archived.id,
    startLocalMs: archived.startLocalMs,
    endLocalMs: archived.endLocalMs,
    clips: pairClips(refs),
    hasEvent: archived.hasEvent,
    archived,
  };
}

/** Absolute start of each camera's file per clip pair, as stored at import. */
export function archivedClipStarts(trip: ReviewTrip): { front?: number; rear?: number }[] {
  const byName = new Map(trip.archived?.clips.map((clip) => [clip.name, clip.startMs]) ?? []);
  return trip.clips.map((pair) => ({
    front: pair.front ? byName.get(pair.front.name) ?? undefined : undefined,
    rear: pair.rear ? byName.get(pair.rear.name) ?? undefined : undefined,
  }));
}

/** The same figures the trip list computes for a card drive, read from what was archived. */
export function toStatsEntry(archived: ArchivedTrip): TripStatsEntry {
  return {
    status: 'ready',
    distanceMeters: archived.distanceMeters,
    maxSpeedKph: archived.maxSpeedKph ?? 0,
    averageMovingSpeedKph: archived.averageMovingSpeedKph ?? 0,
    movingSec: archived.movingSec ?? 0,
    startLabel: archived.startLabel ?? undefined,
    endLabel: archived.endLabel ?? undefined,
    harshEvents: { moderate: archived.hardEvents - archived.severeEvents, severe: archived.severeEvents },
    limits: archived.risk?.includesSpeeding ? 'ready' : 'unavailable',
    risk: archived.risk,
    route: archived.route,
  };
}

/** An archived drive's track, rebuilt into the points the rest of the app works from. */
export async function loadArchivedPoints(tripId: string, signal?: AbortSignal): Promise<CleanPoint[]> {
  const c = await json<PointColumns>(await fetch(`${BASE}/trips/${tripId}/points`, { signal }));
  return c.t.map((timestampMs, i) => {
    const date = new Date(timestampMs);
    return {
      index: i,
      // Only `timestampMs` is read downstream; the split clock fields are
      // kept for the type, in UTC since the camera's zone is not stored per point.
      localTime: {
        year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
        hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(),
      },
      utcTime: { hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() },
      timestampMs,
      latitude: c.lat[i]!,
      longitude: c.lon[i]!,
      speedKph: c.kph[i]!,
      speedKnots: c.kph[i]! / 1.852,
      headingDeg: c.hdg[i]!,
      accel: { x: c.ax[i] ?? 0, y: c.ay[i] ?? 0, z: c.az[i] ?? 0 },
      hasFix: true,
      smoothedSpeedKph: c.skph[i]!,
    };
  });
}

// --- history ---------------------------------------------------------------

/** One located event from the archive, for the history map. */
export interface ArchivedEvent {
  tripId: string;
  kind: 'speeding' | 'braking' | 'acceleration' | 'cornering';
  severity: 'minor' | 'moderate' | 'severe';
  startMs: number;
  endMs: number;
  lat: number;
  lon: number;
  /** Peak km/h over the limit for speeding; peak g for the rest. */
  value: number | null;
  driverId: number | null;
  detail: Record<string, unknown> | null;
}

export const listEvents = (sinceMs = 0) =>
  fetch(`${BASE}/events?since_ms=${Math.max(0, Math.floor(sinceMs))}`).then((r) => json<ArchivedEvent[]>(r));

export interface OdometerEntry { id: number; readMs: number; miles: number; note: string | null }

export const listOdometer = () => fetch(`${BASE}/odometer`).then((r) => json<OdometerEntry[]>(r));

export const addOdometer = (reading: { readMs: number; miles: number; note?: string }) =>
  fetch(`${BASE}/odometer`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reading),
  }).then((r) => json<OdometerEntry>(r));

export const deleteOdometer = (id: number) =>
  fetch(`${BASE}/odometer/${id}`, { method: 'DELETE' }).then((r) => json<unknown>(r));
