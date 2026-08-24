import {
  rampGradient, colorForBand, SPEED_BANDS, STOPPED_BAND, TOP_SPEED_MPH, type Theme,
} from '../speedScale.ts';

/**
 * The colour key for the route line.
 *
 * The route blends continuously, so the key is a gradient rather than a row of
 * swatches, with the band boundaries ticked along it. It is always rendered,
 * never optional: the ramp's adjacent steps are close together by design, and
 * the written bands are the secondary encoding that keeps it readable.
 */
export function SpeedLegend({ theme }: { theme: Theme }) {
  const ticks = SPEED_BANDS.slice(0, -1).map((band) => band.maxMph);

  return (
    <div className="legend">
      <h3>Speed <span className="legend-unit">mph</span></h3>

      <div className="legend-ramp">
        <div className="legend-bar" style={{ background: rampGradient(theme) }} />
        <div className="legend-ticks">
          {ticks.map((mph) => (
            <span key={mph} className="legend-tick" style={{ left: `${(mph / TOP_SPEED_MPH) * 100}%` }}>
              {mph}
            </span>
          ))}
        </div>
      </div>

      <ul className="legend-bands">
        <li>
          <span className="legend-swatch" style={{ background: colorForBand(STOPPED_BAND, theme) }} />
          <span className="legend-label">{STOPPED_BAND.label}</span>
          <span className="legend-note">{STOPPED_BAND.note}</span>
        </li>
        {SPEED_BANDS.map((band) => (
          <li key={band.label}>
            <span className="legend-swatch" style={{ background: colorForBand(band, theme) }} />
            <span className="legend-label">{band.label}</span>
            <span className="legend-note">{band.note}</span>
          </li>
        ))}
      </ul>
      <p className="legend-foot">Colour stops deepening at {TOP_SPEED_MPH} mph.</p>
    </div>
  );
}
