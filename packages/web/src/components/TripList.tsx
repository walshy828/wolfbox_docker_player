import type { CardTrip } from '../card.ts';

const when = (ms: number) =>
  new Date(ms).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

interface Props {
  drives: CardTrip[];
  events: CardTrip[];
  selectedId: string | null;
  onSelect: (trip: CardTrip) => void;
}

/**
 * Trips down the side, drives separated from parking events.
 *
 * Parking-mode impacts are recorded as isolated one-minute clips -- 130 of them
 * on the reference card against 54 real drives -- so mixing them into one list
 * would bury the drives entirely.
 */
export function TripList({ drives, events, selectedId, onSelect }: Props) {
  const section = (title: string, trips: CardTrip[], empty: string) => (
    <>
      <h2>{title} <span className="count">{trips.length}</span></h2>
      {trips.length === 0 ? <p className="muted">{empty}</p> : (
        <ul className="trip-list">
          {trips.map((trip) => {
            const minutes = Math.round((trip.endLocalMs - trip.startLocalMs) / 60_000);
            return (
              <li key={trip.id}>
                <button
                  className={trip.id === selectedId ? 'trip selected' : 'trip'}
                  onClick={() => onSelect(trip)}
                  aria-current={trip.id === selectedId}
                >
                  <span className="trip-when">{when(trip.startLocalMs)}</span>
                  <span className="trip-meta">
                    {minutes} min · {trip.clips.length} clip{trip.clips.length === 1 ? '' : 's'}
                    {trip.hasEvent && <span className="badge">event</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <nav className="sidebar" aria-label="Trips">
      {section('Drives', drives, 'No drives found on this card.')}
      {section('Parking events', events, 'No parking events recorded.')}
    </nav>
  );
}
