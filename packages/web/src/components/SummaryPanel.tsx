import { useState } from 'react';
import { kphToMph, type TripSummary } from '@wolfbox/telemetry';
import { SPEED_BINS, type Theme } from '../speedScale.ts';
import { formatAbsolute, type TimeContext } from '../time.ts';

const mi = (meters: number) => meters / 1609.344;

function duration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}



/**
 * Trip metrics, plus how the drive's time was spent across the speed bands.
 *
 * The histogram shares the route line's colours so the two read as one system:
 * a band that is mostly orange on the map is the orange bar here. Every bar is
 * directly labelled and a table view is available, which is what lets the
 * colour ramp stay legible without relying on colour alone.
 */
export function SummaryPanel(
  { summary, theme, time }: { summary: TripSummary; theme: Theme; time: TimeContext },
) {
  const clock = (ms: number) => formatAbsolute(ms, time, { hour: 'numeric', minute: '2-digit' });
  const [asTable, setAsTable] = useState(false);
  const buckets = SPEED_BINS.map((bin, i) => ({ bin, seconds: summary.histogramMph[i] ?? 0 }));
  const peak = Math.max(...buckets.map((b) => b.seconds), 1);
  const totalBucketed = buckets.reduce((sum, b) => sum + b.seconds, 0);

  return (
    <section className="summary">
      <dl className="stats">
        <div><dt>Distance</dt><dd>{mi(summary.distanceMeters).toFixed(1)} <small>mi</small></dd></div>
        <div><dt>Duration</dt><dd>{duration(summary.durationSec)}</dd></div>
        <div><dt>Moving</dt><dd>{duration(summary.movingSec)}</dd></div>
        <div><dt>Avg moving</dt><dd>{kphToMph(summary.averageMovingSpeedKph).toFixed(0)} <small>mph</small></dd></div>
        <div><dt>Top speed</dt><dd>{kphToMph(summary.maxSpeedKph).toFixed(0)} <small>mph</small></dd></div>
        <div><dt>Harsh events</dt><dd>{summary.harshEvents.length}</dd></div>
      </dl>

      <div className="chart-head">
        <h3>Time by speed</h3>
        <button className="link" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {asTable ? (
        <table className="data-table">
          <caption>Time spent in each speed band</caption>
          <thead>
            <tr><th scope="col">Speed (mph)</th><th scope="col">Time</th><th scope="col">Share</th></tr>
          </thead>
          <tbody>
            {buckets.map(({ bin, seconds }) => (
              <tr key={bin.label}>
                <th scope="row">{bin.label}</th>
                <td>{duration(seconds)}</td>
                <td>{totalBucketed > 0 ? `${Math.round((seconds / totalBucketed) * 100)}%` : '0%'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="histogram">
          {buckets.map(({ bin, seconds }) => (
            <li key={bin.label}>
              <span className="histogram-label">{bin.label}</span>
              <span className="histogram-track">
                <span
                  className="histogram-bar"
                  style={{
                    width: `${(seconds / peak) * 100}%`,
                    backgroundColor: theme === 'dark' ? bin.dark : bin.light,
                  }}
                />
              </span>
              <span className="histogram-value">{duration(seconds)}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="summary-window">
        {clock(summary.startMs)} to {clock(summary.endMs)}
      </p>
    </section>
  );
}
