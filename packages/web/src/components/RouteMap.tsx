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
  /** Re-frames the whole route. Offered whenever the user has panned away. */
  onRefit?: () => void;
}

/** A pause longer than this is a recording gap, not a straight line to draw. */
const GAP_MS = 10_000;
/** How far a track point may be from the cursor before the marker is hidden. */
const CURSOR_TOLERANCE_MS = 5_000;
/** Keep the vehicle inside this fraction of the viewport when following. */
const FOLLOW_INSET = 0.7;
/** How far playback must advance past a fresh fit before the map starts panning. */
const ARM_FOLLOW_AFTER_MS = 2_000;

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
  /**
   * The route we still owe a fit. Leaflet computes zoom from the container's
   * pixel size, so fitting while the pane is still unsized -- which is the norm
   * for a grid child on first paint, and for a panel that was just expanded --
   * silently produces the wrong zoom or no move at all. The fit is retried
   * until it happens against a container with real dimensions.
   */
  const pendingFit = useRef<L.LatLngBounds | null>(null);
  /**
   * Auto-panning stays disarmed until playback actually moves.
   *
   * A freshly fitted route puts the vehicle at the very edge of the bounds --
   * it starts at one end of the line -- so an eager follow would immediately
   * pan to the start and throw away the whole-route view the fit just
   * produced. Arm only once the clock has advanced.
   */
  const followArmed = useRef(false);
  const fitCursor = useRef<number | null>(null);
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
    const resize = new ResizeObserver(() => {
      instance.invalidateSize();
      applyPendingFit(instance);
    });
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
      fitted.current = key;
      pendingFit.current = L.latLngBounds(track.map((p) => [p.latitude, p.longitude]));
      followArmed.current = false;
      fitCursor.current = cursorMs;
      setFollowing(true);
      map.invalidateSize();
      applyPendingFit(map);
    }
  }, [map, route, points, theme]);

  /**
   * Fits the outstanding route, if the map is big enough to be fitted to.
   *
   * Clears the request only on success, so a fit requested against a
   * zero-height pane is honoured as soon as the pane gets its size.
   */
  function applyPendingFit(instance: L.Map): void {
    const bounds = pendingFit.current;
    if (!bounds || !bounds.isValid()) return;
    const size = instance.getSize();
    if (size.x < 40 || size.y < 40) return;

    selfPanning.current = true;
    instance.fitBounds(bounds, { padding: [28, 28], animate: false });
    selfPanning.current = false;
    pendingFit.current = null;
  }

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

    if (!followArmed.current && fitCursor.current !== null && cursorMs !== null
        && Math.abs(cursorMs - fitCursor.current) > ARM_FOLLOW_AFTER_MS) {
      followArmed.current = true;
    }

    // Never pan while a fit is still owed, or the vehicle would drag the view
    // off the route the user has not been shown yet.
    if (following && followArmed.current && !pendingFit.current
        && !map.getBounds().pad(-(1 - FOLLOW_INSET)).contains(position)) {
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
    followArmed.current = true;
    const current = cursorMs === null ? undefined : nearest(points, cursorMs);
    if (map && current) {
      selfPanning.current = true;
      map.panTo([current.latitude, current.longitude], { animate: true });
      map.once('moveend', () => { selfPanning.current = false; });
    }
  }, [map, cursorMs, points]);

  const refit = useCallback(() => {
    if (!map) return;
    const track = points.filter(usable);
    if (track.length === 0) return;
    pendingFit.current = L.latLngBounds(track.map((p) => [p.latitude, p.longitude]));
    followArmed.current = false;
    fitCursor.current = cursorMs;
    map.invalidateSize();
    applyPendingFit(map);
    setFollowing(true);
  }, [map, points, cursorMs]);

  return (
    <div className="route-map-wrap">
      <div ref={container} className="route-map" role="application" aria-label="Route map" />
      {points.length === 0 && (
        <p className="map-empty">No GPS positions for this trip yet.</p>
      )}
      {points.length > 0 && (
        <div className="map-actions">
          <button onClick={refit} title="Zoom to fit the whole route">Whole route</button>
          {!following && <button onClick={recenter}>Follow vehicle</button>}
        </div>
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
