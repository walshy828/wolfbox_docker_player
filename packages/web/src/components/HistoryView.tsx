import { useEffect, useMemo, useState } from 'react';
import {
  addOdometer, deleteOdometer, listEvents, listOdometer,
  type ArchivedEvent, type ArchivedTrip, type Driver, type OdometerEntry,
} from '../archive.ts';
import {
  RANGE_LABEL, bucketFor, driverKey, driverSlot, driverSummaries, inRange, periods, reconcile, tripInstant,
  UNASSIGNED, type HistoryRange,
} from '../history.ts';
import { formatSpan } from '../overview.ts';
import type { Theme } from '../speedScale.ts';
import type { TimeContext } from '../time.ts';
import { MilesChart, ScoreChart, seriesColor, type Series } from './HistoryCharts.tsx';
import { HistoryMap } from './HistoryMap.tsx';


/**
 * The archive over time: how much the car is driven, by whom, how well, and
 * where -- and whether the miles add up.
 */
export function HistoryView({
  trips, drivers, time, theme, onOpen,
}: {
  trips: ArchivedTrip[];
  drivers: Driver[];
  time: TimeContext;
  theme: Theme;
  onOpen: (tripId: string) => void;
}) {
  const [range, setRange] = useState<HistoryRange>('90d');
  const [driver, setDriver] = useState('');
  const [events, setEvents] = useState<ArchivedEvent[]>([]);
  const [readings, setReadings] = useState<OdometerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Fixed for the life of the screen, so periods do not shift under the pointer.
  const [nowMs] = useState(() => Date.now());

  useEffect(() => {
    void listEvents().then(setEvents, (cause) => setError(String(cause)));
    void listOdometer().then(setReadings, (cause) => setError(String(cause)));
  }, [trips]);

  // Every driver who exists, so colours never move when one is filtered out.
  const allKeys = useMemo(
    () => [...drivers.map((d) => String(d.id)), UNASSIGNED],
    [drivers],
  );
  const chosen = useMemo(
    () => inRange(trips, range, nowMs, time).filter((trip) => !driver || driverKey(trip) === driver),
    [trips, range, nowMs, time, driver],
  );
  const series: Series[] = useMemo(() => {
    const present = new Set(chosen.map(driverKey));
    const named = drivers.filter((d) => present.has(String(d.id)))
      .map((d) => ({ key: String(d.id), name: d.name, slot: driverSlot(String(d.id), allKeys) }));
    return present.has(UNASSIGNED)
      ? [...named, { key: UNASSIGNED, name: 'Not assigned', slot: 'none' as const }]
      : named;
  }, [chosen, drivers, allKeys]);

  const bucket = bucketFor(range);
  const grouped = useMemo(
    () => periods(trips.filter((trip) => !driver || driverKey(trip) === driver), range, nowMs, time),
    [trips, driver, range, nowMs, time],
  );
  const summaries = useMemo(() => driverSummaries(chosen, nowMs, time), [chosen, nowMs, time]);
  const chosenIds = useMemo(() => new Set(chosen.map((t) => t.id)), [chosen]);
  const chosenEvents = useMemo(() => events.filter((e) => chosenIds.has(e.tripId)), [events, chosenIds]);

  const miles = chosen.reduce((sum, t) => sum + t.distanceMeters / 1609.344, 0);
  const movingSec = chosen.reduce((sum, t) => sum + (t.movingSec ?? 0), 0);
  const overSec = chosen.reduce((sum, t) => sum + t.overLimitSec, 0);
  const scored = chosen.filter((t) => t.risk);
  const avg = scored.length ? Math.round(scored.reduce((s, t) => s + t.risk!.score, 0) / scored.length) : null;
  const high = chosen.filter((t) => t.risk?.band === 'high').length;
  const days = new Set(chosen.map((t) => new Date(tripInstant(t, time)).toDateString())).size;

  if (trips.length === 0) {
    return (
      <div className="overview">
        <p className="overview-empty glass">
          History is built from the archive. Open a card and save drives to it to start one.
        </p>
      </div>
    );
  }

  return (
    <div className="overview history">
      <div className="overview-toolbar">
        <div className="segmented" role="group" aria-label="Time range">
          {(Object.keys(RANGE_LABEL) as HistoryRange[]).map((value) => (
            <button key={value} className={range === value ? 'selected' : ''} aria-pressed={range === value} onClick={() => setRange(value)}>
              {RANGE_LABEL[value]}
            </button>
          ))}
        </div>
        <label className="sort">
          Driver
          <select value={driver} onChange={(event) => setDriver(event.target.value)}>
            <option value="">Everyone</option>
            {drivers.map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
            <option value={UNASSIGNED}>Not assigned</option>
          </select>
        </label>
      </div>

      {error && <p className="notice notice--error">{error}</p>}

      <section className="overview-hero glass history-hero" aria-label="Totals">
        <dl className="kpis">
          <Kpi label="Distance" value={miles.toFixed(0)} unit="mi" note={`${days} day${days === 1 ? '' : 's'} driven`} />
          <Kpi label="Driving time" value={formatSpan(movingSec)} />
          <Kpi label="Drives" value={String(chosen.length)} />
          <Kpi label="Average score" value={avg === null ? '–' : String(avg)} tone={avg !== null && avg < 65 ? 'danger' : avg !== null && avg < 85 ? 'warn' : undefined} />
          <Kpi label="Over the limit" value={formatSpan(overSec)} tone={overSec > 0 ? 'warn' : undefined}
            note={movingSec > 0 ? `${((overSec / movingSec) * 100).toFixed(1)}% of driving` : undefined} />
          <Kpi label="High-risk drives" value={String(high)} tone={high > 0 ? 'danger' : undefined} />
        </dl>
      </section>

      <div className="chart-grid-2">
        <MilesChart periods={grouped} series={series} bucket={bucket} />
        <ScoreChart periods={grouped} series={series} bucket={bucket} />
      </div>

      {summaries.length > 0 && (
        <section className="chart-card glass">
          <header className="chart-card-head">
            <div>
              <h3>By driver</h3>
              <span className="muted">Rates are per hour or per 100 miles, so drivers who drive more are not penalised for it</span>
            </div>
          </header>
          <div className="chart-table-wrap">
            <table className="data-table driver-table">
              <thead>
                <tr>
                  <th scope="col">Driver</th><th scope="col">Drives</th><th scope="col">Miles</th><th scope="col">Hours</th>
                  <th scope="col">Avg score</th><th scope="col">30-day trend</th><th scope="col">High risk</th>
                  <th scope="col">Over limit</th><th scope="col">Hard events</th><th scope="col">Top speed</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr key={s.key}>
                    <th scope="row">
                      <span className="chart-swatch" style={{ background: seriesColor(driverSlot(s.key, allKeys)) }} />
                      {s.name}
                    </th>
                    <td>{s.drives}</td>
                    <td>{s.miles.toFixed(0)}</td>
                    <td>{(s.movingSec / 3600).toFixed(1)}</td>
                    <td>{s.averageScore ?? '—'}</td>
                    <td className={s.trend === null ? 'muted' : s.trend < 0 ? 'trend-down' : s.trend > 0 ? 'trend-up' : ''}>
                      {s.trend === null ? '—' : `${s.trend > 0 ? '▲ +' : s.trend < 0 ? '▼ ' : ''}${s.trend}`}
                    </td>
                    <td>{s.highRisk}</td>
                    <td>{s.overLimitMinPerHour.toFixed(1)} <small>min/hr</small></td>
                    <td>{s.hardPer100mi.toFixed(1)} <small>/100 mi</small></td>
                    <td>{Math.round(s.topMph)} <small>mph</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <HistoryMap trips={chosen} events={chosenEvents} series={series} theme={theme} onOpen={onOpen} />

      <MileagePanel
        readings={readings} trips={trips} time={time}
        onAdd={async (reading) => {
          const added = await addOdometer(reading);
          setReadings((all) => [...all, added].sort((a, b) => a.readMs - b.readMs));
        }}
        onDelete={async (id) => {
          await deleteOdometer(id);
          setReadings((all) => all.filter((r) => r.id !== id));
        }}
      />
    </div>
  );
}

function Kpi({ label, value, unit, note, tone }: { label: string; value: string; unit?: string; note?: string; tone?: 'warn' | 'danger' }) {
  return (
    <div className={tone ? `kpi kpi--${tone}` : 'kpi'}>
      <dt>{label}</dt>
      <dd>{value}{unit && <small> {unit}</small>}</dd>
      {note && <span className="kpi-note">{note}</span>}
    </div>
  );
}

/** Today's date as yyyy-mm-dd for the date input, in the viewer's own zone. */
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/**
 * Odometer readings against what the archive recorded between them.
 *
 * The point is reconciliation, not precision: a family wants to know whether
 * the car's miles are accounted for, and a large gap means drives that never
 * made it into the archive.
 */
function MileagePanel({
  readings, trips, time, onAdd, onDelete,
}: {
  readings: OdometerEntry[];
  trips: ArchivedTrip[];
  time: TimeContext;
  onAdd: (reading: { readMs: number; miles: number; note?: string }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [date, setDate] = useState(today);
  const [miles, setMiles] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checks = useMemo(() => reconcile(readings, trips, time).reverse(), [readings, trips, time]);
  // Readings are dated by the person who took them, on their own calendar, so
  // they are shown that way rather than through the camera-clock setting.
  const when = (ms: number) => new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' }).format(ms);

  const submit = async () => {
    const value = Number(miles.replace(/,/g, ''));
    if (!date || !Number.isFinite(value) || value < 0) { setError('Enter the date and the odometer reading in miles.'); return; }
    // Readings are taken at the end of the day they are dated, so that day's drives count before it.
    const [y, m, d] = date.split('-').map(Number);
    const readMs = new Date(y!, m! - 1, d!, 23, 59, 59).getTime();
    setBusy(true);
    setError(null);
    try {
      await onAdd({ readMs, miles: value, note: note.trim() || undefined });
      setMiles('');
      setNote('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="chart-card glass mileage">
      <header className="chart-card-head">
        <div>
          <h3>Mileage check</h3>
          <span className="muted">Odometer readings against the miles recorded between them</span>
        </div>
      </header>

      <form className="mileage-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="field"><span>Date</span><input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field"><span>Odometer (mi)</span><input type="number" inputMode="decimal" min="0" step="0.1" value={miles} onChange={(e) => setMiles(e.target.value)} placeholder="41250" /></label>
        <label className="field field--grow"><span>Note</span><input type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></label>
        <button type="submit" className="primary" disabled={busy || !miles}>Add reading</button>
      </form>
      {error && <p className="notice notice--error">{error}</p>}

      {readings.length < 2 ? (
        <p className="muted mileage-hint">
          {readings.length === 0
            ? 'Add an odometer reading now and another in a week or two. The check compares what the car says it drove with what the archive holds.'
            : 'One reading so far. Add another later and the miles between them will be checked.'}
        </p>
      ) : (
        <div className="chart-table-wrap">
          <table className="data-table mileage-table">
            <thead>
              <tr><th scope="col">Period</th><th scope="col">Odometer</th><th scope="col">Recorded</th><th scope="col">Accounted for</th><th scope="col">Unrecorded</th></tr>
            </thead>
            <tbody>
              {checks.map((check) => {
                const pct = check.share === null ? null : Math.round(check.share * 100);
                const missing = Math.max(0, check.odometerMiles - check.recordedMiles);
                return (
                  <tr key={check.to.id}>
                    <th scope="row">{when(check.from.readMs)} – {when(check.to.readMs)}</th>
                    <td>{check.odometerMiles.toFixed(0)} mi</td>
                    <td>{check.recordedMiles.toFixed(0)} mi <small>· {check.drives} drive{check.drives === 1 ? '' : 's'}</small></td>
                    <td>
                      {pct === null ? '—' : (
                        <span className="share">
                          <span className="share-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, pct)}%` }} /></span>
                          {pct}%
                        </span>
                      )}
                    </td>
                    <td className={missing > 10 ? 'trend-down' : ''}>{missing.toFixed(0)} mi</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {readings.length > 0 && (
        <ul className="readings">
          {[...readings].reverse().map((r) => (
            <li key={r.id}>
              <span>{when(r.readMs)}</span>
              <strong>{r.miles.toLocaleString(undefined, { maximumFractionDigits: 1 })} mi</strong>
              {r.note && <span className="muted">{r.note}</span>}
              <span className="spacer" />
              <button className="link danger-link" onClick={() => void onDelete(r.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted mileage-foot">
        Some shortfall is normal: GPS takes a minute to lock on at the start of each drive, and drives
        the card looped over before they were saved are not in the archive.
      </p>
    </section>
  );
}
