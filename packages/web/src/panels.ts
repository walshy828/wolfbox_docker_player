import { useCallback, useState } from 'react';

/** The two side panels that can be pinned open or left to appear on hover. */
export type PanelSide = 'trips' | 'map';

export type PinnedPanels = Readonly<Record<PanelSide, boolean>>;

/** Both pinned: the layout the app has always had, and the safer default. */
export const ALL_PINNED: PinnedPanels = { trips: true, map: true };

const STORAGE_KEY = 'wolfbox.pinnedPanels';

/**
 * Reads the stored pin state, ignoring anything that is not a boolean.
 *
 * Storage is shared with older and newer builds of the app, so a missing or
 * unrecognised side falls back to pinned rather than hiding a panel the user
 * never asked to hide.
 */
export function parsePinned(raw: string | null): PinnedPanels {
  if (!raw) return ALL_PINNED;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return ALL_PINNED;
    const record = parsed as Partial<Record<PanelSide, unknown>>;
    return {
      trips: typeof record.trips === 'boolean' ? record.trips : true,
      map: typeof record.map === 'boolean' ? record.map : true,
    };
  } catch {
    return ALL_PINNED;
  }
}

/** Whether each side panel is pinned open, remembered across sessions. */
export function usePinnedPanels(): [PinnedPanels, (side: PanelSide, pinned: boolean) => void] {
  const [pinned, setPinned] = useState<PinnedPanels>(() => {
    try {
      return parsePinned(localStorage.getItem(STORAGE_KEY));
    } catch {
      return ALL_PINNED; // Private windows and blocked storage must not break the app.
    }
  });

  const update = useCallback((side: PanelSide, next: boolean) => {
    setPinned((current) => {
      const merged = { ...current, [side]: next };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch { /* not essential */ }
      return merged;
    });
  }, []);

  return [pinned, update];
}
