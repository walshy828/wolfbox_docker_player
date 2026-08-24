import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { kphToMph, type CleanPoint } from '@wolfbox/telemetry';
import { colorForMph, type Theme } from '../speedScale.ts';

interface Props {
  points: CleanPoint[];
  /** Playback position; the marker follows it. */
  cursorMs: number | null;
  theme: Theme;
  onSeek: (timestampMs: number) => void;
}

/** A pause longer than this is a recording gap, not a straight line to draw. */
const GAP_MS = 10_000;

const usable = (p: CleanPoint) =>
  Number.isFinite(p.latitude) && Number.isFinite(p.longitude) &&
  Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;

/**
 * Draws the route with each one-second segment coloured by the speed driven
 * over it, and a marker tracking playback.
 *
 * The map instance lives in state rather than a ref. Effects that draw into it
 * must re-run when it is replaced -- React's StrictMode mounts, unmounts and
 * remounts, so a ref would leave the drawing effects pointing at a layer group
 * belonging to a map that had already been removed, which renders tiles and
 * controls but no route.
 */
export function RouteMap({ points, cursorMs, theme, onSeek }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const [route, setRoute] = useState<L.LayerGroup | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, { preferCanvas: true, zoomControl: true });
    // A view must exist before tiles or layers are added.
    instance.setView([42.36, -71.06], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(instance);
    const layer = L.layerGroup().addTo(instance);

    // Leaflet caches the container size at construction. In a grid/flex layout
    // the pane is often still unsized then, which leaves the map convinced it
    // is tiny and puts fitBounds at the wrong zoom.
    const resize = new ResizeObserver(() => instance.invalidateSize());
    resize.observe(container.current);

    setMap(instance);
    setRoute(layer);
    return () => {
      resize.disconnect();
      instance.remove();
      setMap(null);
      setRoute(null);
      marker.current = null;
      fitted.current = null;
    };
  }, []);

  // Redraw the route whenever the trip, theme or map instance changes.
  useEffect(() => {
    if (!map || !route) return;
    route.clearLayers();
    marker.current = null;

    const track = points.filter(usable);
    if (track.length === 0) { fitted.current = null; return; }

    for (let i = 1; i < track.length; i++) {
      const from = track[i - 1]!;
      const to = track[i]!;
      if (to.timestampMs - from.timestampMs > GAP_MS) continue;
      L.polyline(
        [[from.latitude, from.longitude], [to.latitude, to.longitude]],
        {
          color: colorForMph(kphToMph(from.smoothedSpeedKph), theme),
          weight: 5,
          opacity: 0.95,
          lineCap: 'round',
        },
      ).addTo(route);
    }

    const start = track[0]!;
    const end = track.at(-1)!;
    L.circleMarker([start.latitude, start.longitude], {
      radius: 6, color: '#ffffff', weight: 2, fillColor: '#111111', fillOpacity: 1,
    }).bindTooltip('Start').addTo(route);
    L.circleMarker([end.latitude, end.longitude], {
      radius: 6, color: '#111111', weight: 2, fillColor: '#ffffff', fillOpacity: 1,
    }).bindTooltip('End').addTo(route);

    // Refit only when the trip itself changes, so the view survives a theme
    // change or a redraw and does not fight the user's panning.
    const key = `${start.timestampMs}:${track.length}`;
    if (fitted.current !== key) {
      map.invalidateSize();
      map.fitBounds(L.latLngBounds(track.map((p) => [p.latitude, p.longitude])), {
        padding: [24, 24],
      });
      fitted.current = key;
    }
  }, [map, route, points, theme]);

  // Move the playback marker.
  useEffect(() => {
    if (!map) return;
    const current = cursorMs === null ? undefined : nearest(points, cursorMs);
    if (!current) { marker.current?.remove(); marker.current = null; return; }

    const position: L.LatLngExpression = [current.latitude, current.longitude];
    const color = colorForMph(kphToMph(current.smoothedSpeedKph), theme);
    if (marker.current) {
      marker.current.setLatLng(position).setStyle({ fillColor: color });
    } else {
      marker.current = L.circleMarker(position, {
        radius: 9, weight: 3, color: '#ffffff', fillColor: color, fillOpacity: 1,
      }).addTo(map);
    }
  }, [map, cursorMs, points, theme]);

  // Click the route to jump to that moment.
  useEffect(() => {
    if (!map) return;
    const handler = (event: L.LeafletMouseEvent) => {
      const closest = nearestByPosition(points, event.latlng.lat, event.latlng.lng);
      if (closest) onSeek(closest.timestampMs);
    };
    map.on('click', handler);
    return () => { map.off('click', handler); };
  }, [map, points, onSeek]);

  return <div ref={container} className="route-map" role="application" aria-label="Route map" />;
}

function nearest(points: CleanPoint[], timestampMs: number): CleanPoint | undefined {
  let best: CleanPoint | undefined;
  let bestDelta = Infinity;
  for (const point of points) {
    if (!usable(point)) continue;
    const delta = Math.abs(point.timestampMs - timestampMs);
    if (delta < bestDelta) { bestDelta = delta; best = point; }
  }
  return bestDelta <= 5000 ? best : undefined;
}

function nearestByPosition(points: CleanPoint[], lat: number, lon: number): CleanPoint | undefined {
  let best: CleanPoint | undefined;
  let bestDistance = Infinity;
  for (const point of points) {
    if (!usable(point)) continue;
    const distance = (point.latitude - lat) ** 2 + (point.longitude - lon) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = point; }
  }
  return best;
}
