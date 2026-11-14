import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ArchivedTrip, Driver, TripPatch } from '../archive.ts';

/** A driver's name as a small pill, with their initial for a narrow list. */
export function DriverTag({ name }: { name: string }) {
  return (
    <span className="driver-tag" title={`Driven by ${name}`}>
      <span className="driver-tag-initial" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
      <span className="driver-tag-name">{name}</span>
    </span>
  );
}

export function FlagGlyph({ title = 'Flagged for review' }: { title?: string }) {
  return (
    <svg className="flag-glyph" viewBox="0 0 16 16" width="13" height="13" role="img" aria-label="Flagged">
      <title>{title}</title>
      <path d="M3.5 14.5 V2 M3.5 2.5 H12 L10 5.5 L12 8.5 H3.5" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** How long typing has to pause before the notes are saved on their own. */
const NOTES_IDLE_MS = 900;

/**
 * Who drove, whether it needs a closer look, and what to remember about it.
 *
 * Every control is one tap: a driver is a chip, not a dropdown; the flag is a
 * toggle; notes save themselves when typing pauses or the box loses focus.
 * A drive that is not yet in history (auto-save is off, or has not reached it)
 * is saved the moment any of these is set, so a note can never be lost to the
 * card looping over the drive it was about.
 */
export function DriveNotes({
  copy, drivers, onChange, onAddDriver, status, actions,
}: {
  /** The history's record of this drive, once there is one. */
  copy?: ArchivedTrip;
  drivers: Driver[];
  onChange: (patch: TripPatch) => Promise<void>;
  onAddDriver: (name: string) => Promise<Driver>;
  /** Where this drive is kept, in a few words. */
  status: ReactNode;
  /** Save video, remove from archive: whatever applies to where it is kept. */
  actions?: ReactNode;
}) {
  const [notes, setNotes] = useState(copy?.notes ?? '');
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const savedNotes = useRef(copy?.notes ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A save from elsewhere (another tab, a re-import) updates the box, unless
  // the reviewer is mid-sentence in it.
  useEffect(() => {
    const incoming = copy?.notes ?? '';
    // The server trims; that alone must not eat a space being typed.
    if (incoming.trim() === savedNotes.current.trim()) return;
    if (notes.trim() === savedNotes.current.trim()) setNotes(incoming);
    savedNotes.current = incoming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy?.notes]);

  const run = async (patch: TripPatch) => {
    setSaving('saving');
    try {
      await onChange(patch);
      setSaving('saved');
    } catch {
      setSaving('error');
    }
  };

  const flushNotes = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (notes.trim() === savedNotes.current.trim()) return;
    savedNotes.current = notes;
    void run({ notes });
  };

  useEffect(() => {
    if (notes.trim() === savedNotes.current.trim()) return;
    timer.current = setTimeout(flushNotes, NOTES_IDLE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  const driverId = copy?.driverId ?? null;
  const flagged = copy?.flagged ?? false;

  const addDriver = async () => {
    const name = newName.trim();
    if (!name) return;
    const driver = await onAddDriver(name);
    setNewName('');
    setAdding(false);
    await run({ driverId: driver.id });
  };

  return (
    <section className="drive-notes" aria-label="Driver and notes">
      <div className="drive-notes-row">
        <span className="drive-notes-label">Driver</span>
        <div className="driver-chips" role="group" aria-label="Who drove">
          {drivers.map((driver) => (
            <button
              key={driver.id}
              className={driverId === driver.id ? 'chip selected' : 'chip'}
              aria-pressed={driverId === driver.id}
              title={driverId === driver.id ? 'Tap again to clear' : `Mark as driven by ${driver.name}`}
              onClick={() => void run({ driverId: driverId === driver.id ? null : driver.id })}
            >
              {driver.name}
            </button>
          ))}
          {adding ? (
            <form className="driver-add" onSubmit={(event) => { event.preventDefault(); void addDriver(); }}>
              <input
                autoFocus value={newName} maxLength={40} placeholder="Name"
                aria-label="New driver's name"
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') { setAdding(false); setNewName(''); } }}
              />
              <button type="submit" className="chip" disabled={!newName.trim()}>Add</button>
            </form>
          ) : (
            <button className="chip chip--ghost" onClick={() => setAdding(true)} title="Add a driver">
              + {drivers.length === 0 ? 'Add a driver' : 'Add'}
            </button>
          )}
        </div>
        <span className="spacer" />
        <button
          className={flagged ? 'chip chip--flag selected' : 'chip chip--flag'}
          aria-pressed={flagged}
          title={flagged ? 'Clear the flag' : 'Flag this drive to look at or talk about'}
          onClick={() => void run({ flagged: !flagged })}
        >
          <FlagGlyph /> {flagged ? 'Flagged' : 'Flag'}
        </button>
      </div>

      <textarea
        className="drive-notes-text"
        value={notes}
        placeholder="Notes: what to talk about, what to check in the footage…"
        rows={notes.includes('\n') || notes.length > 80 ? 3 : 1}
        maxLength={4000}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={flushNotes}
        aria-label="Notes about this drive"
      />

      <div className="drive-notes-foot">
        <span className="muted">{status}</span>
        {saving === 'saving' && <span className="muted">Saving…</span>}
        {saving === 'saved' && <span className="drive-notes-ok">Saved</span>}
        {saving === 'error' && <span className="drive-notes-error">Could not save</span>}
        <span className="spacer" />
        {actions}
      </div>
    </section>
  );
}
