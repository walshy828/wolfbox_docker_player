import type { ReactNode } from 'react';

interface Props {
  side: 'left' | 'right';
  pinned: boolean;
  onPin: () => void;
  /** Named on the rail and in its tooltip, e.g. "Trips". */
  label: string;
  children: ReactNode;
}

/**
 * The column a side panel sits in, pinned open or collapsed to a hover rail.
 *
 * Collapsing is done with positioning rather than by unmounting the panel: the
 * trip list would lose its scroll position and the map would throw away its
 * tiles and view, and both would have to be rebuilt every time the pointer
 * left the edge of the window.
 *
 * The reveal is plain CSS `:hover` on this element. The panel stays a child of
 * the rail's container even when it floats over the workspace, so the pointer
 * moving from the rail onto the panel never leaves the hover target -- a
 * JavaScript version of this needs a timer to paper over that gap.
 */
export function PanelDock({ side, pinned, onPin, label, children }: Props) {
  return (
    <div className={`dock dock--${side} ${pinned ? 'dock--pinned' : 'dock--auto'}`}>
      {!pinned && (
        <button
          className="dock-rail"
          onClick={onPin}
          title={`${label}: hover to show, or click to pin open`}
        >
          <span className="dock-rail-label">{label}</span>
        </button>
      )}
      {children}
    </div>
  );
}
