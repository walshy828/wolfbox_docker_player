import { useState } from 'react';
import type { ReviewTrip } from '../card.ts';
import { formatLocal, type TimeContext } from '../time.ts';
import { CollapsibleSection } from './CollapsibleSection.tsx';
import { ConfirmInline, DeleteButton } from './ConfirmInline.tsx';

interface Props {
  trip: ReviewTrip;
  clipIndex: number;
  onSelect: (index: number) => void;
  /** Absent for archived drives: their clips are not on a card to delete. */
  onDelete?: (index: number) => void;
  deleting: boolean;
  time: TimeContext;
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', second: '2-digit' };

/**
 * The trip's clips, one chip each.
 *
 * The transport can only step through clips one at a time and reports "clip 3
 * of 12", which is no help when you want the one where something happened, or
 * want to throw a particular minute away. Front and rear are one chip because
 * they are one minute of the drive; deleting splits them from nothing.
 */
export function ClipStrip({ trip, clipIndex, onSelect, onDelete, deleting, time }: Props) {
  const [confirming, setConfirming] = useState<number | null>(null);

  return (
    <section className="clip-strip" aria-label="Clips in this trip">
      <CollapsibleSection title="Clips" count={trip.clips.length}>
        <ol>
          {trip.clips.map((pair, index) => {
            const cameras = [pair.front && 'F', pair.rear && 'R'].filter(Boolean).join('+');
            return (
              <li key={`${pair.startLocalMs}-${pair.front?.name ?? pair.rear?.name}`}>
                {confirming === index ? (
                  <ConfirmInline
                    question="this clip?"
                    busy={deleting}
                    onConfirm={() => { setConfirming(null); onDelete?.(index); }}
                    onCancel={() => setConfirming(null)}
                  />
                ) : (
                  <div className={index === clipIndex ? 'clip-chip current' : 'clip-chip'}>
                    <button onClick={() => onSelect(index)} aria-current={index === clipIndex}>
                      {/* The ordinal is what the transport counts in, so it is
                          what makes "clip 7 of 16" findable in the grid. */}
                      <span className="clip-index">{index + 1}</span>
                      <span className="clip-when">{formatLocal(pair.startLocalMs, time, CLOCK)}</span>
                      <span className="clip-meta">
                        {cameras || 'missing'}
                        {pair.kind === 'event' && <span className="badge badge--warn">event</span>}
                      </span>
                    </button>
                    {onDelete && (
                      <DeleteButton
                        label="this clip"
                        onClick={() => setConfirming(index)}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </CollapsibleSection>
    </section>
  );
}
