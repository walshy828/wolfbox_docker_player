import { SPEED_BINS, STOPPED_BIN, type Theme } from '../speedScale.ts';

/**
 * The colour key for the route line.
 *
 * Always rendered, never optional: the ramp's adjacent steps sit in the deltaE
 * 6-8 band under deuteranopia, which the palette guidance permits only when a
 * secondary encoding carries the same information. The written bands are that
 * encoding, so hiding the legend would make the map unreadable for some people.
 */
export function SpeedLegend({ theme }: { theme: Theme }) {
  const swatch = (color: string) => ({ backgroundColor: color });
  return (
    <div className="legend">
      <h3>Speed</h3>
      <ul>
        {[STOPPED_BIN, ...SPEED_BINS].map((bin) => (
          <li key={bin.label}>
            <span className="legend-swatch" style={swatch(theme === 'dark' ? bin.dark : bin.light)} />
            <span className="legend-label">{bin.label}</span>
            <span className="legend-unit">{bin.label === 'Stopped' ? '' : 'mph'}</span>
            <span className="legend-note">{bin.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
