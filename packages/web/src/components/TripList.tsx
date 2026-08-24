import { useMemo } from 'react';
import type { CardTrip } from '../card.ts';
import { formatLocal, type TimeContext } from '../time.ts';
import { selectTrips, tripDurationMs, type TripFilter, type TripSort } from '../tripView.ts';

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
  time: TimeContext;
}

const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };


/**
 * Trips down the side, filterable and sortable, scrolling independently.
 *
 * Drives and parking events are separated because the camera records an impact
 * in parking mode as an isolated one-minute clip -- 130 of them against 54 real
 * drives on the reference card -- so one merged list buries the drives.
 */
export function TripList({
  drives, events, filter, sort, onFilterChange, onSortChange, selectedId, onSelect, time,
}: Props) {
  const visible = useMemo(
    () => selectTrips(drives, events, filter, sort),
    [drives, events, filter, sort],
  );

  // Day headings only make sense while the list is in time order.
  const grouped = sort !== 'longest';

  let lastDay: string | null = null;

  return (
    <nav className="sidebar" aria-label="Trips">
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
      </div>

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
              return (
                <li key={trip.id}>
                  {heading && <h3 className="day-heading">{heading}</h3>}
                  <button
                    className={trip.id === selectedId ? 'trip selected' : 'trip'}
                    onClick={() => onSelect(trip)}
                    aria-current={trip.id === selectedId}
                  >
                    <span className="trip-when">
                      {formatLocal(trip.startLocalMs, time, CLOCK)}
                      {!grouped && <span className="trip-day">{day}</span>}
                    </span>
                    <span className="trip-meta">
                      {minutes} min · {trip.clips.length} clip{trip.clips.length === 1 ? '' : 's'}
                      {trip.hasEvent && <span className="badge badge--warn">event</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
