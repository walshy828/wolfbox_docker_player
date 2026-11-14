import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { kphToMph } from '@wolfbox/telemetry';
import type { ArchivedEvent, ArchivedTrip } from '../archive.ts';
import { driverKey } from '../history.ts';
import type { Theme } from '../speedScale.ts';
import { seriesColor, type Series } from './HistoryCharts.tsx';

export type MapLayer = 'routes' | 'speeding' | 'hard';

const LAYER_LABEL: Record<MapLayer, string> = { routes: 'Routes', speeding: 'Speeding', hard: 'Hard events' };
const EVENT_NAME: Record<ArchivedEvent['kind'], string> = {
  speeding: 'Over the limit', braking: 'Hard stop', acceleration: 'Hard launch', cornering: 'Sharp turn',
};

/** Resolves a CSS colour token to a value Leaflet can paint with. */
function cssColor(value: string): string {
  const match = /^var\((--[\w-]+)\)$/.exec(value);
  return match ? getComputedStyle(document.documentElement).getPropertyValue(match[1]!).trim() : value;
}

/**
 * Everywhere the archive has been, on one map.
 *
 * Routes are drawn from each drive's thumbnail track (a few dozen points),
 * which is plenty at this scale and keeps a year of driving to a few
 * thousand vertices. Colour is the driver, matching the charts. The two
 * hotspot layers put a dot where each speeding stretch began, or each hard
 * stop, launch and sharp turn peaked: a cluster is a place, not a drive, and
 * it is the pattern a parent is looking for.
 */
export function HistoryMap({
  trips, events, series, theme, onOpen,
}: {
  trips: ArchivedTrip[];
  events: ArchivedEvent[];
  series: Series[];
  theme: Theme;
  onOpen: (tripId: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  /** The map currently alive. A torn-down map can still be in state for one commit; drawing on it throws. */
  const live = useRef<L.Map | null>(null);
  const [layer, setLayer] = useState<MapLayer>('routes');

  useEffect(() => {
    if (!container.current) return;
    // A route is a few pixels wide; widen what counts as clicking it, so a
    // drive can be opened without pixel-hunting.
    const instance = L.map(container.current, { renderer: L.canvas({ tolerance: 8 }), zoomControl: true });
    instance.setView([42.3, -71.5], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(instance);
    const resize = new ResizeObserver(() => instance.invalidateSize());
    resize.observe(container.current);
    live.current = instance;
    setMap(instance);
    return () => {
      resize.disconnect();
      if (live.current === instance) live.current = null;
      instance.remove();
      setMap(null);
    };
  }, []);

  const shownEvents = events.filter((event) =>
    layer === 'speeding' ? event.kind === 'speeding' : layer === 'hard' ? event.kind !== 'speeding' : false);

  useEffect(() => {
    if (!map || live.current !== map) return;
    const group = L.layerGroup().addTo(map);
    const colorFor = new Map(series.map((s) => [s.key, cssColor(seriesColor(s.slot))]));
    const bounds = L.latLngBounds([]);

    for (const trip of trips) {
      if (trip.route.length < 2) continue;
      const line = trip.route.map(([lat, lon]) => [lat, lon] as [number, number]);
      line.forEach((p) => bounds.extend(p));
      L.polyline(line, {
        color: colorFor.get(driverKey(trip)) ?? cssColor('var(--series-none)'),
        weight: layer === 'routes' ? 3 : 2,
        opacity: layer === 'routes' ? 0.55 : 0.18,
      })
        .bindTooltip(`${trip.driverName ?? 'Not assigned'} · ${(trip.distanceMeters / 1609.344).toFixed(1)} mi${trip.risk ? ` · score ${trip.risk.score}` : ''}`, { sticky: true })
        .on('click', () => onOpen(trip.id))
        .addTo(group);
    }

    const warn = cssColor('var(--warn)');
    const danger = cssColor('var(--danger)');
    const minor = cssColor('var(--ink-muted)');
    for (const event of shownEvents) {
      const color = event.severity === 'severe' ? danger : event.severity === 'moderate' ? warn : minor;
      const value = event.value === null ? ''
        : event.kind === 'speeding' ? ` · +${Math.round(kphToMph(event.value))} mph`
        : ` · ${Math.abs(event.value).toFixed(2)} g`;
      const road = typeof event.detail?.['roadName'] === 'string' ? ` on ${event.detail['roadName']}` : '';
      L.circleMarker([event.lat, event.lon], {
        radius: event.severity === 'severe' ? 8 : 6,
        color: cssColor('var(--surface)'), weight: 2,
        fillColor: color, fillOpacity: 0.85,
      })
        .bindTooltip(`${EVENT_NAME[event.kind]} · ${event.severity}${value}${road}`)
        .on('click', () => onOpen(event.tripId))
        .addTo(group);
      bounds.extend([event.lat, event.lon]);
    }

    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
    return () => { group.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, trips, events, series, layer, theme]);

  const speedingCount = events.filter((e) => e.kind === 'speeding').length;
  return (
    <section className="history-map-card glass">
      <header className="chart-card-head">
        <div>
          <h3>Where</h3>
          <span className="muted">
            {layer === 'routes'
              ? `${trips.length} drive${trips.length === 1 ? '' : 's'} · click a route to review it`
              : `${shownEvents.length} ${layer === 'speeding' ? 'speeding stretches' : 'hard events'} · red is severe`}
          </span>
        </div>
        <div className="segmented" role="group" aria-label="Map layer">
          {(Object.keys(LAYER_LABEL) as MapLayer[]).map((value) => (
            <button key={value} className={layer === value ? 'selected' : ''} aria-pressed={layer === value} onClick={() => setLayer(value)}>
              {LAYER_LABEL[value]}
              {value === 'speeding' && <span className="count">{speedingCount}</span>}
              {value === 'hard' && <span className="count">{events.length - speedingCount}</span>}
            </button>
          ))}
        </div>
      </header>
      <div ref={container} className="route-map history-map" />
    </section>
  );
}
