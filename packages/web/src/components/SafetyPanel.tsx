import { useState } from 'react';
import { kphToMph, type HarshEvent } from '@wolfbox/telemetry';
import { CollapsibleSection } from './CollapsibleSection.tsx';
import { formatAbsolute, type TimeContext } from '../time.ts';
import { metersToMiles } from '../units.ts';
import { seekTargetMs } from '../safety.ts';

/** How many events to list before the rest are folded away. */
const VISIBLE_EVENTS = 8;

const KIND_LABEL: Record<HarshEvent['kind'], string> = {
  braking: 'Hard braking',
  acceleration: 'Hard acceleration',
  cornering: 'Sharp turn',
};

const SEVERITY_CLASS: Record<HarshEvent['severity'], string> = {
  moderate: 'badge badge--warn',
  severe: 'badge badge--danger',
};

/** Stable across renders, unlike the array index, so a highlight survives the list re-sorting. */
const keyFor = (event: HarshEvent) => `${event.kind}-${event.startMs}`;

/**
 * Moments of hard braking, hard acceleration or sharp cornering, for a parent
 * checking how a drive actually felt rather than just how fast it was.
 *
 * This reads GPS-derived speed change, not the camera's raw accelerometer --
 * that field's scale and axis orientation are uncalibrated, unlike GPS speed,
 * which is checked against the camera's own burned-in overlay elsewhere. The
 * thresholds here are a reasonable starting point, not a validated one, so an
 * event is a prompt to check the clip, not a verdict on the driver.
 */
export function SafetyPanel({
  events, distanceMeters, tripStartMs, time, onSeek, selectedKey, onHighlight,
}: {
  events: HarshEvent[];
  distanceMeters: number;
  /** The trip's first sample, so a seek never lands before anything to show. */
  tripStartMs: number;
  time: TimeContext;
  onSeek: (timestampMs: number) => void;
  /** Key of the event currently highlighted on the map, if any. */
  selectedKey?: string | null;
  /** Marks an event as the one to highlight on the map. */
  onHighlight: (range: { startMs: number; endMs: number }, key: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const clock = (ms: number) =>
    formatAbsolute(ms, time, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  const braking = events.filter((e) => e.kind === 'braking').length;
  const acceleration = events.filter((e) => e.kind === 'acceleration').length;
  const cornering = events.filter((e) => e.kind === 'cornering').length;
  const severe = events.filter((e) => e.severity === 'severe').length;
  const miles = metersToMiles(distanceMeters);
  const per100 = miles > 0.5 ? (events.length / miles) * 100 : null;

  const listed = showAll ? events : events.slice(0, VISIBLE_EVENTS);

  return (
    <section className="safety">
      <CollapsibleSection title="Braking, acceleration & cornering" defaultOpen={false}>
        <dl className="stats">
          <div><dt>Hard braking</dt><dd>{braking}</dd></div>
          <div><dt>Hard acceleration</dt><dd>{acceleration}</dd></div>
          <div><dt>Sharp turns</dt><dd>{cornering}</dd></div>
          <div><dt>Severe</dt><dd>{severe}</dd></div>
          <div>
            <dt>Per 100 mi</dt>
            <dd>{per100 === null ? <span className="muted">&mdash;</span> : per100.toFixed(1)}</dd>
          </div>
        </dl>

        {events.length === 0 ? (
          <p className="muted pad">
            No hard braking, acceleration or sharp turns were detected on this drive.
          </p>
        ) : (
          <>
            <ul className="stretches">
              {listed.map((event) => (
                <EventRow
                  key={event.startMs} event={event} clock={clock}
                  onSeek={onSeek} tripStartMs={tripStartMs}
                  selected={selectedKey === keyFor(event)} onHighlight={onHighlight}
                />
              ))}
            </ul>
            {events.length > VISIBLE_EVENTS && (
              <button className="link" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show fewer' : `Show all ${events.length}`}
              </button>
            )}
          </>
        )}
      </CollapsibleSection>
    </section>
  );
}

function EventRow({
  event, clock, onSeek, tripStartMs, selected, onHighlight,
}: {
  event: HarshEvent;
  clock: (ms: number) => string;
  onSeek: (ms: number) => void;
  tripStartMs: number;
  selected: boolean;
  onHighlight: (range: { startMs: number; endMs: number }, key: string) => void;
}) {
  return (
    <li className={selected ? 'stretch selected' : 'stretch'}>
      <button
        className="link stretch-seek"
        onClick={() => {
          onSeek(seekTargetMs(event, tripStartMs));
          onHighlight({ startMs: event.startMs, endMs: event.endMs }, keyFor(event));
        }}
        title={event.kind === 'braking'
          ? 'Jump to just before this stop in the footage, and show it on the map'
          : 'Jump to this moment in the footage, and show it on the map'}
      >
        {clock(event.startMs)}
      </button>
      <span className="stretch-what">
        <strong>{KIND_LABEL[event.kind]}{event.direction ? ` ${event.direction}` : ''}</strong>
      </span>
      <span className="stretch-for muted">
        {event.kind === 'cornering'
          ? `${Math.abs(event.peakG).toFixed(2)} g at ${Math.round(kphToMph(event.speedKph))} mph`
          : `${Math.abs(Math.round(kphToMph(event.peakDeltaKph)))} mph/s`}
      </span>
      <span className={SEVERITY_CLASS[event.severity]}>{event.severity}</span>
    </li>
  );
}
