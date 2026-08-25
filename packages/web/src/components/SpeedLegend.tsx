import {
  rampGradient, colorForBand, SPEED_BANDS, STOPPED_BAND, TOP_SPEED_MPH,
  excessRampGradient, colorForExcessBand, unknownLimitColor,
  EXCESS_BANDS, TOP_EXCESS_MPH, type Theme,
} from '../speedScale.ts';

export type MapMode = 'speed' | 'excess';

/**
 * The colour ramp for the route line, plus the toggle between the two
 * things it can encode.
 *
 * Always rendered, right under the map, never folded away: the ramp is what
 * makes the route line legible in the first place, and the mode toggle is
 * the only way to switch what it's showing.
 */
export function SpeedRamp(
  { theme, mode = 'speed' }: {
    theme: Theme;
    mode?: MapMode;
  },
) {
  const comparing = mode === 'excess';
  const top = comparing ? TOP_EXCESS_MPH : TOP_SPEED_MPH;
  const bands = comparing ? EXCESS_BANDS : SPEED_BANDS;
  const ticks = bands.slice(0, -1).map((band) => band.maxMph);

  return (
    <div className="legend-ramp">
      <div
        className="legend-bar"
        style={{ background: comparing ? excessRampGradient(theme) : rampGradient(theme) }}
      />
      <div className="legend-ticks">
        {ticks.map((mph) => (
          <span key={mph} className="legend-tick" style={{ left: `${(mph / top) * 100}%` }}>
            {comparing ? `+${mph}` : mph}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The written key behind the ramp: what each band along it means.
 *
 * Split out from `SpeedRamp` so it can be folded away independently -- the
 * ramp's adjacent steps are close together by design, and this is the
 * secondary encoding that keeps it readable, not something needed at a
 * glance every time.
 */
export function SpeedBands(
  { theme, mode = 'speed' }: {
    theme: Theme;
    mode?: MapMode;
  },
) {
  const comparing = mode === 'excess';
  const bands = comparing ? EXCESS_BANDS : SPEED_BANDS;
  const swatch = (band: typeof bands[number]) =>
    comparing ? colorForExcessBand(band, theme) : colorForBand(band, theme);

  return (
    <>
      <ul className="legend-bands">
        <li>
          <span
            className={comparing ? 'legend-swatch legend-swatch--unknown' : 'legend-swatch'}
            style={{
              background: comparing
                ? unknownLimitColor(theme) : colorForBand(STOPPED_BAND, theme),
            }}
          />
          <span className="legend-label">{comparing ? 'No limit' : STOPPED_BAND.label}</span>
          <span className="legend-note">
            {comparing ? 'none known here' : STOPPED_BAND.note}
          </span>
        </li>
        {bands.map((band) => (
          <li key={band.label}>
            <span className="legend-swatch" style={{ background: swatch(band) }} />
            <span className="legend-label">{band.label}</span>
            <span className="legend-note">{band.note}</span>
          </li>
        ))}
      </ul>
      <p className="legend-foot">
        {comparing
          ? `Colour stops deepening at +${TOP_EXCESS_MPH} mph. Limits from OpenStreetMap.`
          : `Colour stops deepening at ${TOP_SPEED_MPH} mph.`}
      </p>
    </>
  );
}
