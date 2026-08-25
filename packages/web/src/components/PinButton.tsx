interface Props {
  pinned: boolean;
  onToggle: () => void;
  /** Named in the tooltip and for screen readers, e.g. "map". */
  label: string;
}

/**
 * Pins a side panel open, or lets it collapse to a hover rail.
 *
 * Unpinning does not unmount anything -- the panel keeps its scroll position,
 * and the map keeps its tiles and view -- it only stops the panel taking a
 * column of its own.
 */
export function PinButton({ pinned, onToggle, label }: Props) {
  const title = pinned
    ? `Unpin the ${label} panel so it shows on hover`
    : `Pin the ${label} panel open`;
  return (
    <button
      className={pinned ? 'icon-toggle selected' : 'icon-toggle'}
      onClick={onToggle}
      aria-pressed={pinned}
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        {/* An upright pin when pinned, tipped over on its side when not. */}
        <g
          fill="none" stroke="currentColor" strokeWidth="1.6"
          strokeLinecap="round" strokeLinejoin="round"
          transform={pinned ? undefined : 'rotate(45 8 8)'}
        >
          <path d="M6 2h4M8 2v5M4.5 11h7l-1.5-4h-4z" />
          <path d="M8 11v3" />
        </g>
      </svg>
    </button>
  );
}
