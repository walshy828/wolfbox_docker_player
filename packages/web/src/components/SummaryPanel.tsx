import { useState } from 'react';
import {
  kphToMph, computeDriveScore, type DriveScoreBand, type TripSummary, type TripAdherence,
} from '@wolfbox/telemetry';
import { SPEED_BANDS, colorForBand, type Theme } from '../speedScale.ts';
import { CollapsibleSection } from './CollapsibleSection.tsx';
import { formatAbsolute, type TimeContext } from '../time.ts';
import { metersToMiles } from '../units.ts';
import type { LimitStatus } from '../limits.ts';

function duration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const BAND_LABEL: Record<DriveScoreBand, string> = {
  good: 'Good drive', fair: 'Fair drive', poor: 'Rough drive',
};

/** Circumference of the gauge ring, at r=40. */
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 40;

/**
 * The drive score as a ring gauge, so the single headline figure this panel
 * leads with reads at a glance rather than as one more number in a table.
 */
function ScoreGauge({ value, band }: { value: number; band: DriveScoreBand }) {
  const offset = GAUGE_CIRCUMFERENCE * (1 - value / 100);
  return (
    <svg className={`score-gauge score-gauge--${band}`} viewBox="0 0 100 100" width="88" height="88">
      <circle className="score-gauge-track" cx="50" cy="50" r="40" />
      <circle
        className="score-gauge-value" cx="50" cy="50" r="40"
        strokeDasharray={GAUGE_CIRCUMFERENCE} strokeDashoffset={offset}
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="47" className="score-gauge-number" textAnchor="middle">{value}</text>
      <text x="50" y="66" className="score-gauge-suffix" textAnchor="middle">/100</text>
    </svg>
  );
}

/** A single colour-coded callout in the issues grid. */
function IssueTile(
  { label, value, detail, tone }:
  { label: string; value: string; detail?: string; tone: 'ok' | 'warn' | 'danger' | 'muted' },
) {
  return (
    <div className={`issue-tile issue-tile--${tone}`}>
      <span className="issue-tile-value">{value}</span>
      <span className="issue-tile-label">{label}</span>
      {detail && <span className="issue-tile-detail">{detail}</span>}
    </div>
  );
}

/**
 * Trip metrics, plus how the drive's time was spent across the speed bands.
 *
 * Leads with the drive score as a gauge and a grid of the figures that feed
 * or explain it -- speed-limit adherence and the harsh-event counts, broken
 * out by severity and by braking versus acceleration -- so a parent can see
 * at a glance whether a drive is worth a closer look before reading a single
 * number in the tables below.
 *
 * The histogram shares the route line's colours so the two read as one system:
 * a band that is mostly orange on the map is the orange bar here. Every bar is
 * directly labelled and a table view is available, which is what lets the
 * colour ramp stay legible without relying on colour alone.
 */
export function SummaryPanel(
  { summary, theme, time, limitStatus, adherence }: {
    summary: TripSummary;
    theme: Theme;
    time: TimeContext;
    limitStatus: LimitStatus;
    adherence?: TripAdherence;
  },
) {
  const clock = (ms: number) => formatAbsolute(ms, time, { hour: 'numeric', minute: '2-digit' });
  const [asTable, setAsTable] = useState(false);
  const buckets = SPEED_BANDS.map((band, i) => ({ band, seconds: summary.histogramMph[i] ?? 0 }));
  const peak = Math.max(...buckets.map((b) => b.seconds), 1);
  const totalBucketed = buckets.reduce((sum, b) => sum + b.seconds, 0);

  const adherenceScore = adherence ? adherence.score ?? adherence.scoreWithInferred : undefined;
  const score = computeDriveScore({
    harshEvents: summary.harshEvents,
    distanceMeters: summary.distanceMeters,
    adherenceScore,
  });

  const brakingModerate = summary.harshEvents.filter((e) => e.kind === 'braking' && e.severity === 'moderate').length;
  const brakingSevere = summary.harshEvents.filter((e) => e.kind === 'braking' && e.severity === 'severe').length;
  const accelModerate = summary.harshEvents.filter((e) => e.kind === 'acceleration' && e.severity === 'moderate').length;
  const accelSevere = summary.harshEvents.filter((e) => e.kind === 'acceleration' && e.severity === 'severe').length;

  const stretchesModerate = adherence?.stretches.filter((s) => s.severity === 'moderate').length ?? 0;
  const stretchesSevere = adherence?.stretches.filter((s) => s.severity === 'severe').length ?? 0;

  const adherenceTile = (() => {
    if (limitStatus === 'loading') {
      return <IssueTile label="Speed limit adherence" value="…" detail="Checking limits" tone="muted" />;
    }
    if (limitStatus === 'unavailable' || !adherence || adherenceScore == null) {
      return <IssueTile label="Speed limit adherence" value="—" detail="Not available" tone="muted" />;
    }
    const pct = Math.round(adherenceScore * 100);
    const tone = pct >= 90 ? 'ok' : pct >= 75 ? 'warn' : 'danger';
    return (
      <IssueTile
        label="Speed limit adherence" value={`${pct}%`}
        detail={`${stretchesModerate + stretchesSevere} stretch${stretchesModerate + stretchesSevere === 1 ? '' : 'es'} over`}
        tone={tone}
      />
    );
  })();

  return (
    <section className="summary">
      <CollapsibleSection title="Drive summary">
        <div className="score-hero">
          <ScoreGauge value={score?.value ?? 0} band={score?.band ?? 'fair'} />
          <div className="score-hero-text">
            {score ? (
              <>
                <strong className={`score-hero-band score-hero-band--${score.band}`}>
                  {BAND_LABEL[score.band]}
                </strong>
                <span className="muted">
                  {score.includesAdherence
                    ? 'Based on braking, acceleration and speed-limit adherence.'
                    : 'Based on braking and acceleration; speed limits not yet counted.'}
                </span>
              </>
            ) : (
              <span className="muted">Too short a drive to score.</span>
            )}
          </div>
        </div>

        <div className="issue-grid">
          {adherenceTile}
          <IssueTile
            label="Moderate events" value={String(stretchesModerate + brakingModerate + accelModerate)}
            detail="Speeding + harsh events"
            tone={stretchesModerate + brakingModerate + accelModerate > 0 ? 'warn' : 'ok'}
          />
          <IssueTile
            label="Severe events" value={String(stretchesSevere + brakingSevere + accelSevere)}
            detail="Speeding + harsh events"
            tone={stretchesSevere + brakingSevere + accelSevere > 0 ? 'danger' : 'ok'}
          />
        </div>

        <div className="issue-grid issue-grid--harsh">
          <IssueTile label="Moderate braking" value={String(brakingModerate)} tone={brakingModerate > 0 ? 'warn' : 'ok'} />
          <IssueTile label="Severe braking" value={String(brakingSevere)} tone={brakingSevere > 0 ? 'danger' : 'ok'} />
          <IssueTile label="Moderate acceleration" value={String(accelModerate)} tone={accelModerate > 0 ? 'warn' : 'ok'} />
          <IssueTile label="Severe acceleration" value={String(accelSevere)} tone={accelSevere > 0 ? 'danger' : 'ok'} />
        </div>

        <dl className="stats">
          <div><dt>Distance</dt><dd>{metersToMiles(summary.distanceMeters).toFixed(1)} <small>mi</small></dd></div>
          <div><dt>Duration</dt><dd>{duration(summary.durationSec)}</dd></div>
          <div><dt>Moving</dt><dd>{duration(summary.movingSec)}</dd></div>
          <div><dt>Avg moving</dt><dd>{kphToMph(summary.averageMovingSpeedKph).toFixed(0)} <small>mph</small></dd></div>
          <div><dt>Top speed</dt><dd>{kphToMph(summary.maxSpeedKph).toFixed(0)} <small>mph</small></dd></div>
          <div><dt>Harsh events</dt><dd>{summary.harshEvents.length}</dd></div>
        </dl>

        <div className="chart-head">
          <h3>Time by speed <span className="muted">mph</span></h3>
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
              {buckets.map(({ band, seconds }) => (
                <tr key={band.label}>
                  <th scope="row">{band.label}</th>
                  <td>{duration(seconds)}</td>
                  <td>{totalBucketed > 0 ? `${Math.round((seconds / totalBucketed) * 100)}%` : '0%'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="histogram">
            {buckets.map(({ band, seconds }) => (
              <li key={band.label}>
                <span className="histogram-label">{band.label}</span>
                <span className="histogram-track">
                  <span
                    className="histogram-bar"
                    style={{
                      width: `${(seconds / peak) * 100}%`,
                      backgroundColor: colorForBand(band, theme),
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
      </CollapsibleSection>
    </section>
  );
}
