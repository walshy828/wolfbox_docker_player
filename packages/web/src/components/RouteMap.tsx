import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { kphToMph, type CleanPoint, type HarshEvent } from '@wolfbox/telemetry';
import {
  colorForMph, colorForExcessMph, unknownLimitColor, type Theme,
} from '../speedScale.ts';
import { vehicleAt } from '../vehicle.ts';
import { seekTargetMs } from '../safety.ts';

interface Props {
  points: CleanPoint[];
  /** Playback position; the vehicle marker follows it. */
  cursorMs: number | null;
  theme: Theme;
  onSeek: (timestampMs: number) => void;
  /** What the line paints: the speed driven, or how far over the limit it was. */
  mode?: 'speed' | 'excess';
  /**
   * Excess over the limit per sample, aligned with `points`. Undefined entries
   * are stretches where no limit is known, drawn dashed and neutral so they
   * cannot be mistaken for compliant driving.
   */
  excessMph?: (number | undefined)[];
  /** Hard-braking/acceleration events, marked on the route at their peak moment. */
  events?: HarshEvent[];
  /**
   * The event or stretch currently selected in the Safety/Adherence panel, so
   * its stretch of road can be picked out and brought into view. `null`/`undefined`
   * clears it.
   */
  highlight?: { startMs: number; endMs: number } | null;
  /** Re-frames the whole route. Offered whenever the user has panned away. */
  onRefit?: () => void;
}

const EVENT_MARKER_COLOR: Record<HarshEvent['severity'], string> = {
  moderate: '#c47a1f',
  severe: '#c0392b',
};

/** Matches the `--accent` custom property in styles.css for each theme. */
const HIGHLIGHT_COLOR: Record<Theme, string> = { light: '#1f5fbf', dark: '#7fb0ff' };
/** Widens a highlighted event/stretch so a near-instant one still reads as a stretch of road. */
const HIGHLIGHT_PAD_MS = 3_000;

/** A pause longer than this is a recording gap, not a straight line to draw. */
const GAP_MS = 10_000;
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
function vehicleIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: 'vehicle-marker',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    html: `
      <svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
        <circle cx="18" cy="18" r="14" fill="#ffffff" fill-opacity="0.92"/>
        <circle cx="18" cy="18" r="14" fill="none" stroke="#1a1a19"
                stroke-opacity="0.25" stroke-width="1"/>
        <path d="M18 6 L27.5 29 L18 23.2 L8.5 29 Z"
              fill="${color}" stroke="#1a1a19" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`,
  });
}

/** A pulsing ring pinning down a highlighted event/stretch's location. */
function highlightIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: 'highlight-marker',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `
      <span class="highlight-marker-ring" style="border-color:${color}"></span>
      <span class="highlight-marker-dot" style="background:${color}"></span>`,
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
export function RouteMap({
  points, cursorMs, theme, onSeek, mode = 'speed', excessMph, events, highlight,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const [route, setRoute] = useState<L.LayerGroup | null>(null);
  const [highlightLayer, setHighlightLayer] = useState<L.LayerGroup | null>(null);
  const [following, setFollowing] = useState(true);
  const vehicle = useRef<L.Marker | null>(null);
  const lastIconColor = useRef<string | null>(null);
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
    // Added before the route layer so its coloured line renders on top of the
    // highlight, which then reads as a halo around it rather than covering it.
    const highlights = L.layerGroup().addTo(instance);
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
    setHighlightLayer(highlights);
    return () => {
      resize.disconnect();
      instance.off('dragstart', onDragStart);
      instance.remove();
      setMap(null);
      setRoute(null);
      setHighlightLayer(null);
      vehicle.current = null;
      fitted.current = null;
    };
  }, []);

  // Redraw the route whenever the trip, theme or map instance changes.
  useEffect(() => {
    if (!map || !route) return;
    route.clearLayers();

    // The excess series is aligned with the unfiltered points, so keep each
    // sample's original index alongside it rather than re-deriving one.
    const track = points.map((point, index) => ({ point, index })).filter((p) => usable(p.point));
    if (track.length === 0) { fitted.current = null; return; }

    const comparing = mode === 'excess' && excessMph !== undefined;

    for (let i = 1; i < track.length; i++) {
      const from = track[i - 1]!;
      const to = track[i]!;
      if (to.point.timestampMs - from.point.timestampMs > GAP_MS) continue;

      const excess = comparing ? excessMph[from.index] : undefined;
      // An unknown limit gets a dashed neutral line. Colour alone would leave
      // "we don't know" looking like "nothing wrong here", which is the one
      // reading the data does not support.
      const unknown = comparing && excess === undefined;

      L.polyline(
        [[from.point.latitude, from.point.longitude], [to.point.latitude, to.point.longitude]],
        {
          color: unknown ? unknownLimitColor(theme)
            : comparing ? colorForExcessMph(excess!, theme)
            : colorForMph(kphToMph(from.point.smoothedSpeedKph), theme),
          weight: 5,
          opacity: unknown ? 0.7 : 0.95,
          lineCap: 'round',
          ...(unknown ? { dashArray: '4 6' } : {}),
        },
      ).addTo(route);
    }

    const start = track[0]!.point;
    const end = track.at(-1)!.point;
    L.circleMarker([start.latitude, start.longitude], {
      radius: 6, color: '#ffffff', weight: 2, fillColor: '#111111', fillOpacity: 1,
    }).bindTooltip('Start').addTo(route);
    L.circleMarker([end.latitude, end.longitude], {
      radius: 6, color: '#111111', weight: 2, fillColor: '#ffffff', fillOpacity: 1,
    }).bindTooltip('End').addTo(route);

    for (const event of events ?? []) {
      const at = vehicleAt(points, event.peakAtMs);
      if (!at) continue;
      L.circleMarker([at.latitude, at.longitude], {
        radius: 5, color: '#ffffff', weight: 1.5,
        fillColor: EVENT_MARKER_COLOR[event.severity], fillOpacity: 0.95,
      })
        .bindTooltip(event.kind === 'braking' ? 'Hard braking' : 'Hard acceleration')
        .on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          onSeek(seekTargetMs(event, track[0]!.point.timestampMs));
        })
        .addTo(route);
    }

    // Frame the new trip, and resume following it.
    const key = `${start.timestampMs}:${track.length}`;
    if (fitted.current !== key) {
      fitted.current = key;
      pendingFit.current = L.latLngBounds(track.map((p) => [p.point.latitude, p.point.longitude]));
      followArmed.current = false;
      fitCursor.current = cursorMs;
      setFollowing(true);
      map.invalidateSize();
      applyPendingFit(map);
    }
  }, [map, route, points, theme, mode, excessMph, events, onSeek]);

  // Picks out the event/stretch selected in the Safety or Adherence panel and
  // brings it into view, independently of the route redraw above so toggling
  // it never has to rebuild the whole coloured line.
  useEffect(() => {
    if (!map || !highlightLayer) return;
    highlightLayer.clearLayers();
    if (!highlight) return;

    const from = highlight.startMs - HIGHLIGHT_PAD_MS;
    const to = highlight.endMs + HIGHLIGHT_PAD_MS;
    const segment = points.filter((p) => usable(p) && p.timestampMs >= from && p.timestampMs <= to);
    const color = HIGHLIGHT_COLOR[theme];

    // Broken into runs at the same recording gaps the route line itself skips,
    // so a highlight never draws a straight line across a dropped fix.
    const runs: CleanPoint[][] = [];
    let current: CleanPoint[] = [];
    for (const point of segment) {
      if (current.length > 0 && point.timestampMs - current.at(-1)!.timestampMs > GAP_MS) {
        runs.push(current);
        current = [];
      }
      current.push(point);
    }
    if (current.length > 0) runs.push(current);

    for (const run of runs) {
      if (run.length < 2) continue;
      L.polyline(run.map((p) => [p.latitude, p.longitude]), {
        color, weight: 12, opacity: 0.35, lineCap: 'round',
      }).addTo(highlightLayer);
    }

    const anchor = vehicleAt(points, (highlight.startMs + highlight.endMs) / 2) ?? segment[0];
    const bounds = segment.length > 0
      ? L.latLngBounds(segment.map((p) => [p.latitude, p.longitude]))
      : anchor
        ? L.latLngBounds([[anchor.latitude, anchor.longitude], [anchor.latitude, anchor.longitude]])
        : null;
    if (anchor) {
      L.marker([anchor.latitude, anchor.longitude], {
        icon: highlightIcon(color), interactive: false, zIndexOffset: 900,
      }).addTo(highlightLayer);
    }

    if (bounds?.isValid()) {
      selfPanning.current = true;
      setFollowing(false);
      map.flyToBounds(bounds, { padding: [70, 70], maxZoom: 17, duration: 0.6 });
      map.once('moveend', () => { selfPanning.current = false; });
    }
  }, [map, highlightLayer, highlight, points, theme]);

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
    const current = vehicleAt(points, cursorMs);
    if (!current) {
      vehicle.current?.remove();
      vehicle.current = null;
      lastIconColor.current = null;
      return;
    }

    const position = L.latLng(current.latitude, current.longitude);
    const color = colorForMph(current.speedMph, theme);

    if (!vehicle.current) {
      vehicle.current = L.marker(position, {
        icon: vehicleIcon(color), interactive: false, zIndexOffset: 1000,
      }).addTo(map);
      lastIconColor.current = color;
    } else {
      vehicle.current.setLatLng(position);
      // Rebuilding the icon replaces the DOM node, which cancels the CSS
      // transition that smooths movement, so only do it when the colour has
      // actually changed rather than on every tick.
      if (lastIconColor.current !== color) {
        vehicle.current.setIcon(vehicleIcon(color));
        lastIconColor.current = color;
      }
    }

    // Rotation is applied to the existing node so the arrow turns smoothly.
    const element = vehicle.current.getElement()?.querySelector('svg');
    if (element instanceof SVGElement) {
      element.style.transform = `rotate(${current.headingDeg}deg)`;
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
    const current = vehicleAt(points, cursorMs);
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
