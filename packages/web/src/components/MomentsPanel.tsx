import { useMemo, useState } from 'react';
import {
  kphToMph, TOLERANCE_MPH, SUSTAIN_SEC,
  type HarshEvent, type OverLimitStretch, type TripAdherence,
} from '@wolfbox/telemetry';
import { CollapsibleSection } from './CollapsibleSection.tsx';
import { formatAbsolute, type TimeContext } from '../time.ts';
import { buildMoments, type Moment as TimelineMoment } from '../timeline.ts';
import type { LimitStatus } from '../limits.ts';
import type { MomentKind } from './SummaryPanel.tsx';

/** A timeline moment with what the list needs to describe it. Exported for tests. */
export interface Moment extends TimelineMoment {
  title: string;
  where?: string;
  detail: string;
  assumed?: boolean;
}

const SEVERITY_RANK = { severe: 0, moderate: 1, minor: 2 } as const;

const KIND_LABEL: Record<Exclude<MomentKind, 'all'>, string> = {
  speeding: 'Speeding', braking: 'Hard stops', acceleration: 'Launches', cornering: 'Turns',
};

const EVENT_TITLE: Record<HarshEvent['kind'], string> = {
  braking: 'Hard stop', acceleration: 'Hard launch', cornering: 'Sharp turn',
};

function duration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * The timeline's moments -- same keys, same seek points, so the list, the
 * timeline and the map always agree -- described for a list. Exported for tests.
 */
export function describeMoments(
  stretches: readonly OverLimitStretch[], events: readonly HarshEvent[], tripStartMs: number,
): Moment[] {
  const stretchAt = new Map(stretches.map((stretch) => [`stretch-${stretch.startMs}`, stretch]));
  const eventAt = new Map(events.map((event) => [`${event.kind}-${event.startMs}`, event]));
  return buildMoments(events, stretches, tripStartMs).map((moment): Moment => {
    const stretch = stretchAt.get(moment.key);
    if (stretch) {
      return {
        ...moment,
        title: `${Math.round(kphToMph(stretch.peakSpeedKph))} in a ${Math.round(kphToMph(stretch.limitKph))}`,
        where: stretch.roadName,
        detail: `for ${duration(stretch.durationSec)}`,
        assumed: stretch.limitSource === 'inferred',
      };
    }
    const event = eventAt.get(moment.key)!;
    return {
      ...moment,
      title: `${EVENT_TITLE[event.kind]}${event.direction ? ` ${event.direction}` : ''}`,
      detail: event.kind === 'cornering'
        ? `${Math.abs(event.peakG).toFixed(2)} g at ${Math.round(kphToMph(event.speedKph))} mph`
        : `${Math.abs(Math.round(kphToMph(event.peakDeltaKph)))} mph/s`,
    };
  });
}

const NO_STRETCHES: readonly OverLimitStretch[] = [];

/** How many moments to list before the rest are folded away. */
const VISIBLE = 10;

const share = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Everything on this drive worth watching, in one list: speeding stretches
 * and hard stops, launches and turns. Tapping one plays it and shows it on
 * the map; the chips narrow it to one kind; "worst first" puts the severe
 * ones on top for a quick review.
 *
 * This replaces separate speed-limit and braking panels whose headline counts
 * repeated the scorecard. What stays from them is what qualifies the numbers:
 * how much of the route had a known limit, and that OpenStreetMap limits and
 * consumer GPS are a guide, not a record. The language stays "over the limit",
 * never "violation", for the same reason.
 */
export function MomentsPanel({
  limitStatus, adherence, events, tripStartMs, time, onSeek, onOpen, selectedKey, onHighlight,
  kind, onKindChange,
}: {
  limitStatus: LimitStatus;
  adherence?: TripAdherence;
  events: HarshEvent[];
  tripStartMs: number;
  time: TimeContext;
  onSeek: (timestampMs: number) => void;
  /** Opening the panel is what allows the speed-limit lookup to run. */
  onOpen: (open: boolean) => void;
  selectedKey?: string | null;
  onHighlight: (range: { startMs: number; endMs: number }, key: string) => void;
  kind: MomentKind;
  onKindChange: (kind: MomentKind) => void;
}) {
  const [worstFirst, setWorstFirst] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const clock = (ms: number) => formatAbsolute(ms, time, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  const stretches = (limitStatus === 'ready' && adherence?.stretches) || NO_STRETCHES;
  const all = useMemo(() => describeMoments(stretches, events, tripStartMs), [stretches, events, tripStartMs]);
  const counts = useMemo(() => {
    const out: Record<Exclude<MomentKind, 'all'>, number> = { speeding: 0, braking: 0, acceleration: 0, cornering: 0 };
    for (const moment of all) out[moment.kind]++;
    return out;
  }, [all]);
  const shown = useMemo(() => {
    const filtered = kind === 'all' ? all : all.filter((moment) => moment.kind === kind);
    return worstFirst
      ? [...filtered].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.startMs - b.startMs)
      : filtered;
  }, [all, kind, worstFirst]);
  const listed = showAll ? shown : shown.slice(0, VISIBLE);
  const severe = all.filter((moment) => moment.severity === 'severe').length;

  return (
    <section className="moments">
      <CollapsibleSection
        title={all.length > 0 ? `Moments to check · ${all.length}` : 'Moments to check'}
        defaultOpen={true} onToggle={onOpen}
      >
        {all.length > 0 && (
          <div className="moments-controls">
            <div className="moment-filters" role="group" aria-label="Show">
              <button className={kind === 'all' ? 'chip selected' : 'chip'} aria-pressed={kind === 'all'} onClick={() => onKindChange('all')}>
                All <span className="count">{all.length}</span>
              </button>
              {(Object.keys(KIND_LABEL) as Exclude<MomentKind, 'all'>[]).filter((k) => counts[k] > 0).map((k) => (
                <button key={k} className={kind === k ? 'chip selected' : 'chip'} aria-pressed={kind === k} onClick={() => onKindChange(kind === k ? 'all' : k)}>
                  <span className={`moment-dot moment-dot--${k}`} aria-hidden="true" />
                  {KIND_LABEL[k]} <span className="count">{counts[k]}</span>
                </button>
              ))}
            </div>
            <button className="link" onClick={() => setWorstFirst(!worstFirst)} aria-pressed={worstFirst}>
              {worstFirst ? 'In order' : `Worst first${severe ? ` · ${severe} severe` : ''}`}
            </button>
          </div>
        )}

        {limitStatus === 'loading' && <p className="notice">Looking up speed limits&hellip;</p>}
        {limitStatus === 'unavailable' && (
          <p className="notice">
            Speed limits are unavailable &mdash; the lookup could not reach OpenStreetMap.
            Braking, launches and turns below are unaffected.
          </p>
        )}
        {limitStatus === 'idle' && (
          <p className="muted pad">
            Checking speeding needs a lookup to OpenStreetMap. Nothing leaves your
            machine until this panel is open.
          </p>
        )}

        {all.length === 0 && limitStatus !== 'loading' && (
          <p className="moments-clean">
            Nothing to check{limitStatus === 'ready' ? `: never more than ${TOLERANCE_MPH} mph over a known limit for over ${SUSTAIN_SEC}s,` : ':'} and
            no hard stops, launches or sharp turns.
          </p>
        )}

        {listed.length > 0 && (
          <ul className="stretches">
            {listed.map((moment) => (
              <li key={moment.key} className={selectedKey === moment.key ? 'stretch moment selected' : 'stretch moment'}>
                <button
                  className="moment-button"
                  onClick={() => {
                    onSeek(moment.seekMs);
                    onHighlight({ startMs: moment.startMs, endMs: moment.endMs }, moment.key);
                  }}
                  title="Play this moment and show it on the map"
                >
                  <span className={`moment-dot moment-dot--${moment.kind}`} aria-hidden="true" />
                  <span className="moment-when">{clock(moment.startMs)}</span>
                  <span className="moment-what">
                    <strong className={moment.severity === 'severe' ? 'peak-severe' : undefined}>{moment.title}</strong>
                    {moment.where && <span className="muted"> on {moment.where}</span>}
                    <span className="moment-detail"> {moment.detail}</span>
                  </span>
                  {moment.assumed && <span className="badge" title="No limit was signed here; assumed from the road type.">assumed</span>}
                  <span className={moment.severity === 'severe' ? 'badge badge--danger' : moment.severity === 'moderate' ? 'badge badge--warn' : 'badge'}>
                    {moment.severity}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {shown.length > VISIBLE && (
          <button className="link" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${shown.length}`}
          </button>
        )}

        {limitStatus === 'ready' && adherence && <Coverage adherence={adherence} />}
      </CollapsibleSection>
    </section>
  );
}

/** How far the speeding figures can be trusted: always beside them, never in a tooltip. */
function Coverage({ adherence }: { adherence: TripAdherence }) {
  const { coverage } = adherence;
  const moving = coverage.movingSec;
  const known = moving > 0 ? (coverage.taggedSec + coverage.implicitSec) / moving : 0;
  const guessed = moving > 0 ? coverage.inferredSec / moving : 0;
  const nothing = moving > 0 ? (coverage.unmatchedSec + coverage.unknownSec) / moving : 0;
  const within = adherence.score ?? adherence.scoreWithInferred;
  return (
    <p className="coverage">
      {within !== null && <>Within the limit <strong>{share(within)}</strong> of the time{adherence.score === null ? ' (assumed limits)' : ''}. </>}
      Limits known for <strong>{share(known)}</strong> of moving time
      {guessed > 0.005 && <>, <strong>{share(guessed)}</strong> assumed from road type</>}
      {nothing > 0.005 && <>, <strong>{share(nothing)}</strong> none found</>}.
      {' '}<span className="muted">Limits from OpenStreetMap contributors (ODbL); crowd-sourced data and consumer GPS are a guide, not a record.</span>
    </p>
  );
}
