import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { kphToMph } from '@wolfbox/telemetry';
import { isParkingEvent, type CardTrip } from '../card.ts';
import { describeSelection, describeTrips } from '../deletion.ts';
import { formatLocal, type TimeContext } from '../time.ts';
import { useTripAdherence, type TripAdherenceEntry } from '../tripAdherence.ts';
import { metersToMiles } from '../units.ts';
import type { TripStatsEntry } from '../tripStats.ts';
import {
  rangeSelected, selectTrips, toggleSelected, tripDurationMs,
  type TripFilter, type TripSort,
} from '../tripView.ts';
import { ConfirmInline, DeleteButton } from './ConfirmInline.tsx';

export type { TripFilter, TripSort };

interface Props {
  drives: CardTrip[];
  events: CardTrip[];
  filter: TripFilter;
  sort: TripSort;
  onFilterChange: (filter: TripFilter) => void;
  onSortChange: (sort: TripSort) => void;
  selectedId: string | null;
  onSelect: (trip: CardTrip) => void;
  /** Ids ticked for a batch delete; empty while nothing is ticked. */
  checkedIds: ReadonlySet<string>;
  onCheckedChange: (ids: Set<string>) => void;
  onDelete: (trips: CardTrip[]) => void;
  deleting: boolean;
  time: TimeContext;
  /** Distance, top speed, and start/end place, filled in progressively per trip. */
  stats: ReadonlyMap<string, TripStatsEntry>;
  /** Panel controls owned by the layout, e.g. the pin toggle. */
  actions?: ReactNode;
}

const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/**
 * Distance, top speed, and start/end place, once the background queue in
 * `useTripStats` has reached this trip. Renders nothing for a trip with no
 * GPS fix at all (a parking event under an overpass, say) rather than a blank
 * "0 mi" that would read as a real measurement.
 *
 * The top-speed figure is tinted by the drive's worst moment over a known
 * speed limit, once that lazy adherence lookup has resolved -- severe red,
 * moderate orange -- so the number that already reads as "how fast" also
 * reads as "how far over" without a second figure competing for attention.
 */
function TripStatsLine({ entry, adherence }: { entry?: TripStatsEntry; adherence?: TripAdherenceEntry }) {
  if (!entry || entry.status === 'unavailable') return null;
  if (entry.status === 'pending') {
    return <span className="trip-stats trip-stats--pending">Reading GPS&hellip;</span>;
  }

  const miles = metersToMiles(entry.distanceMeters);
  const topMph = Math.round(kphToMph(entry.maxSpeedKph));
  const route = entry.startLabel || entry.endLabel
    ? `${entry.startLabel ?? 'Unknown'} → ${entry.endLabel ?? 'Unknown'}`
    : null;
  const peakSeverity = adherence?.status === 'ready' ? adherence.peakSeverity : null;
  const topClass = peakSeverity === 'severe' ? 'top-speed top-speed--severe'
    : peakSeverity === 'moderate' ? 'top-speed top-speed--moderate'
    : 'top-speed';

  return (
    <span className="trip-stats">
      <span>{miles.toFixed(1)} mi &middot; <span className={topClass}>{topMph} mph top</span></span>
      {route && <span className="trip-route">{route}</span>}
    </span>
  );
}

function WarningTriangle() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path d="M8 1.5 L15 14.5 H1 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 6 V9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.8" r="0.9" fill="currentColor" />
    </svg>
  );
}

/**
 * Two independent triangles marking hard braking/acceleration on a row, so a
 * bad stop is visible while scanning the list rather than only after opening
 * the drive. The red triangle is always the severe count and the orange one
 * always the moderate count -- each rendered only when its own count is
 * nonzero, so a trip with both shows both rather than one badge picking the
 * worse of the two and hiding the other.
 */
function HarshEventBadges({ counts }: { counts: { moderate: number; severe: number } }) {
  if (counts.moderate === 0 && counts.severe === 0) return null;

  return (
    <>
      {counts.severe > 0 && (
        <span
          className="harsh-badge harsh-badge--severe"
          title={`${counts.severe} severe hard braking/acceleration event${counts.severe === 1 ? '' : 's'}`}
        >
          <WarningTriangle />
          {counts.severe}
        </span>
      )}
      {counts.moderate > 0 && (
        <span
          className="harsh-badge harsh-badge--moderate"
          title={`${counts.moderate} moderate hard braking/acceleration event${counts.moderate === 1 ? '' : 's'}`}
        >
          <WarningTriangle />
          {counts.moderate}
        </span>
      )}
    </>
  );
}

/**
 * Share of the drive spent at or under a known speed limit, once the lazy
 * per-row OSM lookup in `useTripAdherence` has resolved for this trip. Renders
 * nothing until then, and nothing at all if too little of the route had a
 * known limit to score.
 */
function AdherenceBadge({ adherence }: { adherence?: TripAdherenceEntry }) {
  if (!adherence || adherence.status !== 'ready' || adherence.withinShare == null) return null;
  const pct = Math.round(adherence.withinShare * 100);
  return (
    <span className="adherence-badge" title={`${pct}% of this drive was at or under the speed limit`}>
      {pct}% limit
    </span>
  );
}

const SCORE_LABEL: Record<'good' | 'fair' | 'poor', string> = {
  good: 'safe', fair: 'fair', poor: 'rough',
};

/**
 * A 0-100 drive score, badged by band. Built from braking/acceleration only
 * in this list -- speed-limit adherence needs a per-trip network lookup the
 * app only makes for the drive currently open, so it never feeds a score
 * shown here (see `driveScore.ts` and `limits.ts`).
 */
function ScoreBadge({ entry }: { entry?: TripStatsEntry }) {
  if (!entry || entry.status !== 'ready' || !entry.score) return null;
  const { value, band } = entry.score;
  return (
    <span
      className={`score-badge score-badge--${band}`}
      title={`Drive score ${value}/100 (${SCORE_LABEL[band]}) — based on hard braking and acceleration; open the drive to see speed-limit adherence.`}
    >
      {value}
    </span>
  );
}

/** Which delete is asking for confirmation: one row, or the whole selection. */
type Confirming = { kind: 'trip'; id: string } | { kind: 'selection' } | null;

/**
 * Trips down the side, filterable and sortable, scrolling independently.
 *
 * Drives and parking events are separated because the camera records an impact
 * in parking mode as an isolated one-minute clip -- 130 of them against 54 real
 * drives on the reference card -- so one merged list buries the drives.
 *
 * Clearing a card down is the other thing this list is for, hence the tick
 * boxes: deleting 100 parking events one confirmation at a time would be worse
 * than doing it in a file manager.
 */
export function TripList({
  drives, events, filter, sort, onFilterChange, onSortChange, selectedId, onSelect,
  checkedIds, onCheckedChange, onDelete, deleting, time, stats, actions,
}: Props) {
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  /** Where a shift-click range starts: the last row ticked on its own. */
  const [anchorId, setAnchorId] = useState<string | null>(null);

  const { entries: adherenceByTrip, request: requestAdherence } = useTripAdherence();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowTrips = useRef(new WeakMap<Element, CardTrip>());
  const observer = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    observer.current = new IntersectionObserver((observed) => {
      for (const rowEntry of observed) {
        if (!rowEntry.isIntersecting) continue;
        const trip = rowTrips.current.get(rowEntry.target);
        observer.current?.unobserve(rowEntry.target);
        if (trip) requestAdherence(trip);
      }
    }, { root: scrollRef.current, rootMargin: '200px' });
    return () => observer.current?.disconnect();
  }, [requestAdherence]);

  const observeRow = useCallback((trip: CardTrip) => (node: HTMLLIElement | null) => {
    if (!node) return;
    rowTrips.current.set(node, trip);
    observer.current?.observe(node);
  }, []);

  const visible = useMemo(
    () => selectTrips(drives, events, filter, sort),
    [drives, events, filter, sort],
  );
  const checked = useMemo(
    () => visible.filter((trip) => checkedIds.has(trip.id)),
    [visible, checkedIds],
  );

  // Day headings only make sense while the list is in time order.
  const grouped = sort !== 'longest';
  const noun = filter === 'events' ? 'event' : 'drive';

  const check = (trip: CardTrip, shiftKey: boolean) => {
    if (shiftKey) {
      onCheckedChange(rangeSelected(checkedIds, visible.map((t) => t.id), anchorId, trip.id));
    } else {
      onCheckedChange(toggleSelected(checkedIds, trip.id));
      setAnchorId(trip.id);
    }
  };

  const stopChoosing = () => {
    setChoosing(false);
    setConfirming(null);
    onCheckedChange(new Set());
  };

  let lastDay: string | null = null;

  return (
    <nav className="sidebar" aria-label="Trips">
      <div className="panel-head">
        <h2>Trips</h2>
        <span className="spacer" />
        {actions}
      </div>
      <div className="sidebar-controls">
        <div className="segmented" role="group" aria-label="Filter trips">
          {([
            ['all', 'All', drives.length + events.length],
            ['drives', 'Drives', drives.length],
            ['events', 'Events', events.length],
          ] as const).map(([value, label, count]) => (
            <button
              key={value}
              className={filter === value ? 'selected' : ''}
              aria-pressed={filter === value}
              onClick={() => onFilterChange(value)}
            >
              {label} <span className="count">{count}</span>
            </button>
          ))}
        </div>
        <label className="sort">
          Sort
          <select value={sort} onChange={(event) => onSortChange(event.target.value as TripSort)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="longest">Longest first</option>
          </select>
        </label>
        <button
          className={choosing ? 'chip selected' : 'chip'}
          aria-pressed={choosing}
          onClick={() => (choosing ? stopChoosing() : setChoosing(true))}
        >
          {choosing ? 'Done' : 'Select'}
        </button>
      </div>

      {choosing && checked.length > 0 && (
        <div className="selection-bar">
          {confirming?.kind === 'selection' ? (
            <ConfirmInline
              question={`${describeTrips(checked, noun)}?`}
              busy={deleting}
              onConfirm={() => { setConfirming(null); onDelete(checked); }}
              onCancel={() => setConfirming(null)}
            />
          ) : (
            <>
              <span>{describeSelection(checked)}</span>
              <span className="spacer" />
              <button className="danger" onClick={() => setConfirming({ kind: 'selection' })}>
                Delete
              </button>
              <button onClick={() => onCheckedChange(new Set())}>Clear</button>
            </>
          )}
        </div>
      )}

      <div className="sidebar-scroll" ref={scrollRef}>
        {visible.length === 0 ? (
          <p className="muted pad">Nothing matches this filter.</p>
        ) : (
          <ul className="trip-list">
            {visible.map((trip) => {
              const day = formatLocal(trip.startLocalMs, time, DAY);
              const heading = grouped && day !== lastDay ? day : null;
              lastDay = day;
              const minutes = Math.round(tripDurationMs(trip) / 60_000);
              const asking = confirming?.kind === 'trip' && confirming.id === trip.id;
              const rowNoun = isParkingEvent(trip) ? 'event' : 'drive';
              const entry = stats.get(trip.id);
              const adherence = adherenceByTrip.get(trip.id);
              return (
                <li key={trip.id} ref={observeRow(trip)}>
                  {heading && <h3 className="day-heading">{heading}</h3>}
                  {asking ? (
                    <ConfirmInline
                      question={`${describeTrips([trip], rowNoun)}?`}
                      busy={deleting}
                      onConfirm={() => { setConfirming(null); onDelete([trip]); }}
                      onCancel={() => setConfirming(null)}
                    />
                  ) : (
                    <div className="trip-row">
                      {choosing && (
                        <input
                          type="checkbox"
                          className="trip-check"
                          checked={checkedIds.has(trip.id)}
                          aria-label={`Select ${formatLocal(trip.startLocalMs, time, CLOCK)} ${day}`}
                          onChange={() => {}}
                          onClick={(event) => check(trip, event.shiftKey)}
                        />
                      )}
                      <button
                        className={trip.id === selectedId ? 'trip selected' : 'trip'}
                        onClick={() => onSelect(trip)}
                        aria-current={trip.id === selectedId}
                      >
                        <span className="trip-when">
                          {formatLocal(trip.startLocalMs, time, CLOCK)}
                          {!grouped && <span className="trip-day">{day}</span>}
                          {entry?.status === 'ready' && <HarshEventBadges counts={entry.harshEvents} />}
                          <ScoreBadge entry={entry} />
                          <AdherenceBadge adherence={adherence} />
                        </span>
                        <span className="trip-meta">
                          {minutes} min · {trip.clips.length} clip{trip.clips.length === 1 ? '' : 's'}
                          {trip.hasEvent && <span className="badge badge--warn">event</span>}
                        </span>
                        <TripStatsLine entry={entry} adherence={adherence} />
                      </button>
                      <DeleteButton
                        className="icon-button trip-delete"
                        label={`this ${rowNoun} and all its clips`}
                        onClick={() => setConfirming({ kind: 'trip', id: trip.id })}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
