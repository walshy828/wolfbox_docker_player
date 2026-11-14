import type { ArchivedTrip } from './archive.ts';
import { toAbsolute, type TimeContext } from './time.ts';

/**
 * Long-run figures from the archive: distance and driving per period, how each
 * driver is doing, and whether the miles recorded add up to the odometer.
 *
 * Everything here is computed in the browser from the archive's trip list,
 * which already carries each drive's summary. A family's archive is a few
 * thousand drives at most, and grouping client-side means periods follow the
 * time zone chosen in the header rather than the server's.
 */

export type HistoryRange = '30d' | '90d' | '12m' | 'all';
export type Bucket = 'day' | 'week' | 'month';

export const RANGE_LABEL: Record<HistoryRange, string> = {
  '30d': '30 days', '90d': '90 days', '12m': '12 months', all: 'All time',
};
export const bucketFor = (range: HistoryRange): Bucket =>
  range === '30d' ? 'day' : range === '90d' ? 'week' : 'month';

const DAY_MS = 86_400_000;
const METERS_PER_MILE = 1609.344;
const KPH_PER_MPH = 1.609344;

/** Key for drives with no driver set. */
export const UNASSIGNED = 'none';
export const driverKey = (trip: ArchivedTrip) => (trip.driverId === null ? UNASSIGNED : String(trip.driverId));

/** The drive's absolute start, falling back to its camera clock read through the context. */
export function tripInstant(trip: ArchivedTrip, time: TimeContext): number {
  return trip.startMs ?? toAbsolute(trip.startLocalMs, time) ?? trip.startLocalMs;
}

/** The calendar date a drive started on, as y/m/d, in the zone the header has chosen. */
export function tripDate(trip: ArchivedTrip, time: TimeContext): { y: number; m: number; d: number } {
  if (time.zone === 'camera' || trip.startMs === null) {
    // startLocalMs carries the camera's own reading in its UTC fields.
    const date = new Date(trip.startLocalMs);
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
  }
  const zone = time.zone === 'browser' ? undefined : time.zone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(trip.startMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** A calendar date as a UTC-midnight timestamp: pure calendar arithmetic, no zone. */
const calendarMs = ({ y, m, d }: { y: number; m: number; d: number }) => Date.UTC(y, m - 1, d);

/** The first calendar day of the period a date falls in. Weeks start on Monday. */
export function bucketStart(date: { y: number; m: number; d: number }, bucket: Bucket): number {
  if (bucket === 'month') return Date.UTC(date.y, date.m - 1, 1);
  const ms = calendarMs(date);
  if (bucket === 'day') return ms;
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return ms - weekday * DAY_MS;
}

function nextBucket(startMs: number, bucket: Bucket): number {
  if (bucket === 'day') return startMs + DAY_MS;
  if (bucket === 'week') return startMs + 7 * DAY_MS;
  const date = new Date(startMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

export interface PeriodTotals {
  drives: number;
  miles: number;
  movingSec: number;
  overLimitSec: number;
  hardEvents: number;
  scoreSum: number;
  scored: number;
}

export interface Period {
  /** UTC midnight of the period's first calendar day. */
  startMs: number;
  total: PeriodTotals;
  byDriver: Map<string, PeriodTotals>;
}

const emptyTotals = (): PeriodTotals => ({
  drives: 0, miles: 0, movingSec: 0, overLimitSec: 0, hardEvents: 0, scoreSum: 0, scored: 0,
});

function add(totals: PeriodTotals, trip: ArchivedTrip): void {
  totals.drives++;
  totals.miles += trip.distanceMeters / METERS_PER_MILE;
  totals.movingSec += trip.movingSec ?? 0;
  totals.overLimitSec += trip.overLimitSec;
  totals.hardEvents += trip.hardEvents;
  if (trip.risk) { totals.scoreSum += trip.risk.score; totals.scored++; }
}

export const averageScore = (totals: PeriodTotals): number | null =>
  totals.scored > 0 ? Math.round(totals.scoreSum / totals.scored) : null;

/** The drives within a range of now, by absolute start. */
export function inRange(trips: readonly ArchivedTrip[], range: HistoryRange, nowMs: number, time: TimeContext): ArchivedTrip[] {
  if (range === 'all') return [...trips];
  const days = range === '30d' ? 30 : range === '90d' ? 90 : 365;
  const since = nowMs - days * DAY_MS;
  return trips.filter((trip) => tripInstant(trip, time) >= since);
}

/**
 * Drives grouped into consecutive periods, empty periods included, so a quiet
 * week shows as a gap rather than vanishing from the axis. Runs from the
 * range's start (or the first drive, for all time) to `nowMs`.
 */
export function periods(
  trips: readonly ArchivedTrip[], range: HistoryRange, nowMs: number, time: TimeContext,
): Period[] {
  const bucket = bucketFor(range);
  const chosen = inRange(trips, range, nowMs, time);
  const byStart = new Map<number, Period>();
  for (const trip of chosen) {
    const start = bucketStart(tripDate(trip, time), bucket);
    let period = byStart.get(start);
    if (!period) byStart.set(start, period = { startMs: start, total: emptyTotals(), byDriver: new Map() });
    add(period.total, trip);
    const key = driverKey(trip);
    let mine = period.byDriver.get(key);
    if (!mine) period.byDriver.set(key, mine = emptyTotals());
    add(mine, trip);
  }

  const now = new Date(nowMs);
  const last = bucketStart({ y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() }, bucket);
  let first: number;
  if (range === 'all') {
    if (byStart.size === 0) return [];
    first = Math.min(...byStart.keys());
  } else {
    const days = range === '30d' ? 29 : range === '90d' ? 89 : 364;
    const from = new Date(nowMs - days * DAY_MS);
    first = bucketStart({ y: from.getUTCFullYear(), m: from.getUTCMonth() + 1, d: from.getUTCDate() }, bucket);
  }

  const out: Period[] = [];
  for (let start = first; start <= Math.max(last, ...byStart.keys()); start = nextBucket(start, bucket)) {
    out.push(byStart.get(start) ?? { startMs: start, total: emptyTotals(), byDriver: new Map() });
  }
  return out;
}

export interface DriverSummary {
  key: string;
  name: string;
  drives: number;
  miles: number;
  movingSec: number;
  averageScore: number | null;
  highRisk: number;
  /** Minutes over the limit per hour behind the wheel. */
  overLimitMinPerHour: number;
  /** Hard stops, launches and sharp turns per 100 miles. */
  hardPer100mi: number;
  topMph: number;
  /** Average score over the last 30 days less the 30 before; null without both. */
  trend: number | null;
}

/** How each driver is doing over the given drives, most-driven first. */
export function driverSummaries(trips: readonly ArchivedTrip[], nowMs: number, time: TimeContext): DriverSummary[] {
  const groups = new Map<string, ArchivedTrip[]>();
  for (const trip of trips) {
    const key = driverKey(trip);
    groups.set(key, [...(groups.get(key) ?? []), trip]);
  }
  const mean = (list: ArchivedTrip[]) => {
    const scored = list.filter((t) => t.risk);
    return scored.length ? scored.reduce((s, t) => s + t.risk!.score, 0) / scored.length : null;
  };
  return [...groups.entries()].map(([key, list]) => {
    const totals = emptyTotals();
    for (const trip of list) add(totals, trip);
    const recent = list.filter((t) => tripInstant(t, time) >= nowMs - 30 * DAY_MS);
    const before = list.filter((t) => {
      const at = tripInstant(t, time);
      return at < nowMs - 30 * DAY_MS && at >= nowMs - 60 * DAY_MS;
    });
    const [now30, prev30] = [mean(recent), mean(before)];
    return {
      key,
      name: list[0]!.driverName ?? 'Not assigned',
      drives: totals.drives,
      miles: totals.miles,
      movingSec: totals.movingSec,
      averageScore: averageScore(totals),
      highRisk: list.filter((t) => t.risk?.band === 'high').length,
      overLimitMinPerHour: totals.movingSec > 0 ? (totals.overLimitSec / 60) / (totals.movingSec / 3600) : 0,
      hardPer100mi: totals.miles > 0 ? (totals.hardEvents / totals.miles) * 100 : 0,
      topMph: Math.max(0, ...list.map((t) => (t.maxSpeedKph ?? 0) / KPH_PER_MPH)),
      trend: now30 !== null && prev30 !== null ? Math.round(now30 - prev30) : null,
    };
  }).sort((a, b) => b.miles - a.miles);
}

export interface OdometerReading { id: number; readMs: number; miles: number; note: string | null }

export interface MileageCheck {
  from: OdometerReading;
  to: OdometerReading;
  odometerMiles: number;
  recordedMiles: number;
  drives: number;
  /** Recorded as a share of what the odometer says was driven. Null when the odometer did not move. */
  share: number | null;
}

/**
 * Compares the odometer with the drives the archive holds, reading to reading.
 *
 * A shortfall is the expected finding, not an error: drives the card looped
 * over before they were saved, drives with the camera unplugged, and GPS that
 * took a minute to find itself at the start of each drive all go unrecorded.
 * GPS distance also runs a percent or two short of an odometer on winding roads.
 */
export function reconcile(
  readings: readonly OdometerReading[], trips: readonly ArchivedTrip[], time: TimeContext,
): MileageCheck[] {
  const ordered = [...readings].sort((a, b) => a.readMs - b.readMs);
  const checks: MileageCheck[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const from = ordered[i - 1]!;
    const to = ordered[i]!;
    const between = trips.filter((trip) => {
      const at = tripInstant(trip, time);
      return at >= from.readMs && at < to.readMs;
    });
    const recordedMiles = between.reduce((sum, trip) => sum + trip.distanceMeters / METERS_PER_MILE, 0);
    const odometerMiles = to.miles - from.miles;
    checks.push({
      from, to, odometerMiles, recordedMiles, drives: between.length,
      share: odometerMiles > 0 ? recordedMiles / odometerMiles : null,
    });
  }
  return checks;
}

/**
 * Fixed categorical slots for drivers, in the reference order (blue, orange,
 * aqua), assigned by driver id so a driver keeps their colour whatever is
 * filtered. Only three are distinguishable everywhere, so a fourth driver and
 * beyond share a neutral "other" colour; drives with no driver are grey.
 */
export const DRIVER_SLOTS = 3;
export function driverSlot(key: string, allKeys: readonly string[]): number | 'other' | 'none' {
  if (key === UNASSIGNED) return 'none';
  const ids = allKeys.filter((k) => k !== UNASSIGNED).map(Number).sort((a, b) => a - b);
  const index = ids.indexOf(Number(key));
  return index >= 0 && index < DRIVER_SLOTS ? index + 1 : 'other';
}
