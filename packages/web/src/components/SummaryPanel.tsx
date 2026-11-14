import { useState } from 'react';
import {
  formatDuration, kphToMph, type DriveRisk, type RiskBand, type TripSummary,
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

const BAND_LABEL: Record<RiskBand, string> = {
  low: 'Low risk', moderate: 'Some risk', high: 'High risk',
};

/** Circumference of the gauge ring, at r=40. */
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 40;

/**
 * The drive score as a ring gauge, so the single headline figure this panel
 * leads with reads at a glance rather than as one more number in a table.
 */
function ScoreGauge({ value, band }: { value: number; band: RiskBand }) {
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
 * Leads with the risk score and the factors it was built from, each with the
 * points it cost, so the number is never the end of the explanation. Below
 * that, the speeding and event figures a parent will want to quote.
 *
 * The histogram shares the route line's colours so the two read as one system:
 * a band that is mostly orange on the map is the orange bar here. Every bar is
 * directly labelled and a table view is available, which is what lets the
 * colour ramp stay legible without relying on colour alone.
 */
export function SummaryPanel(
  { summary, theme, time, limitStatus, risk }: {
    summary: TripSummary;
    theme: Theme;
    time: TimeContext;
    limitStatus: LimitStatus;
    risk: DriveRisk | null;
  },
) {
  const clock = (ms: number) => formatAbsolute(ms, time, { hour: 'numeric', minute: '2-digit' });
  const [asTable, setAsTable] = useState(false);
  const buckets = SPEED_BANDS.map((band, i) => ({ band, seconds: summary.histogramMph[i] ?? 0 }));
  const peak = Math.max(...buckets.map((b) => b.seconds), 1);
  const totalBucketed = buckets.reduce((sum, b) => sum + b.seconds, 0);

  const count = (kind: string) => summary.harshEvents.filter((e) => e.kind === kind).length;
  const severeOf = (kind: string) =>
    summary.harshEvents.filter((e) => e.kind === kind && e.severity === 'severe').length;
  const eventTile = (kind: string, label: string) => {
    const n = count(kind);
    const severe = severeOf(kind);
    return (
      <IssueTile
        label={label} value={String(n)}
        detail={severe > 0 ? `${severe} severe` : undefined}
        tone={severe > 0 ? 'danger' : n > 0 ? 'warn' : 'ok'}
      />
    );
  };

  const speeding = risk?.speeding;
  const speedingTiles = (() => {
    if (limitStatus === 'loading') {
      return <IssueTile label="Over the limit" value="…" detail="Checking limits" tone="muted" />;
    }
    if (!speeding) {
      return <IssueTile label="Over the limit" value="—" detail="Limits not available" tone="muted" />;
    }
    const peakMph = Math.round(kphToMph(speeding.peakExcessKph));
    return (
      <>
        <IssueTile
          label="Over the limit" value={formatDuration(speeding.stretchSec)}
          detail={`${speeding.stretchCount} stretch${speeding.stretchCount === 1 ? '' : 'es'}${speeding.assumed ? ' · some limits assumed' : ''}`}
          tone={speeding.bySeverity.severe > 0 ? 'danger' : speeding.stretchCount > 0 ? 'warn' : 'ok'}
        />
        <IssueTile
          label="Longest stretch" value={speeding.stretchCount ? formatDuration(speeding.longestSec) : '—'}
          tone={speeding.longestSec >= 60 ? 'warn' : speeding.stretchCount ? 'muted' : 'ok'}
        />
        <IssueTile
          label="Most over" value={speeding.stretchCount ? `+${peakMph}` : '—'}
          detail={speeding.peakRoad}
          tone={peakMph >= 20 ? 'danger' : peakMph >= 10 ? 'warn' : speeding.stretchCount ? 'muted' : 'ok'}
        />
      </>
    );
  })();

  return (
    <section className="summary">
      <CollapsibleSection title="Drive summary">
        <div className="score-hero">
          <ScoreGauge value={risk?.score ?? 0} band={risk?.band ?? 'moderate'} />
          <div className="score-hero-text">
            {risk ? (
              <>
                <strong className={`score-hero-band score-hero-band--${risk.band}`}>
                  {BAND_LABEL[risk.band]}
                </strong>
                <span className="muted">
                  {risk.includesSpeeding
                    ? 'Speeding, braking, acceleration, cornering and top speed.'
                    : limitStatus === 'loading'
                      ? 'Speed limits still loading; speeding not yet counted.'
                      : 'Speed limits unavailable; speeding not counted.'}
                  {risk.cappedBy && ` Capped for ${risk.cappedBy}.`}
                </span>
              </>
            ) : (
              <span className="muted">Too short a drive to score.</span>
            )}
          </div>
        </div>

        {risk && risk.factors.length > 0 && (
          <ul className="factors">
            {risk.factors.map((factor) => (
              <li key={factor.key} className={`factor factor--${factor.severity}`}>
                <span className="factor-label">{factor.label}</span>
                {factor.detail && <span className="factor-detail">{factor.detail}</span>}
                <span className="factor-points">&minus;{Math.round(factor.points)}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="issue-grid">{speedingTiles}</div>
        <div className="issue-grid issue-grid--harsh">
          {eventTile('braking', 'Hard stops')}
          {eventTile('acceleration', 'Hard launches')}
          {eventTile('cornering', 'Sharp turns')}
        </div>

        <dl className="stats">
          <div><dt>Distance</dt><dd>{metersToMiles(summary.distanceMeters).toFixed(1)} <small>mi</small></dd></div>
          <div><dt>Duration</dt><dd>{duration(summary.durationSec)}</dd></div>
          <div><dt>Moving</dt><dd>{duration(summary.movingSec)}</dd></div>
          <div><dt>Avg moving</dt><dd>{kphToMph(summary.averageMovingSpeedKph).toFixed(0)} <small>mph</small></dd></div>
          <div><dt>Top speed</dt><dd>{kphToMph(summary.maxSpeedKph).toFixed(0)} <small>mph</small></dd></div>
          <div><dt>Time 80+</dt><dd>{formatDuration(summary.histogramMph.at(-1) ?? 0)}</dd></div>
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
