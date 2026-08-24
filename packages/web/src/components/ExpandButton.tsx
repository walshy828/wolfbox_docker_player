interface Props {
  expanded: boolean;
  onToggle: () => void;
  /** Named in the tooltip and for screen readers, e.g. "map". */
  label: string;
}

/**
 * Expand/collapse control for a panel.
 *
 * Expanding is done with a CSS class on the existing element rather than by
 * moving it in the tree: re-parenting a <video> reloads it and loses the
 * playhead, and re-mounting the map would throw away its tiles and view.
 */
export function ExpandButton({ expanded, onToggle, label }: Props) {
  return (
    <button
      className="expand-button"
      onClick={onToggle}
      aria-pressed={expanded}
      title={expanded ? `Shrink ${label}` : `Expand ${label} to full screen`}
      aria-label={expanded ? `Shrink ${label}` : `Expand ${label} to full screen`}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        {expanded ? (
          <path
            d="M6.5 1.5v5h-5M9.5 14.5v-5h5"
            fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
          />
        ) : (
          <path
            d="M1.5 6.5v-5h5M14.5 9.5v5h-5"
            fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
          />
        )}
      </svg>
    </button>
  );
}
