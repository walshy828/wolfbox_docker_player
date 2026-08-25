interface ConfirmProps {
  /** Reads after "Delete", e.g. "this drive and its 12 clips?". */
  question: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Are-you-sure, in place.
 *
 * Deleting from the card is permanent -- the File System Access API has no
 * trash -- so every delete asks first. It asks inside the row or control that
 * was clicked rather than in a modal, so the thing about to be deleted stays
 * visible next to the question, and dismissing it costs nothing.
 */
export function ConfirmInline({ question, busy, onConfirm, onCancel }: ConfirmProps) {
  return (
    <span className="confirm-inline" role="group">
      <span className="confirm-question">Delete {question} Permanent.</span>
      <button className="danger" onClick={onConfirm} disabled={busy}>
        {busy ? 'Deleting...' : 'Delete'}
      </button>
      {/* Keyboard focus lands on the way out, not on the destructive button. */}
      <button onClick={onCancel} disabled={busy} autoFocus>Cancel</button>
    </span>
  );
}

interface DeleteButtonProps {
  onClick: () => void;
  /** Named for screen readers, e.g. "this drive". */
  label: string;
  className?: string;
}

/** The trash affordance that opens a `ConfirmInline`. */
export function DeleteButton({ onClick, label, className = 'icon-button' }: DeleteButtonProps) {
  return (
    <button className={className} onClick={onClick} title={`Delete ${label}`} aria-label={`Delete ${label}`}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M2.5 4.5h11M6.5 4.5V2.5h3v2M4 4.5l.7 9h6.6l.7-9M6.5 7v4.5M9.5 7v4.5"
          fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
