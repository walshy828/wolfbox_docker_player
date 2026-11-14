import type { TripStatsEntry } from '../tripStats.ts';

/** Circumference of the list's score ring, at r=15. */
const RING = 2 * Math.PI * 15;

export const BAND_LABEL = { low: 'Low risk', moderate: 'Some risk', high: 'High risk' } as const;

/**
 * The drive's risk score as a small ring, coloured by band. A dashed ring is a
 * score made before speed limits were known, so a provisional 95 cannot be
 * mistaken for a final one.
 */
export function RiskRing({ entry, size = 36 }: { entry?: TripStatsEntry; size?: number }) {
  const box = { width: size, height: size };
  if (!entry || entry.status === 'pending') return <span className="risk-ring risk-ring--pending" style={box} aria-hidden="true" />;
  if (entry.status !== 'ready' || !entry.risk) return <span className="risk-ring risk-ring--none" style={box} aria-hidden="true" />;
  const { score, band, includesSpeeding } = entry.risk;
  const provisional = !includesSpeeding && entry.limits === 'pending';
  return (
    <svg
      className={`risk-ring risk-ring--${band}${provisional ? ' risk-ring--provisional' : ''}`}
      viewBox="0 0 36 36" width={size} height={size} role="img"
      aria-label={`Score ${score} of 100, ${BAND_LABEL[band]}${provisional ? ', speed limits still loading' : ''}`}
    >
      <circle className="risk-ring-track" cx="18" cy="18" r="15" />
      <circle
        className="risk-ring-value" cx="18" cy="18" r="15"
        strokeDasharray={RING} strokeDashoffset={RING * (1 - score / 100)}
        transform="rotate(-90 18 18)"
      />
      <text x="18" y="22.5" textAnchor="middle">{score}</text>
    </svg>
  );
}

/** The factors that cost the most, as chips, so the list says why as well as how much. */
export function RiskReasons({ entry, max = 2 }: { entry?: TripStatsEntry; max?: number }) {
  if (!entry || entry.status !== 'ready' || !entry.risk) return null;
  const { factors } = entry.risk;
  if (factors.length === 0) {
    return entry.risk.includesSpeeding
      ? <span className="reasons"><span className="reason reason--clean">Clean drive</span></span>
      : null;
  }
  const shown = factors.slice(0, max);
  return (
    <span className="reasons">
      {shown.map((factor) => (
        <span key={factor.key} className={`reason reason--${factor.severity}`} title={factor.detail}>
          {factor.label}
        </span>
      ))}
      {factors.length > shown.length && (
        <span className="reason reason--more" title={factors.slice(max).map((f) => f.label).join(', ')}>
          +{factors.length - shown.length}
        </span>
      )}
    </span>
  );
}

