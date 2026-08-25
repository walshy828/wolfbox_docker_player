import { mphToKph, type LatLon } from './geo.ts';

/**
 * Turns OpenStreetMap's `maxspeed` tagging into a number to compare against.
 *
 * The tag is free text written by volunteers, so the value space is much wider
 * than "a number": units are optional and default to km/h, some countries are
 * referenced by code rather than by figure, and several legitimate values are
 * not a number at all. Anything that cannot be resolved to a definite limit
 * returns null rather than a guess -- an invented limit produces a confident
 * accusation, which is worse than admitting the road is unknown.
 */

/** Where a limit came from, which decides how much weight the UI gives it. */
export type LimitSource =
  /** Signed and tagged on the way itself. */
  | 'tagged'
  /** A country's default for that kind of road, named by the way's own tags. */
  | 'implicit'
  /** Guessed from the road's class because nothing was tagged. */
  | 'inferred';

export type RegionCode = 'US' | 'GB' | 'EU' | 'DEFAULT';

export interface SpeedLimit {
  /** The limit in km/h. Infinity on a road with no limit at all. */
  kph: number;
  source: LimitSource;
  /** Plain-language account of where the number came from, shown when inferred. */
  reason: string;
}

/**
 * Implicit limits named by country code, e.g. `maxspeed=DE:urban`.
 *
 * Only the codes likely to be met are listed; an unlisted code resolves to null
 * rather than borrowing a neighbour's law.
 */
const IMPLICIT: Record<string, number | undefined> = {
  'GB:motorway': mphToKph(70), 'GB:national': mphToKph(60), 'GB:nsl_single': mphToKph(60),
  'GB:nsl_dual': mphToKph(70), 'GB:urban': mphToKph(30),
  'US:urban': mphToKph(25), 'US:rural': mphToKph(55),
  'DE:motorway': Infinity, 'DE:rural': 100, 'DE:urban': 50, 'DE:living_street': 7,
  'FR:motorway': 130, 'FR:rural': 80, 'FR:urban': 50,
  'NL:motorway': 100, 'NL:rural': 80, 'NL:urban': 50,
  'IE:motorway': 120, 'IE:rural': 80, 'IE:urban': 50,
  'AT:motorway': 130, 'AT:rural': 100, 'AT:urban': 50,
  'ES:motorway': 120, 'ES:rural': 90, 'ES:urban': 50,
  'IT:motorway': 130, 'IT:rural': 90, 'IT:urban': 50,
};

/**
 * What each class of road is worth when nothing at all is tagged.
 *
 * These are legal defaults, not observations of the road in front of the car:
 * a residential street signed at 20 is still 25 in this table. Everything
 * resolved through here is marked `inferred` so the UI can keep it out of the
 * headline figure, which is the only thing that makes using it defensible.
 */
const INFERRED: Record<RegionCode, Record<string, number | undefined>> = {
  US: {
    motorway: mphToKph(70), trunk: mphToKph(55), primary: mphToKph(45),
    secondary: mphToKph(40), tertiary: mphToKph(35), unclassified: mphToKph(30),
    residential: mphToKph(25), living_street: mphToKph(10), service: mphToKph(15),
    road: mphToKph(30),
  },
  GB: {
    motorway: mphToKph(70), trunk: mphToKph(60), primary: mphToKph(60),
    secondary: mphToKph(60), tertiary: mphToKph(60), unclassified: mphToKph(30),
    residential: mphToKph(30), living_street: mphToKph(10), service: mphToKph(15),
    road: mphToKph(30),
  },
  EU: {
    motorway: 120, trunk: 100, primary: 90, secondary: 80, tertiary: 70,
    unclassified: 50, residential: 50, living_street: 7, service: 20, road: 50,
  },
  DEFAULT: {
    motorway: 110, trunk: 90, primary: 80, secondary: 70, tertiary: 60,
    unclassified: 50, residential: 50, living_street: 10, service: 20, road: 50,
  },
};

/** A `*_link` inherits its parent class, less a step for the ramp itself. */
const LINK_PENALTY_KPH = 20;

/**
 * Reads one `maxspeed` value.
 *
 * Returns null for `signals` and `variable`: a gantry sets the limit minute by
 * minute and nothing in the recording says what it read at the time.
 */
export function parseMaxspeed(value: string | undefined): SpeedLimit | null {
  if (!value) return null;
  // Multi-value tags list the strictest first by convention, so take the head.
  const raw = value.split(';')[0]!.trim();
  if (raw === '') return null;

  const lower = raw.toLowerCase();
  if (lower === 'none' || lower === 'unlimited') {
    return { kph: Infinity, source: 'tagged', reason: 'no limit on this road' };
  }
  if (lower === 'walk' || lower === 'walking') {
    return { kph: 7, source: 'implicit', reason: 'walking pace' };
  }
  if (lower === 'signals' || lower === 'variable') return null;

  const numeric = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/.exec(lower);
  if (numeric) {
    const figure = Number(numeric[1]);
    if (!Number.isFinite(figure) || figure <= 0) return null;
    // A bare number is km/h. That is the OSM convention, and reading it as mph
    // would inflate every metric-country limit by 60%.
    const kph = numeric[2] === 'mph' ? mphToKph(figure) : figure;
    return { kph, source: 'tagged', reason: 'signed limit' };
  }

  const implicit = IMPLICIT[raw.toUpperCase().replace(/\s+/g, '')]
    ?? IMPLICIT[raw.replace(/\s+/g, '')];
  if (implicit !== undefined) {
    return { kph: implicit, source: 'implicit', reason: `${raw} default` };
  }

  // `XX:zone30` and `XX:zone:30` both name their own figure.
  const zone = /^[a-z]{2}:zone:?(\d+)$/.exec(lower);
  if (zone) {
    return { kph: Number(zone[1]), source: 'implicit', reason: `${raw} zone` };
  }

  return null;
}

/**
 * The limit that applies to a way, in the direction being travelled.
 *
 * `maxspeed:advisory` is deliberately never consulted. An advisory plate on a
 * bend is a recommendation, not a limit, and treating one as enforceable would
 * post a violation on every slip road taken at a normal speed.
 */
export function limitForWay(
  tags: Record<string, string>,
  region: RegionCode,
  forward = true,
): SpeedLimit | null {
  const directional = forward ? tags['maxspeed:forward'] : tags['maxspeed:backward'];
  const resolved =
    parseMaxspeed(tags['maxspeed'])
    ?? parseMaxspeed(directional)
    ?? parseMaxspeed(tags['maxspeed:type'])
    ?? parseMaxspeed(tags['zone:maxspeed']);
  if (resolved) return resolved;

  const highway = tags['highway'];
  if (!highway) return null;

  const table = INFERRED[region];
  const direct = table[highway];
  if (direct !== undefined) {
    return {
      kph: direct,
      source: 'inferred',
      reason: `no limit tagged; assumed for a ${highway.replace(/_/g, ' ')} road`,
    };
  }

  const parent = highway.endsWith('_link') ? table[highway.slice(0, -5)] : undefined;
  if (parent !== undefined) {
    return {
      kph: Math.max(parent - LINK_PENALTY_KPH, 20),
      source: 'inferred',
      reason: `no limit tagged; assumed for a ${highway.replace(/_/g, ' ')}`,
    };
  }

  return null;
}

/**
 * Which country's defaults to fall back on.
 *
 * The ways already fetched for the route carry most of the answer, so this
 * costs no extra lookup: an explicit country code names the country outright.
 * Failing that, mph tagging narrows it to an imperial country but cannot say
 * which one -- Britain and the United States both sign in mph and disagree
 * about what a residential street is worth -- so the trip's own position
 * breaks the tie. Position is the right tiebreak rather than the browser's
 * locale, because the law that applied is the law where the car was.
 */
export function inferRegion(waysTags: Record<string, string>[], anchor?: LatLon): RegionCode {
  let mph = 0;
  let metric = 0;

  for (const tags of waysTags) {
    const code = tags['maxspeed:type'] ?? tags['zone:maxspeed'] ?? tags['maxspeed'];
    const prefix = code && /^([A-Za-z]{2}):/.exec(code)?.[1]?.toUpperCase();
    if (prefix === 'GB' || prefix === 'UK') return 'GB';
    if (prefix === 'US') return 'US';
    if (prefix) return 'EU';

    const value = tags['maxspeed'];
    if (!value) continue;
    if (/mph/i.test(value)) mph++;
    else if (/^\d/.test(value.trim())) metric++;
  }

  const byPosition = anchor && regionAt(anchor);
  if (mph > metric && mph > 0) return byPosition === 'GB' ? 'GB' : 'US';
  if (metric > 0) return byPosition === 'EU' ? 'EU' : (byPosition ?? 'EU');
  return byPosition ?? 'DEFAULT';
}

/**
 * A coarse box per region, used only to break ties the tagging leaves open.
 *
 * Deliberately crude: it has to separate the mph countries from each other and
 * put mainland Europe on the metric table, not draw borders.
 */
function regionAt({ latitude, longitude }: LatLon): RegionCode | undefined {
  const within = (s: number, n: number, w: number, e: number) =>
    latitude >= s && latitude <= n && longitude >= w && longitude <= e;

  if (within(49.8, 61.0, -8.7, 1.8)) return 'GB';
  if (within(24.5, 49.4, -125.0, -66.9)) return 'US';
  if (within(35.0, 71.2, -10.6, 31.6)) return 'EU';
  return undefined;
}
