import { useMemo, useState } from 'react';
import { formatDuration, kphToMph } from '@wolfbox/telemetry';
import type { CardTrip } from '../card.ts';
import type { RoutePreview, TripStatsEntry } from '../tripStats.ts';
import { selectTrips, tripDurationMs, type TripSort } from '../tripView.ts';
import { cardTotals, formatSpan, matchesBand, type BandFilter } from '../overview.ts';
import { colorForMph, type Theme } from '../speedScale.ts';
import { formatLocal, type TimeContext } from '../time.ts';
import { metersToMiles } from '../units.ts';
import { RiskRing, RiskReasons, BAND_LABEL } from './Risk.tsx';

const DAY: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'short', day: 'numeric' };
const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/**
 * The card at a glance: what was driven, how it went, and which drives to
 * watch first.
 *
 * This is the screen a parent lands on. The header answers "how much and how
 * risky" for the whole card; the grid below is every drive as a card with its
 * route, score and reasons, so the riskiest are visible without opening
 * anything. Opening a card goes to the review screen for that drive.
 */
export function DriveOverview({
  drives, events, stats, sort, onSortChange, onOpen, time, theme,
}: {
  drives: CardTrip[];
  events: CardTrip[];
  stats: ReadonlyMap<string, TripStatsEntry>;
  sort: TripSort;
  onSortChange: (sort: TripSort) => void;
  onOpen: (trip: CardTrip) => void;
  time: TimeContext;
  theme: Theme;
}) {
  const [band, setBand] = useState<BandFilter>('all');
  const [showEvents, setShowEvents] = useState(false);

  const totals = useMemo(() => cardTotals(drives.map((d) => d.id), stats), [drives, stats]);
  const visible = useMemo(() => selectTrips(drives, [], 'drives', sort, (trip) => {
    const entry = stats.get(trip.id);
    return entry?.status === 'ready' ? entry.risk?.score : undefined;
  }).filter((trip) => matchesBand(stats.get(trip.id), band)), [drives, stats, sort, band]);

  const grouped = sort === 'newest' || sort === 'oldest';
  const sections: { day: string | null; trips: CardTrip[] }[] = [];
  for (const trip of visible) {
    const day = grouped ? formatLocal(trip.startLocalMs, time, DAY) : null;
    const last = sections.at(-1);
    if (last && last.day === day) last.trips.push(trip);
    else sections.push({ day, trips: [trip] });
  }

  const progress = totals.read < totals.drives
    ? `Reading GPS · ${totals.read} of ${totals.drives}`
    : totals.limitsChecked < totals.read
      ? `Checking speed limits · ${totals.limitsChecked} of ${totals.read}`
      : null;

  return (
    <div className="overview">
      <section className="overview-hero glass" aria-label="This card">
        <div className="hero-score">
          <AverageRing score={totals.averageScore} />
          <div>
            <span className="eyebrow">Average score</span>
            <strong className="hero-title">
              {totals.averageScore === null ? 'Scoring…'
                : totals.byBand.high > 0
                  ? `${totals.byBand.high} high-risk drive${totals.byBand.high === 1 ? '' : 's'}`
                  : 'No high-risk drives'}
            </strong>
            {progress && <span className="hero-progress">{progress}</span>}
          </div>
        </div>
        <dl className="kpis">
          <Kpi label="Drives" value={String(totals.drives)} />
          <Kpi label="Distance" value={totals.miles.toFixed(0)} unit="mi" />
          <Kpi label="Driving time" value={formatSpan(totals.movingSec)} />
          <Kpi label="Over the limit" value={formatSpan(totals.overLimitSec)} tone={totals.overLimitSec > 0 ? 'warn' : undefined} />
          <Kpi label="Hard events" value={String(totals.hardEvents)} tone={totals.hardEvents > 0 ? 'warn' : undefined} />
          <Kpi label="Top speed" value={totals.topMph.toFixed(0)} unit="mph" tone={totals.topMph >= 80 ? 'danger' : undefined} />
        </dl>
      </section>

      <div className="overview-toolbar">
        <div className="segmented" role="group" aria-label="Filter by risk">
          {([
            ['all', 'All', totals.drives],
            ['high', 'High risk', totals.byBand.high],
            ['moderate', 'Some risk', totals.byBand.moderate],
            ['low', 'Low risk', totals.byBand.low],
          ] as const).map(([value, label, count]) => (
            <button
              key={value}
              className={band === value ? 'selected' : ''}
              aria-pressed={band === value}
              onClick={() => setBand(value)}
            >
              {value !== 'all' && <span className={`dot dot--${value}`} aria-hidden="true" />}
              {label} <span className="count">{count}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="sort">
          Sort
          <select value={sort} onChange={(event) => onSortChange(event.target.value as TripSort)}>
            <option value="riskiest">Riskiest first</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="longest">Longest first</option>
          </select>
        </label>
      </div>

      {visible.length === 0 && (
        <p className="overview-empty glass">
          {band === 'all' ? 'No drives on this card.' : `No ${BAND_LABEL[band as Exclude<BandFilter, 'all'>].toLowerCase()} drives.`}
        </p>
      )}

      {sections.map(({ day, trips }) => (
        <section key={day ?? 'all'} className="overview-section">
          {day && <h2 className="overview-day">{day}</h2>}
          <div className="drive-grid">
            {trips.map((trip) => (
              <DriveCard
                key={trip.id} trip={trip} entry={stats.get(trip.id)}
                time={time} theme={theme} showDay={!grouped}
                onOpen={() => onOpen(trip)}
              />
            ))}
          </div>
        </section>
      ))}

      {events.length > 0 && (
        <section className="overview-section">
          <button className="overview-day overview-day--toggle" onClick={() => setShowEvents(!showEvents)} aria-expanded={showEvents}>
            Parking events <span className="count">{events.length}</span>
            <span className="fold-glyph" aria-hidden="true">{showEvents ? '−' : '+'}</span>
          </button>
          {showEvents && (
            <div className="event-chips">
              {[...events].sort((a, b) => b.startLocalMs - a.startLocalMs).map((trip) => (
                <button key={trip.id} className="event-chip glass" onClick={() => onOpen(trip)}>
                  <strong>{formatLocal(trip.startLocalMs, time, CLOCK)}</strong>
                  <span>{formatLocal(trip.startLocalMs, time, { month: 'short', day: 'numeric' })}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Kpi({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: 'warn' | 'danger' }) {
  return (
    <div className={tone ? `kpi kpi--${tone}` : 'kpi'}>
      <dt>{label}</dt>
      <dd>{value}{unit && <small> {unit}</small>}</dd>
    </div>
  );
}

const AVG_RING = 2 * Math.PI * 26;

function AverageRing({ score }: { score: number | null }) {
  const band = score === null ? 'none' : score >= 85 ? 'low' : score >= 65 ? 'moderate' : 'high';
  return (
    <svg className={`average-ring risk-ring--${band}`} viewBox="0 0 64 64" width="72" height="72" aria-hidden="true">
      <circle className="risk-ring-track" cx="32" cy="32" r="26" />
      {score !== null && (
        <circle
          className="risk-ring-value" cx="32" cy="32" r="26"
          strokeDasharray={AVG_RING} strokeDashoffset={AVG_RING * (1 - score / 100)}
          transform="rotate(-90 32 32)"
        />
      )}
      <text x="32" y="38" textAnchor="middle">{score ?? '–'}</text>
    </svg>
  );
}

function DriveCard({
  trip, entry, time, theme, showDay, onOpen,
}: {
  trip: CardTrip;
  entry?: TripStatsEntry;
  time: TimeContext;
  theme: Theme;
  showDay: boolean;
  onOpen: () => void;
}) {
  const minutes = Math.round(tripDurationMs(trip) / 60_000);
  const ready = entry?.status === 'ready' ? entry : undefined;
  const band = ready?.risk?.band;
  const route = ready && (ready.startLabel || ready.endLabel)
    ? `${ready.startLabel ?? 'Unknown'} → ${ready.endLabel ?? 'Unknown'}`
    : null;

  return (
    <button className={`drive-card glass${band ? ` drive-card--${band}` : ''}`} onClick={onOpen}>
      <div className="drive-card-map">
        {ready && ready.route.length > 1
          ? <RouteThumb route={ready.route} theme={theme} />
          : <span className="drive-card-map-empty">{entry?.status === 'unavailable' ? 'No GPS' : 'Reading GPS…'}</span>}
        <span className="drive-card-ring"><RiskRing entry={entry} size={44} /></span>
      </div>
      <div className="drive-card-body">
        <div className="drive-card-when">
          <strong>{formatLocal(trip.startLocalMs, time, CLOCK)}</strong>
          {showDay && <span>{formatLocal(trip.startLocalMs, time, { weekday: 'short', month: 'short', day: 'numeric' })}</span>}
          {band && <span className={`band-label band-label--${band}`}>{BAND_LABEL[band]}</span>}
          {trip.hasEvent && <span className="badge badge--warn">event</span>}
        </div>
        {route && <span className="drive-card-route">{route}</span>}
        <span className="drive-card-figures">
          {ready ? (
            <>
              <span>{metersToMiles(ready.distanceMeters).toFixed(1)} mi</span>
              <span>{minutes} min</span>
              <span>{Math.round(kphToMph(ready.maxSpeedKph))} mph top</span>
              <span>{Math.round(kphToMph(ready.averageMovingSpeedKph))} avg</span>
              {ready.risk?.speeding && ready.risk.speeding.stretchSec > 0 && (
                <span className="trip-figures-over">{formatDuration(ready.risk.speeding.stretchSec)} over</span>
              )}
            </>
          ) : <span>{minutes} min</span>}
        </span>
        <RiskReasons entry={entry} max={3} />
      </div>
    </button>
  );
}

const THUMB_W = 240;
const THUMB_H = 120;
const PAD = 12;
/** Kept clear on the right, where the score ring overlaps the map. */
const RING_GUTTER = 44;

/**
 * The route as a small speed-coloured line, in the same colours as the map.
 * Projected equirectangularly with the longitude scaled by latitude, which is
 * exact enough at the scale of one drive and keeps a north-south road upright.
 */
function RouteThumb({ route, theme }: { route: RoutePreview; theme: Theme }) {
  const lat0 = route[0]![0];
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = route.map(([, lon]) => lon * kx);
  const ys = route.map(([lat]) => lat);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // A drive that barely moved would otherwise be blown up to fill the box.
  const MIN_SPAN = 0.002;
  const scale = Math.min(
    (THUMB_W - 2 * PAD - RING_GUTTER) / Math.max(maxX - minX, MIN_SPAN),
    (THUMB_H - 2 * PAD) / Math.max(maxY - minY, MIN_SPAN),
  );
  const ox = (THUMB_W - RING_GUTTER - (maxX - minX) * scale) / 2;
  const oy = (THUMB_H - (maxY - minY) * scale) / 2;
  const at = (i: number): [number, number] => [ox + (xs[i]! - minX) * scale, THUMB_H - (oy + (ys[i]! - minY) * scale)];

  const segments = [];
  for (let i = 1; i < route.length; i++) {
    const [x1, y1] = at(i - 1);
    const [x2, y2] = at(i);
    segments.push(
      <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={colorForMph(route[i]![2], theme)} />,
    );
  }
  const [sx, sy] = at(0);
  const [ex, ey] = at(route.length - 1);
  return (
    <svg className="route-thumb" viewBox={`0 0 ${THUMB_W} ${THUMB_H}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <g className="route-thumb-casing">
        <polyline points={route.map((_, i) => at(i).join(',')).join(' ')} />
      </g>
      <g className="route-thumb-line">{segments}</g>
      <circle className="route-thumb-start" cx={sx} cy={sy} r="4" />
      <circle className="route-thumb-end" cx={ex} cy={ey} r="4" />
    </svg>
  );
}
