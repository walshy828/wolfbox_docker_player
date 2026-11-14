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

/** What a factor is about, for "lost most for ___". */
const FACTOR_NOUN: Record<string, string> = {
  speeding: 'speeding', 'top-speed': 'top speed',
  braking: 'hard stops', acceleration: 'hard launches', cornering: 'sharp turns',
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
    <svg className={`score-gauge score-gauge--${band}`} viewBox="0 0 100 100" width="68" height="68">
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

/** Which list of moments a tile opens. */
export type MomentKind = 'all' | 'speeding' | 'braking' | 'acceleration' | 'cornering';

/**
 * One line of the scorecard: what happened, how much, and what it cost.
 * Tapping one opens the matching moments, so every number leads to footage.
 */
function ScoreTile({
  label, value, detail, tone, points, onClick, active,
}: {
  label: string; value: string; detail?: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
  /** Points this cost the score; omitted when it cost none. */
  points?: number;
  onClick?: () => void;
  /** This tile's moments are the ones being shown. */
  active?: boolean;
}) {
  const body = (
    <>
      <span className="issue-tile-top">
        <span className="issue-tile-value">{value}</span>
        {points !== undefined && points >= 0.5 && (
          <span className="issue-tile-points" title="Points this took off the score">&minus;{Math.round(points)}</span>
        )}
      </span>
      <span className="issue-tile-label">{label}</span>
      {detail && <span className="issue-tile-detail">{detail}</span>}
    </>
  );
  return onClick
    ? (
      <button
        className={`issue-tile issue-tile--${tone} issue-tile--link${active ? ' selected' : ''}`}
        aria-pressed={active} onClick={onClick}
        title={active ? 'Show every moment again' : 'Show just these on the timeline and in the list'}
      >
        {body}
      </button>
    )
    : <div className={`issue-tile issue-tile--${tone}`}>{body}</div>;
}

/**
 * The drive at a glance: its score and basic figures on one line, then the
 * scorecard behind it. How the time split across speed bands is folded away
 * by default: it is rarely the question, and the timeline above already
 * shows speed against the limit through the whole drive.
 *
 * Each factor appears once. The scorecard used to repeat itself -- a list of
 * the factors that cost points, then tiles for the same speeding and events,
 * then the same counts again in the panels beside the map -- so it is now one
 * set of tiles, each carrying the points it cost. Tiles with nothing to report
 * stay, in green, because "no hard stops" is worth knowing too.
 *
 * The histogram shares the route line's colours so the two read as one system:
 * a band that is mostly orange on the map is the orange bar here. Every bar is
 * directly labelled and a table view is available, which is what lets the
 * colour ramp stay legible without relying on colour alone.
 */
export function SummaryPanel(
  { summary, theme, time, limitStatus, risk, onShowMoments, activeKind = 'all' }: {
    summary: TripSummary;
    theme: Theme;
    time: TimeContext;
    limitStatus: LimitStatus;
    risk: DriveRisk | null;
    onShowMoments?: (kind: MomentKind) => void;
    /** Which tile's moments are on show, so that tile reads as pressed. */
    activeKind?: MomentKind;
  },
) {
  const clock = (ms: number) => formatAbsolute(ms, time, { hour: 'numeric', minute: '2-digit' });
  const [asTable, setAsTable] = useState(false);
  const buckets = SPEED_BANDS.map((band, i) => ({ band, seconds: summary.histogramMph[i] ?? 0 }));
  const peak = Math.max(...buckets.map((b) => b.seconds), 1);
  const totalBucketed = buckets.reduce((sum, b) => sum + b.seconds, 0);
  const pointsFor = (key: string) => risk?.factors.find((factor) => factor.key === key)?.points;

  const eventTile = (kind: 'braking' | 'acceleration' | 'cornering', label: string) => {
    const ofKind = summary.harshEvents.filter((e) => e.kind === kind);
    const severe = ofKind.filter((e) => e.severity === 'severe').length;
    return (
      <ScoreTile
        label={label} value={String(ofKind.length)}
        detail={severe > 0 ? `${severe} severe` : undefined}
        tone={severe > 0 ? 'danger' : ofKind.length > 0 ? 'warn' : 'ok'}
        points={pointsFor(kind)}
        onClick={ofKind.length > 0 && onShowMoments ? () => onShowMoments(kind) : undefined}
        active={activeKind === kind}
      />
    );
  };

  const speeding = risk?.speeding;
  const speedingTile = (() => {
    if (limitStatus === 'loading') {
      return <ScoreTile label="Over the limit" value="…" detail="Checking limits" tone="muted" />;
    }
    if (!speeding) {
      return <ScoreTile label="Over the limit" value="—" detail="Limits not available" tone="muted" />;
    }
    const peakMph = Math.round(kphToMph(speeding.peakExcessKph));
    const parts = speeding.stretchCount > 0
      ? [
          `${speeding.stretchCount} stretch${speeding.stretchCount === 1 ? '' : 'es'}`,
          `peak +${peakMph} mph`,
          speeding.assumed ? 'some limits assumed' : null,
        ].filter(Boolean).join(' · ')
      : 'Within the limit';
    return (
      <ScoreTile
        label="Over the limit"
        value={speeding.stretchCount > 0 ? formatDuration(speeding.stretchSec) : '0s'}
        detail={parts}
        tone={speeding.bySeverity.severe > 0 ? 'danger' : speeding.stretchCount > 0 ? 'warn' : 'ok'}
        points={pointsFor('speeding')}
        onClick={speeding.stretchCount > 0 && onShowMoments ? () => onShowMoments('speeding') : undefined}
        active={activeKind === 'speeding'}
      />
    );
  })();

  const topMph = Math.round(kphToMph(summary.maxSpeedKph));
  const fastSec = summary.histogramMph.at(-1) ?? 0;

  return (
    <section className="summary" aria-label="Drive summary">
      <div className="score-hero">
        <ScoreGauge value={risk?.score ?? 0} band={risk?.band ?? 'moderate'} />
        <div className="score-hero-text">
          {risk ? (
            <>
              <strong className={`score-hero-band score-hero-band--${risk.band}`}>
                {BAND_LABEL[risk.band]}
              </strong>
              <span className="muted">
                {risk.factors.length === 0
                  ? (risk.includesSpeeding ? 'Nothing cost this drive points.' : 'Nothing has cost points so far.')
                  : `Lost most for ${FACTOR_NOUN[risk.factors[0]!.key] ?? risk.factors[0]!.label}.`}
                {!risk.includesSpeeding && (limitStatus === 'loading'
                  ? ' Speed limits still loading; speeding not yet counted.'
                  : ' Speed limits unavailable; speeding not counted.')}
                {risk.cappedBy && ` Capped for ${risk.cappedBy}.`}
              </span>
            </>
          ) : (
            <span className="muted">Too short a drive to score.</span>
          )}
        </div>
        {/* The basic figures, as one line beside the score: they frame the
            drive but are rarely what anyone came to look at. */}
        <dl className="stats stats--inline">
          <div><dt>Distance</dt><dd>{metersToMiles(summary.distanceMeters).toFixed(1)} <small>mi</small></dd></div>
          <div><dt>Moving</dt><dd>{duration(summary.movingSec)}</dd></div>
          <div><dt>Avg</dt><dd>{kphToMph(summary.averageMovingSpeedKph).toFixed(0)} <small>mph</small></dd></div>
          <div><dt>When</dt><dd className="stats-when">{clock(summary.startMs)}–{clock(summary.endMs)}</dd></div>
        </dl>
      </div>

      <div className="issue-grid">
        {speedingTile}
        <ScoreTile
          label="Top speed" value={`${topMph} mph`}
          detail={fastSec > 0 ? `${formatDuration(fastSec)} at 80+` : undefined}
          tone={topMph >= 90 ? 'danger' : topMph >= 80 ? 'warn' : 'ok'}
          points={pointsFor('top-speed')}
        />
        {eventTile('braking', 'Hard stops')}
        {eventTile('acceleration', 'Hard launches')}
        {eventTile('cornering', 'Sharp turns')}
      </div>

      <CollapsibleSection title="Time by speed" defaultOpen={false}>
        <div className="chart-head">
          <h3 className="muted">Speed bands, mph</h3>
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
      </CollapsibleSection>
    </section>
  );
}
