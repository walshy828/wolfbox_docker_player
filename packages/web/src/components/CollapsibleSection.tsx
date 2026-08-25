import { useState, type ReactNode } from 'react';

interface Props {
  title: string;
  /** Sits beside the title, e.g. the number of clips. */
  count?: ReactNode;
  defaultOpen?: boolean;
  /**
   * Fires with the new open state. Present so a panel whose content is
   * expensive -- a network lookup, say -- can hold off until it is actually
   * being looked at.
   */
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}

/**
 * A panel whose body folds away behind a disclosure triangle.
 *
 * Built on <details> rather than a class toggle so the keyboard, screen reader
 * and in-page find behaviour come from the platform: collapsed content is
 * genuinely hidden, and the browser expands it when a search lands inside.
 * The panels below the player are stacked in a scroller, so folding one is
 * what lets the other be read without scrolling past it.
 */
export function CollapsibleSection(
  { title, count, defaultOpen = true, onToggle, children }: Props,
) {
  // Held in state rather than pinned to the prop: <details> is toggled by the
  // browser, so a fixed `open` leaves React's idea of the element and the
  // user's disagreeing the moment anything else re-renders the panel.
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className="fold" open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        onToggle?.(next);
      }}
    >
      <summary>
        {/* Rotated by CSS on open, so the arrow points down at the content. */}
        <svg className="fold-arrow" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M3.5 1.5 L8.5 6 L3.5 10.5 Z" fill="currentColor" />
        </svg>
        <span className="fold-title">{title}</span>
        {count !== undefined && <span className="count">{count}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
