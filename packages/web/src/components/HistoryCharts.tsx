import { useEffect, useRef, useState, type ReactNode } from 'react';
import { averageScore, driverSlot, type Bucket, type Period } from '../history.ts';

/** A driver as the charts need them: key, name and colour slot. */
export interface Series { key: string; name: string; slot: ReturnType<typeof driverSlot> }

export const seriesColor = (slot: Series['slot']) =>
  slot === 'none' ? 'var(--series-none)' : slot === 'other' ? 'var(--series-other)' : `var(--series-${slot})`;

const PERIOD_FORMAT: Record<Bucket, Intl.DateTimeFormatOptions> = {
  day: { month: 'short', day: 'numeric', timeZone: 'UTC' },
  week: { month: 'short', day: 'numeric', timeZone: 'UTC' },
  month: { month: 'short', year: '2-digit', timeZone: 'UTC' },
};
export const periodLabel = (startMs: number, bucket: Bucket) =>
  (bucket === 'week' ? 'Week of ' : '') + new Intl.DateTimeFormat([], PERIOD_FORMAT[bucket]).format(startMs);
const axisLabel = (startMs: number, bucket: Bucket) =>
  new Intl.DateTimeFormat([], PERIOD_FORMAT[bucket]).format(startMs);

/** Width of an element, tracked, so charts draw in real pixels and text never stretches. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A "nice" axis maximum and step for a value range starting at zero. */
function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  return { top: Math.ceil(max / step) * step, step };
}

const H = 190;
const PAD = { top: 10, right: 8, bottom: 24, left: 34 };

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="chart-legend">
      {series.map((s) => (
        <li key={s.key}><span className="chart-swatch" style={{ background: seriesColor(s.slot) }} />{s.name}</li>
      ))}
    </ul>
  );
}

function ChartFrame({
  title, subtitle, series, table, children,
}: { title: string; subtitle?: string; series: Series[]; table: ReactNode; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="chart-card glass">
      <header className="chart-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <span className="muted">{subtitle}</span>}
        </div>
        <button className="link" onClick={() => setAsTable(!asTable)}>{asTable ? 'Show chart' : 'Show table'}</button>
      </header>
      <Legend series={series} />
      {asTable ? <div className="chart-table-wrap">{table}</div> : children}
    </section>
  );
}

/** Which period the pointer is over, from its x position. */
function useHover(count: number, plotLeft: number, plotWidth: number) {
  const [index, setIndex] = useState<number | null>(null);
  const onMove = (event: React.PointerEvent<SVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - plotLeft;
    const i = Math.floor((x / plotWidth) * count);
    setIndex(i >= 0 && i < count ? i : null);
  };
  return { index, onMove, onLeave: () => setIndex(null) };
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 70), width - 70);
  return <div className="chart-tip" style={{ left }}>{children}</div>;
}

/** Miles driven per period, stacked by driver. */
export function MilesChart({ periods, series, bucket }: { periods: Period[]; series: Series[]; bucket: Bucket }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const { top, step } = niceScale(Math.max(0, ...periods.map((p) => p.total.miles)));
  const slotW = periods.length ? plotW / periods.length : 0;
  const barW = Math.max(2, Math.min(28, slotW * 0.7));
  const y = (miles: number) => PAD.top + plotH - (miles / top) * plotH;
  const hover = useHover(periods.length, PAD.left, plotW);
  const labelEvery = Math.max(1, Math.ceil(periods.length / Math.max(1, Math.floor(plotW / 64))));
  const hovered = hover.index !== null ? periods[hover.index] : undefined;

  const table = (
    <table className="data-table">
      <thead><tr><th scope="col">Period</th>{series.map((s) => <th key={s.key} scope="col">{s.name}</th>)}<th scope="col">Total</th></tr></thead>
      <tbody>
        {periods.filter((p) => p.total.drives > 0).map((p) => (
          <tr key={p.startMs}>
            <th scope="row">{periodLabel(p.startMs, bucket)}</th>
            {series.map((s) => <td key={s.key}>{(p.byDriver.get(s.key)?.miles ?? 0).toFixed(1)}</td>)}
            <td>{p.total.miles.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartFrame title={`Miles per ${bucket}`} series={series} table={table}>
      <div className="chart" ref={ref}>
        {width > 0 && (
          <svg width={width} height={H} onPointerMove={hover.onMove} onPointerLeave={hover.onLeave} role="img"
            aria-label={`Miles per ${bucket}, ${periods.length} periods`}>
            {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((tick) => (
              <g key={tick}>
                <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="chart-axis" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">{tick}</text>
              </g>
            ))}
            {hovered && <rect className="chart-hover-band" x={PAD.left + hover.index! * slotW} y={PAD.top} width={slotW} height={plotH} />}
            {periods.map((period, i) => {
              const x = PAD.left + i * slotW + (slotW - barW) / 2;
              let base = 0;
              const segments = series.map((s) => {
                const miles = period.byDriver.get(s.key)?.miles ?? 0;
                if (miles <= 0) return null;
                const y0 = y(base);
                base += miles;
                const y1 = y(base);
                const isTop = series.slice(series.indexOf(s) + 1).every((o) => !(period.byDriver.get(o.key)?.miles));
                // 2px surface gap between stacked segments; only the top end is rounded.
                const h = Math.max(1, y0 - y1 - (base > miles ? 2 : 0));
                return isTop
                  ? <path key={s.key} d={roundedTop(x, y1, barW, h, Math.min(4, barW / 2, h))} fill={seriesColor(s.slot)} />
                  : <rect key={s.key} x={x} y={y1} width={barW} height={h} fill={seriesColor(s.slot)} />;
              });
              return <g key={period.startMs}>{segments}</g>;
            })}
            {periods.map((period, i) => (i % labelEvery === 0 ? (
              <text key={period.startMs} className="chart-axis" x={PAD.left + i * slotW + slotW / 2} y={H - 6} textAnchor="middle">
                {axisLabel(period.startMs, bucket)}
              </text>
            ) : null))}
          </svg>
        )}
        {hovered && (
          <Tooltip x={PAD.left + hover.index! * slotW + slotW / 2} width={width}>
            <strong>{periodLabel(hovered.startMs, bucket)}</strong>
            {series.filter((s) => hovered.byDriver.get(s.key)).map((s) => (
              <span key={s.key} className="chart-tip-row">
                <span className="chart-swatch" style={{ background: seriesColor(s.slot) }} />{s.name}
                <b>{hovered.byDriver.get(s.key)!.miles.toFixed(1)} mi</b>
              </span>
            ))}
            <span className="chart-tip-row chart-tip-total">
              {hovered.total.drives} drive{hovered.total.drives === 1 ? '' : 's'}<b>{hovered.total.miles.toFixed(1)} mi</b>
            </span>
          </Tooltip>
        )}
      </div>
    </ChartFrame>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Average score per period, a line per driver. Periods without drives are
 * gaps, not zeros: no driving is not a bad score. Dashed guides mark the
 * band edges, 85 and 65.
 */
export function ScoreChart({ periods, series, bucket }: { periods: Period[]; series: Series[]; bucket: Bucket }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const slotW = periods.length ? plotW / periods.length : 0;
  const lo = 0;
  const y = (score: number) => PAD.top + plotH - ((score - lo) / (100 - lo)) * plotH;
  const cx = (i: number) => PAD.left + i * slotW + slotW / 2;
  const hover = useHover(periods.length, PAD.left, plotW);
  const labelEvery = Math.max(1, Math.ceil(periods.length / Math.max(1, Math.floor(plotW / 64))));
  const hovered = hover.index !== null ? periods[hover.index] : undefined;

  const table = (
    <table className="data-table">
      <thead><tr><th scope="col">Period</th>{series.map((s) => <th key={s.key} scope="col">{s.name}</th>)}</tr></thead>
      <tbody>
        {periods.filter((p) => p.total.scored > 0).map((p) => (
          <tr key={p.startMs}>
            <th scope="row">{periodLabel(p.startMs, bucket)}</th>
            {series.map((s) => {
              const totals = p.byDriver.get(s.key);
              return <td key={s.key}>{totals ? averageScore(totals) ?? '—' : '—'}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartFrame title="Average score" subtitle="Higher is safer" series={series} table={table}>
      <div className="chart" ref={ref}>
        {width > 0 && (
          <svg width={width} height={H} onPointerMove={hover.onMove} onPointerLeave={hover.onLeave} role="img"
            aria-label={`Average score per ${bucket}`}>
            {[0, 25, 50, 75, 100].map((tick) => (
              <g key={tick}>
                <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="chart-axis" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">{tick}</text>
              </g>
            ))}
            {[85, 65].map((edge) => (
              <g key={edge}>
                <line className="chart-guide" x1={PAD.left} x2={width - PAD.right} y1={y(edge)} y2={y(edge)} />
                <text className="chart-axis chart-guide-label" x={width - PAD.right - 2} y={y(edge) - 4} textAnchor="end">
                  {edge === 85 ? 'low risk ≥ 85' : 'high risk < 65'}
                </text>
              </g>
            ))}
            {hovered && <line className="chart-crosshair" x1={cx(hover.index!)} x2={cx(hover.index!)} y1={PAD.top} y2={PAD.top + plotH} />}
            {series.map((s) => {
              const values = periods.map((p) => {
                const totals = p.byDriver.get(s.key);
                return totals ? averageScore(totals) : null;
              });
              let d = '';
              let pen = false;
              values.forEach((v, i) => {
                if (v === null) { pen = false; return; }
                d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`;
                pen = true;
              });
              return (
                <g key={s.key}>
                  <path d={d} fill="none" stroke={seriesColor(s.slot)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {values.map((v, i) => (v === null ? null : (
                    <circle key={i} className="chart-dot" cx={cx(i)} cy={y(v)} r={hover.index === i ? 5 : 4} fill={seriesColor(s.slot)} />
                  )))}
                </g>
              );
            })}
            {periods.map((period, i) => (i % labelEvery === 0 ? (
              <text key={period.startMs} className="chart-axis" x={cx(i)} y={H - 6} textAnchor="middle">
                {axisLabel(period.startMs, bucket)}
              </text>
            ) : null))}
          </svg>
        )}
        {hovered && hovered.total.scored > 0 && (
          <Tooltip x={cx(hover.index!)} width={width}>
            <strong>{periodLabel(hovered.startMs, bucket)}</strong>
            {series.filter((s) => hovered.byDriver.get(s.key)?.scored).map((s) => (
              <span key={s.key} className="chart-tip-row">
                <span className="chart-swatch" style={{ background: seriesColor(s.slot) }} />{s.name}
                <b>{averageScore(hovered.byDriver.get(s.key)!)}</b>
              </span>
            ))}
          </Tooltip>
        )}
      </div>
    </ChartFrame>
  );
}
