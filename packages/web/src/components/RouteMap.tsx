import { useEffect, useRef } from 'react';
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

/**
 * Draws the route with each one-second segment coloured by the speed driven
 * over it, and a marker tracking playback.
 *
 * The line is drawn as many short polylines rather than one gradient stroke so
 * every segment keeps a flat, legible colour at any zoom, and so clicking near
 * the route can seek to the moment it was driven.
 */
export function RouteMap({ points, cursorMs, theme, onSeek }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, { preferCanvas: true, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(instance);
    routeLayer.current = L.layerGroup().addTo(instance);
    map.current = instance;
    return () => { instance.remove(); map.current = null; };
  }, []);

  // Redraw the route whenever the trip changes.
  useEffect(() => {
    const layer = routeLayer.current;
    const instance = map.current;
    if (!layer || !instance) return;
    layer.clearLayers();
    if (points.length === 0) return;

    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1]!;
      const to = points[i]!;
      // A recording gap should not be drawn as a straight line across the map.
      if (to.timestampMs - from.timestampMs > 10_000) continue;
      L.polyline(
        [[from.latitude, from.longitude], [to.latitude, to.longitude]],
        {
          color: colorForMph(kphToMph(from.smoothedSpeedKph), theme),
          weight: 5,
          opacity: 0.95,
          lineCap: 'round',
        },
      ).addTo(layer);
    }

    const start = points[0]!;
    const end = points.at(-1)!;
    L.circleMarker([start.latitude, start.longitude], {
      radius: 6, color: '#ffffff', weight: 2, fillColor: '#111111', fillOpacity: 1,
    }).bindTooltip('Start').addTo(layer);
    L.circleMarker([end.latitude, end.longitude], {
      radius: 6, color: '#111111', weight: 2, fillColor: '#ffffff', fillOpacity: 1,
    }).bindTooltip('End').addTo(layer);

    const key = `${start.timestampMs}:${points.length}`;
    if (fitted.current !== key) {
      instance.fitBounds(L.latLngBounds(points.map((p) => [p.latitude, p.longitude])), {
        padding: [24, 24],
      });
      fitted.current = key;
    }
  }, [points, theme]);

  // Move the playback marker.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const current = cursorMs === null ? undefined : nearest(points, cursorMs);
    if (!current) { marker.current?.remove(); marker.current = null; return; }

    const position: L.LatLngExpression = [current.latitude, current.longitude];
    const color = colorForMph(kphToMph(current.smoothedSpeedKph), theme);
    if (marker.current) {
      marker.current.setLatLng(position).setStyle({ fillColor: color });
    } else {
      marker.current = L.circleMarker(position, {
        radius: 9, weight: 3, color: '#ffffff', fillColor: color, fillOpacity: 1,
      }).addTo(instance);
    }
  }, [cursorMs, points, theme]);

  // Click the route to jump to that moment.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const handler = (event: L.LeafletMouseEvent) => {
      const closest = nearestByPosition(points, event.latlng.lat, event.latlng.lng);
      if (closest) onSeek(closest.timestampMs);
    };
    instance.on('click', handler);
    return () => { instance.off('click', handler); };
  }, [points, onSeek]);

  return <div ref={container} className="route-map" role="application" aria-label="Route map" />;
}

function nearest(points: CleanPoint[], timestampMs: number): CleanPoint | undefined {
  let best: CleanPoint | undefined;
  let bestDelta = Infinity;
  for (const point of points) {
    const delta = Math.abs(point.timestampMs - timestampMs);
    if (delta < bestDelta) { bestDelta = delta; best = point; }
  }
  return bestDelta <= 5000 ? best : undefined;
}

function nearestByPosition(points: CleanPoint[], lat: number, lon: number): CleanPoint | undefined {
  let best: CleanPoint | undefined;
  let bestDistance = Infinity;
  for (const point of points) {
    const distance = (point.latitude - lat) ** 2 + (point.longitude - lon) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = point; }
  }
  return best;
}
