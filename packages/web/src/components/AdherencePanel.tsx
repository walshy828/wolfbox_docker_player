import { useState } from 'react';
import {
  kphToMph, severityFor, TOLERANCE_MPH, SUSTAIN_SEC,
  type OverLimitStretch, type TripAdherence,
} from '@wolfbox/telemetry';
import { CollapsibleSection } from './CollapsibleSection.tsx';
import { formatAbsolute, type TimeContext } from '../time.ts';
import type { LimitStatus } from '../limits.ts';

const mi = (meters: number) => meters / 1609.344;
const share = (value: number) => `${Math.round(value * 100)}%`;

function duration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** How many stretches to list before the rest are folded away. */
const VISIBLE_STRETCHES = 8;

/** Stable across renders, unlike the array index, so a highlight survives the list re-sorting. */
const keyFor = (stretch: OverLimitStretch) => `stretch-${stretch.startMs}`;

/**
 * How the drive compared against the speed limits of the roads it was on.
 *
 * Two things drive the shape of this panel, both about not overstating what
 * the data supports. The first is that OpenStreetMap's limits are patchy: a
 * motorway is reliably signed, a residential street almost never is, so a
 * score built on guessed limits is withheld rather than shown next to one
 * built on real ones. The second is that this is a review tool over
 * crowd-sourced data and consumer GPS -- so the language is "over the limit",
 * never "violation", and the coverage line is always on screen beside the
 * numbers rather than tucked behind a tooltip.
 */
export function AdherencePanel({
  status, adherence, time, onSeek, onOpen, selectedKey, onHighlight,
}: {
  status: LimitStatus;
  adherence?: TripAdherence;
  time: TimeContext;
  onSeek: (timestampMs: number) => void;
  onOpen: (open: boolean) => void;
  /** Key of the stretch currently highlighted on the map, if any. */
  selectedKey?: string | null;
  /** Marks a stretch as the one to highlight on the map. */
  onHighlight: (range: { startMs: number; endMs: number }, key: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const clock = (ms: number) =>
    formatAbsolute(ms, time, { hour: 'numeric', minute: '2-digit' });

  return (
    <section className="adherence">
      <CollapsibleSection title="Speed limits" defaultOpen={true} onToggle={onOpen}>
        {status === 'loading' && <p className="notice">Looking up speed limits&hellip;</p>}

        {status === 'unavailable' && (
          <p className="notice">
            Speed limits are unavailable &mdash; the lookup could not reach OpenStreetMap.
            Everything else about this drive is unaffected.
          </p>
        )}

        {status === 'idle' && (
          <p className="muted pad">
            Comparing this drive against posted limits needs a lookup to
            OpenStreetMap. Nothing leaves your machine until you open this.
          </p>
        )}

        {status === 'ready' && adherence && <Report
          adherence={adherence} clock={clock} onSeek={onSeek}
          showAll={showAll} onShowAll={setShowAll}
          selectedKey={selectedKey} onHighlight={onHighlight}
        />}
      </CollapsibleSection>
    </section>
  );
}

function Report({
  adherence, clock, onSeek, showAll, onShowAll, selectedKey, onHighlight,
}: {
  adherence: TripAdherence;
  clock: (ms: number) => string;
  onSeek: (ms: number) => void;
  showAll: boolean;
  onShowAll: (v: boolean) => void;
  selectedKey?: string | null;
  onHighlight: (range: { startMs: number; endMs: number }, key: string) => void;
}) {
  const { coverage, stretches } = adherence;
  const moving = coverage.movingSec;
  const known = moving > 0 ? (coverage.taggedSec + coverage.implicitSec) / moving : 0;
  const guessed = moving > 0 ? coverage.inferredSec / moving : 0;
  const nothing = moving > 0
    ? (coverage.unmatchedSec + coverage.unknownSec) / moving : 0;

  const headline = adherence.score ?? adherence.scoreWithInferred;
  const restingOnGuesses = adherence.score === null;
  const listed = showAll ? stretches : stretches.slice(0, VISIBLE_STRETCHES);

  return (
    <>
      <dl className="stats">
        <div>
          <dt>Within limit</dt>
          <dd>
            {headline === null ? <span className="muted">&mdash;</span> : share(headline)}
            {headline !== null && restingOnGuesses && <small>assumed limits</small>}
          </dd>
        </div>
        <div>
          <dt>Over limit</dt>
          <dd>{mi(adherence.overLimitMeters).toFixed(1)} <small>mi</small></dd>
        </div>
        <div>
          <dt>Peak over</dt>
          <dd className={adherence.peakExcessKph > 0
            && severityFor(adherence.peakExcessKph) === 'severe' ? 'peak-severe' : undefined}>
            {adherence.peakExcessKph > 0
              ? <>+{kphToMph(adherence.peakExcessKph).toFixed(0)} <small>mph</small></>
              : <span className="muted">&mdash;</span>}
          </dd>
        </div>
        <div><dt>Stretches</dt><dd>{stretches.length}</dd></div>
      </dl>

      <p className="coverage">
        Limits known for <strong>{share(known)}</strong> of moving time
        {guessed > 0.005 && <> · <strong>{share(guessed)}</strong> assumed from road type</>}
        {nothing > 0.005 && <> · <strong>{share(nothing)}</strong> no limit found</>}.
      </p>

      {headline === null && (
        <p className="notice">
          Too little of this route had a known limit to score it. The stretches below
          are still worth a look, but treat them as a prompt to check the footage.
        </p>
      )}

      {stretches.length === 0 ? (
        <p className="muted pad">
          Nothing was more than {TOLERANCE_MPH} mph over a known limit for longer
          than {SUSTAIN_SEC} seconds.
        </p>
      ) : (
        <>
          <ul className="stretches">
            {listed.map((stretch) => (
              <StretchRow
                key={stretch.startMs} stretch={stretch}
                clock={clock} onSeek={onSeek}
                selected={selectedKey === keyFor(stretch)} onHighlight={onHighlight}
              />
            ))}
          </ul>
          {stretches.length > VISIBLE_STRETCHES && (
            <button className="link" onClick={() => onShowAll(!showAll)}>
              {showAll
                ? 'Show fewer'
                : `Show all ${stretches.length}`}
            </button>
          )}
        </>
      )}

      <p className="summary-window">
        Limits from OpenStreetMap contributors, under the ODbL. Crowd-sourced data
        and consumer GPS &mdash; a guide, not a record.
      </p>
    </>
  );
}

const SEVERITY_CLASS = {
  minor: 'badge',
  moderate: 'badge badge--warn',
  severe: 'badge badge--danger',
} as const;

function StretchRow({
  stretch, clock, onSeek, selected, onHighlight,
}: {
  stretch: OverLimitStretch;
  clock: (ms: number) => string;
  onSeek: (ms: number) => void;
  selected: boolean;
  onHighlight: (range: { startMs: number; endMs: number }, key: string) => void;
}) {
  const peak = Math.round(kphToMph(stretch.peakSpeedKph));
  const limit = Math.round(kphToMph(stretch.limitKph));

  return (
    <li className={selected ? 'stretch selected' : 'stretch'}>
      <button
        className="link stretch-seek"
        onClick={() => {
          onSeek(stretch.startMs);
          onHighlight({ startMs: stretch.startMs, endMs: stretch.endMs }, keyFor(stretch));
        }}
        title="Jump to this moment in the footage, and show it on the map"
      >
        {clock(stretch.startMs)}
      </button>
      <span className="stretch-what">
        <strong className={stretch.severity === 'severe' ? 'peak-severe' : undefined}>
          {peak} in a {limit}
        </strong>
        {stretch.roadName && <span className="muted"> on {stretch.roadName}</span>}
      </span>
      <span className="stretch-for muted">{duration(stretch.durationSec)}</span>
      <span className={SEVERITY_CLASS[stretch.severity]}>{stretch.severity}</span>
      {stretch.limitSource === 'inferred' && (
        <span className="badge" title="No limit was signed here; assumed from the road type.">
          assumed
        </span>
      )}
    </li>
  );
}
