import { useMemo, useState, type ReactNode } from 'react';
import { formatDuration, kphToMph } from '@wolfbox/telemetry';
import { isParkingEvent, type CardTrip } from '../card.ts';
import { describeSelection, describeTrips } from '../deletion.ts';
import { formatLocal, type TimeContext } from '../time.ts';
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

/** Circumference of the list's score ring, at r=15. */
const RING = 2 * Math.PI * 15;

const BAND_LABEL = { low: 'Low risk', moderate: 'Some risk', high: 'High risk' } as const;

/**
 * The drive's risk score as a small ring, coloured by band. A dashed ring is a
 * score made before speed limits were known, so a provisional 95 cannot be
 * mistaken for a final one.
 */
function RiskRing({ entry }: { entry?: TripStatsEntry }) {
  if (!entry || entry.status === 'pending') return <span className="risk-ring risk-ring--pending" aria-hidden="true" />;
  if (entry.status !== 'ready' || !entry.risk) return <span className="risk-ring risk-ring--none" aria-hidden="true" />;
  const { score, band, includesSpeeding } = entry.risk;
  const provisional = !includesSpeeding && entry.limits === 'pending';
  return (
    <svg
      className={`risk-ring risk-ring--${band}${provisional ? ' risk-ring--provisional' : ''}`}
      viewBox="0 0 36 36" width="36" height="36" role="img"
      aria-label={`Score ${score} of 100, ${BAND_LABEL[band]}${provisional ? ', speed limits still loading' : ''}`}
    >
      <circle className="risk-ring-track" cx="18" cy="18" r="15" />
      <circle
        className="risk-ring-value" cx="18" cy="18" r="15"
        strokeDasharray={RING} strokeDashoffset={RING * (1 - score / 100)}
        transform="rotate(-90 18 18)"
      />
      <text x="18" y="22.5" textAnchor="middle">{score}</text>
    </svg>
  );
}

/** The two factors that cost the most, as chips, so the list says why as well as how much. */
function RiskReasons({ entry }: { entry?: TripStatsEntry }) {
  if (!entry || entry.status !== 'ready' || !entry.risk) return null;
  const { factors } = entry.risk;
  if (factors.length === 0) {
    return entry.risk.includesSpeeding
      ? <span className="reasons"><span className="reason reason--clean">Clean drive</span></span>
      : null;
  }
  const shown = factors.slice(0, 2);
  return (
    <span className="reasons">
      {shown.map((factor) => (
        <span key={factor.key} className={`reason reason--${factor.severity}`} title={factor.detail}>
          {factor.label}
        </span>
      ))}
      {factors.length > shown.length && (
        <span className="reason reason--more" title={factors.slice(2).map((f) => f.label).join(', ')}>
          +{factors.length - shown.length}
        </span>
      )}
    </span>
  );
}

/** Distance, speeds and route, once the background queue has reached this trip. */
function TripFigures({ entry, minutes }: { entry?: TripStatsEntry; minutes: number }) {
  if (!entry || entry.status === 'pending') {
    return <span className="trip-figures trip-figures--pending">{minutes} min &middot; reading GPS&hellip;</span>;
  }
  if (entry.status === 'unavailable') return <span className="trip-figures">{minutes} min &middot; no GPS</span>;
  const route = entry.startLabel || entry.endLabel
    ? `${entry.startLabel ?? 'Unknown'} → ${entry.endLabel ?? 'Unknown'}`
    : null;
  const speeding = entry.risk?.speeding;
  return (
    <>
      {route && <span className="trip-route">{route}</span>}
      <span className="trip-figures">
        <span>{metersToMiles(entry.distanceMeters).toFixed(1)} mi</span>
        <span>{minutes} min</span>
        <span>{Math.round(kphToMph(entry.maxSpeedKph))} top</span>
        <span>{Math.round(kphToMph(entry.averageMovingSpeedKph))} avg</span>
        {speeding && speeding.stretchSec > 0 && (
          <span className="trip-figures-over">{formatDuration(speeding.stretchSec)} over</span>
        )}
      </span>
    </>
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

  const visible = useMemo(
    () => selectTrips(drives, events, filter, sort, (trip) => {
      const entry = stats.get(trip.id);
      return entry?.status === 'ready' ? entry.risk?.score : undefined;
    }),
    [drives, events, filter, sort, stats],
  );
  const checked = useMemo(
    () => visible.filter((trip) => checkedIds.has(trip.id)),
    [visible, checkedIds],
  );

  // Day headings only make sense while the list is in time order.
  const grouped = sort === 'newest' || sort === 'oldest';
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
            <option value="riskiest">Riskiest first</option>
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

      <div className="sidebar-scroll">
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
              return (
                <li key={trip.id}>
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
                        <RiskRing entry={entry} />
                        <span className="trip-body">
                          <span className="trip-when">
                            {formatLocal(trip.startLocalMs, time, CLOCK)}
                            {!grouped && <span className="trip-day">{day}</span>}
                            {trip.hasEvent && <span className="badge badge--warn">event</span>}
                            {trip.clips.length === 1 && <span className="trip-day">1 clip</span>}
                          </span>
                          <TripFigures entry={entry} minutes={minutes} />
                          <RiskReasons entry={entry} />
                        </span>
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
