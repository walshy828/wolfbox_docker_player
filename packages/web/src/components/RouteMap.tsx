import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { kphToMph, type CleanPoint } from '@wolfbox/telemetry';
import { colorForMph, type Theme } from '../speedScale.ts';

interface Props {
  points: CleanPoint[];
  /** Playback position; the vehicle marker follows it. */
  cursorMs: number | null;
  theme: Theme;
  onSeek: (timestampMs: number) => void;
}

/** A pause longer than this is a recording gap, not a straight line to draw. */
const GAP_MS = 10_000;
/** How far a track point may be from the cursor before the marker is hidden. */
const CURSOR_TOLERANCE_MS = 5_000;
/** Keep the vehicle inside this fraction of the viewport when following. */
const FOLLOW_INSET = 0.7;

const usable = (p: CleanPoint) =>
  Number.isFinite(p.latitude) && Number.isFinite(p.longitude) &&
  Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;

/**
 * A chevron pointing along the direction of travel, rotated to the heading.
 *
 * The vehicle needs to be findable at a glance against a route line drawn in
 * the same palette, so it carries a white outer ring and is drawn larger than
 * the line is wide. Its fill is the speed colour, which means the marker and
 * the segment it sits on agree.
 */
function vehicleIcon(headingDeg: number, color: string): L.DivIcon {
  const rotation = Number.isFinite(headingDeg) ? headingDeg : 0;
  return L.divIcon({
    className: 'vehicle-marker',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `
      <svg viewBox="0 0 34 34" width="34" height="34" aria-hidden="true"
           style="transform: rotate(${rotation}deg)">
        <circle cx="17" cy="17" r="13" fill="#ffffff" fill-opacity="0.9"/>
        <path d="M17 5 L26 27 L17 21.5 L8 27 Z"
              fill="${color}" stroke="#1a1a19" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`,
  });
}

/**
 * Draws the route with each one-second segment coloured by the speed driven
 * over it, and a vehicle marker tracking playback.
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
  const [following, setFollowing] = useState(true);
  const vehicle = useRef<L.Marker | null>(null);
  const fitted = useRef<string | null>(null);
  // Distinguishes our own panTo calls from the user dragging the map.
  const selfPanning = useRef(false);

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

    // Dragging the map is a deliberate choice to look elsewhere; stop chasing
    // the vehicle until the user asks for it again.
    const onDragStart = () => { if (!selfPanning.current) setFollowing(false); };
    instance.on('dragstart', onDragStart);

    setMap(instance);
    setRoute(layer);
    return () => {
      resize.disconnect();
      instance.off('dragstart', onDragStart);
      instance.remove();
      setMap(null);
      setRoute(null);
      vehicle.current = null;
      fitted.current = null;
    };
  }, []);

  // Redraw the route whenever the trip, theme or map instance changes.
  useEffect(() => {
    if (!map || !route) return;
    route.clearLayers();

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

    // Frame the new trip, and resume following it.
    const key = `${start.timestampMs}:${track.length}`;
    if (fitted.current !== key) {
      map.invalidateSize();
      selfPanning.current = true;
      map.fitBounds(L.latLngBounds(track.map((p) => [p.latitude, p.longitude])), {
        padding: [24, 24],
      });
      selfPanning.current = false;
      fitted.current = key;
      setFollowing(true);
    }
  }, [map, route, points, theme]);

  // Move the vehicle marker, and keep it on screen while following.
  useEffect(() => {
    if (!map) return;
    const current = cursorMs === null ? undefined : nearest(points, cursorMs);
    if (!current) {
      vehicle.current?.remove();
      vehicle.current = null;
      return;
    }

    const position = L.latLng(current.latitude, current.longitude);
    const icon = vehicleIcon(
      current.headingDeg,
      colorForMph(kphToMph(current.smoothedSpeedKph), theme),
    );
    if (vehicle.current) {
      vehicle.current.setLatLng(position).setIcon(icon);
    } else {
      vehicle.current = L.marker(position, { icon, interactive: false, zIndexOffset: 1000 })
        .addTo(map);
    }

    if (following && !map.getBounds().pad(-(1 - FOLLOW_INSET)).contains(position)) {
      selfPanning.current = true;
      map.panTo(position, { animate: true, duration: 0.4 });
      // Leaflet fires dragstart synchronously only for real drags, but the pan
      // completes asynchronously, so clear the flag once it has settled.
      map.once('moveend', () => { selfPanning.current = false; });
    }
  }, [map, cursorMs, points, theme, following]);

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

  const recenter = useCallback(() => {
    setFollowing(true);
    const current = cursorMs === null ? undefined : nearest(points, cursorMs);
    if (map && current) {
      selfPanning.current = true;
      map.panTo([current.latitude, current.longitude], { animate: true });
      map.once('moveend', () => { selfPanning.current = false; });
    }
  }, [map, cursorMs, points]);

  return (
    <div className="route-map-wrap">
      <div ref={container} className="route-map" role="application" aria-label="Route map" />
      {!following && points.length > 0 && (
        <button className="map-follow" onClick={recenter}>Follow vehicle</button>
      )}
    </div>
  );
}

function nearest(points: CleanPoint[], timestampMs: number): CleanPoint | undefined {
  if (!Number.isFinite(timestampMs)) return undefined;
  let best: CleanPoint | undefined;
  let bestDelta = Infinity;
  for (const point of points) {
    if (!usable(point)) continue;
    const delta = Math.abs(point.timestampMs - timestampMs);
    if (delta < bestDelta) { bestDelta = delta; best = point; }
  }
  return bestDelta <= CURSOR_TOLERANCE_MS ? best : undefined;
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
