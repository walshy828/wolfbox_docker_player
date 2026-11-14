import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
 * A menu that closes on a click outside it or on Escape. The wrapper `ref`
 * must contain both the trigger and the panel, so the trigger's own click is
 * not read as "outside" and the menu does not close and reopen.
 */
function usePopover(onClose?: () => void) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => { setOpen(false); closeRef.current?.(); }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape also leaves full screen; a menu open on top of it closes first.
      event.stopImmediatePropagation();
      close();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);
  return { open, toggle: () => (open ? close() : setOpen(true)), close, ref };
}

const isTyping = (target: EventTarget | null) =>
  (target as HTMLElement | null)?.closest?.('input, select, textarea, [contenteditable="true"]') != null;

/**
 * Who drove, whether it needs a closer look, and what to remember about it,
 * as one compact row for the review header.
 *
 * The flag is a single toggle (or `F`); the driver and the notes open small
 * menus under their buttons (`N` opens notes), so none of them takes a row of
 * the workspace away from the video. Notes save themselves when typing pauses
 * or the menu closes. A drive that is not yet in history is saved the moment
 * any of these is set, so a note can never be lost to the card looping over
 * the drive it was about.
 */
export function DriveActions({
  copy, drivers, onChange, onAddDriver, status, saved, actions,
}: {
  /** The history's record of this drive, once there is one. */
  copy?: ArchivedTrip;
  drivers: Driver[];
  onChange: (patch: TripPatch) => Promise<void>;
  onAddDriver: (name: string) => Promise<Driver>;
  /** Where this drive is kept, in a few words. */
  status: ReactNode;
  /** Whether the drive is in history yet; colours the history button. */
  saved: 'video' | 'data' | 'none';
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

  // "Saved" is a confirmation, not a state to stare at.
  useEffect(() => {
    if (saving !== 'saved') return;
    const id = setTimeout(() => setSaving('idle'), 2000);
    return () => clearTimeout(id);
  }, [saving]);

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
  const flushRef = useRef(flushNotes);
  flushRef.current = flushNotes;

  useEffect(() => {
    if (notes.trim() === savedNotes.current.trim()) return;
    timer.current = setTimeout(flushNotes, NOTES_IDLE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  // Leaving the drive mid-sentence still keeps the sentence.
  useEffect(() => () => flushRef.current(), []);

  const driverId = copy?.driverId ?? null;
  const driver = drivers.find((d) => d.id === driverId);
  const flagged = copy?.flagged ?? false;

  const driverMenu = usePopover(() => { setAdding(false); setNewName(''); });
  const notesMenu = usePopover(() => flushRef.current());
  const historyMenu = usePopover();

  const toggleFlag = () => void run({ flagged: !flagged });
  const flagRef = useRef(toggleFlag);
  flagRef.current = toggleFlag;
  const openNotesRef = useRef(() => { if (!notesMenu.open) notesMenu.toggle(); });
  openNotesRef.current = () => { if (!notesMenu.open) notesMenu.toggle(); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === 'f' || event.key === 'F') { event.preventDefault(); flagRef.current(); }
      if (event.key === 'n' || event.key === 'N') { event.preventDefault(); openNotesRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const addDriver = async () => {
    const name = newName.trim();
    if (!name) return;
    const created = await onAddDriver(name);
    setNewName('');
    setAdding(false);
    driverMenu.close();
    await run({ driverId: created.id });
  };

  const pickDriver = (id: number | null) => {
    driverMenu.close();
    if (id !== driverId) void run({ driverId: id });
  };

  const notePreview = notes.trim().split('\n')[0];

  return (
    <div className="drive-actions" role="group" aria-label="Driver, flag and notes">
      <div className="popover-anchor" ref={driverMenu.ref}>
        <button
          className={driver ? 'action-button selected' : 'action-button'}
          aria-haspopup="menu" aria-expanded={driverMenu.open}
          onClick={driverMenu.toggle}
          title={driver ? `Driven by ${driver.name}` : 'Who drove?'}
        >
          <PersonIcon />
          <span className="action-label">{driver ? driver.name : 'Driver'}</span>
          <Caret />
        </button>
        {driverMenu.open && (
          <div className="popover popover--menu" role="menu" aria-label="Who drove">
            {drivers.map((d) => (
              <button
                key={d.id} role="menuitemradio" aria-checked={d.id === driverId}
                className="menu-item" onClick={() => pickDriver(d.id)}
              >
                <span className="menu-check" aria-hidden="true">{d.id === driverId ? '✓' : ''}</span>
                {d.name}
              </button>
            ))}
            {driverId !== null && (
              <button role="menuitem" className="menu-item menu-item--muted" onClick={() => pickDriver(null)}>
                <span className="menu-check" aria-hidden="true" />
                Clear driver
              </button>
            )}
            <div className="menu-sep" />
            {adding ? (
              <form className="driver-add" onSubmit={(event) => { event.preventDefault(); void addDriver(); }}>
                <input
                  autoFocus value={newName} maxLength={40} placeholder="Name"
                  aria-label="New driver's name"
                  onChange={(event) => setNewName(event.target.value)}
                />
                <button type="submit" className="chip" disabled={!newName.trim()}>Add</button>
              </form>
            ) : (
              <button role="menuitem" className="menu-item" onClick={() => setAdding(true)}>
                <span className="menu-check" aria-hidden="true">+</span>
                {drivers.length === 0 ? 'Add a driver' : 'Add driver'}
              </button>
            )}
          </div>
        )}
      </div>

      <button
        className={flagged ? 'action-button action-button--flag selected' : 'action-button action-button--flag'}
        aria-pressed={flagged}
        title={flagged ? 'Clear the flag (F)' : 'Flag this drive to look at or talk about (F)'}
        onClick={toggleFlag}
      >
        <FlagGlyph title={flagged ? 'Flagged' : 'Flag'} />
        <span className="action-label">{flagged ? 'Flagged' : 'Flag'}</span>
      </button>

      <div className="popover-anchor popover-anchor--grow" ref={notesMenu.ref}>
        <button
          className={notePreview ? 'action-button action-button--note has-note' : 'action-button action-button--note'}
          aria-haspopup="dialog" aria-expanded={notesMenu.open}
          onClick={notesMenu.toggle}
          title={notePreview ? `${notes.trim()}\n\n(N to edit)` : 'Add a note (N)'}
        >
          <NoteIcon />
          <span className="action-label action-note-text">{notePreview || 'Note'}</span>
        </button>
        {notesMenu.open && (
          <div className="popover popover--notes" role="dialog" aria-label="Notes about this drive">
            <textarea
              autoFocus
              className="drive-notes-text"
              value={notes}
              placeholder="What to talk about, what to check in the footage…"
              rows={5}
              maxLength={4000}
              onChange={(event) => setNotes(event.target.value)}
              onBlur={flushNotes}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) notesMenu.close();
              }}
              aria-label="Notes about this drive"
            />
            <div className="popover-foot">
              <span className="muted">Saves as you type · ⌘↩ to close</span>
              <span className="spacer" />
              <button className="chip" onClick={notesMenu.close}>Done</button>
            </div>
          </div>
        )}
      </div>

      <span className="drive-actions-status" aria-live="polite">
        {saving === 'saving' && <span className="muted">Saving…</span>}
        {saving === 'saved' && <span className="drive-notes-ok">Saved</span>}
        {saving === 'error' && <span className="drive-notes-error">Could not save</span>}
      </span>

      <div className="popover-anchor" ref={historyMenu.ref}>
        <button
          className={`icon-toggle history-button history-button--${saved}`}
          aria-haspopup="menu" aria-expanded={historyMenu.open}
          onClick={historyMenu.toggle}
          title={typeof status === 'string' ? status : 'History'}
          aria-label="History options"
        >
          <HistoryIcon saved={saved !== 'none'} />
        </button>
        {historyMenu.open && (
          <div className="popover popover--menu popover--right" role="menu">
            <p className="menu-status">{status}</p>
            {actions && <div className="menu-actions" onClick={() => historyMenu.close()}>{actions}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function Caret() {
  return (
    <svg className="caret" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
      <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="5.2" r="2.7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.8 14 C3.4 10.8 5.4 9.4 8 9.4 S12.6 10.8 13.2 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3 2.5 H10.5 L13 5 V13.5 H3 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M5.5 7 H10.5 M5.5 9.5 H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function HistoryIcon({ saved }: { saved: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="3" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 6 V13 H13 V6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      {saved
        ? <path d="M5.8 9.4 L7.4 11 L10.4 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M6.5 9 H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}
