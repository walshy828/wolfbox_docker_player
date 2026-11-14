import type { RiskBand } from '@wolfbox/telemetry';
import type { TripStatsEntry } from './tripStats.ts';

/** Card-wide figures for the overview header. */
export interface CardTotals {
  drives: number;
  /** Drives whose GPS has been read; the rest are still pending or have none. */
  read: number;
  /** Drives whose score includes speeding. */
  limitsChecked: number;
  miles: number;
  movingSec: number;
  /** Mean score of the drives that have one. Null while none do. */
  averageScore: number | null;
  byBand: Record<RiskBand, number>;
  overLimitSec: number;
  hardEvents: number;
  topMph: number;
}

const METERS_PER_MILE = 1609.344;
const KPH_PER_MPH = 1.609344;

export function cardTotals(
  driveIds: readonly string[],
  stats: ReadonlyMap<string, TripStatsEntry>,
): CardTotals {
  const totals: CardTotals = {
    drives: driveIds.length, read: 0, limitsChecked: 0, miles: 0, movingSec: 0,
    averageScore: null, byBand: { low: 0, moderate: 0, high: 0 },
    overLimitSec: 0, hardEvents: 0, topMph: 0,
  };
  let scoreSum = 0;
  let scored = 0;
  for (const id of driveIds) {
    const entry = stats.get(id);
    if (entry?.status !== 'ready') continue;
    totals.read++;
    if (entry.limits !== 'pending') totals.limitsChecked++;
    totals.miles += entry.distanceMeters / METERS_PER_MILE;
    totals.movingSec += entry.movingSec;
    totals.hardEvents += entry.harshEvents.moderate + entry.harshEvents.severe;
    totals.topMph = Math.max(totals.topMph, entry.maxSpeedKph / KPH_PER_MPH);
    totals.overLimitSec += entry.risk?.speeding?.stretchSec ?? 0;
    if (entry.risk) {
      scoreSum += entry.risk.score;
      scored++;
      totals.byBand[entry.risk.band]++;
    }
  }
  totals.averageScore = scored > 0 ? Math.round(scoreSum / scored) : null;
  return totals;
}

export type BandFilter = 'all' | RiskBand;

/** Whether a drive passes the overview's risk filter. Unscored drives show only under 'all'. */
export function matchesBand(entry: TripStatsEntry | undefined, filter: BandFilter): boolean {
  if (filter === 'all') return true;
  return entry?.status === 'ready' && entry.risk?.band === filter;
}

/** "3h 12m", "48m", "35s". */
export function formatSpan(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}
