const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export interface LatLon { latitude: number; longitude: number }

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, in degrees true (0-360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export const KPH_PER_MPH = 1.609344;
export const kphToMph = (kph: number) => kph / KPH_PER_MPH;
export const mphToKph = (mph: number) => mph * KPH_PER_MPH;

/** Smallest angle between two bearings, in degrees, folded to [0, 180]. */
export function angleDelta(a: number, b: number): number {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180);
}

export interface SegmentHit {
  /** Distance from the point to the nearest place on the segment, in metres. */
  meters: number;
  /** Where that place falls along the segment, 0 at `a` and 1 at `b`. */
  t: number;
}

/**
 * Distance from a point to a line segment.
 *
 * Works in a local flat projection centred on the point rather than on the
 * sphere: over the few tens of metres this is ever asked about, the error is
 * far below the GPS noise it is being compared against, and a foot-of-
 * perpendicular has no closed form in spherical geometry worth the cost.
 */
export function pointToSegmentMeters(p: LatLon, a: LatLon, b: LatLon): SegmentHit {
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos(toRad(p.latitude));
  const x = (q: LatLon) => (q.longitude - p.longitude) * mPerDegLon;
  const y = (q: LatLon) => (q.latitude - p.latitude) * mPerDegLat;

  const ax = x(a), ay = y(a), bx = x(b), by = y(b);
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;

  // A zero-length segment is a duplicated node; fall back to the endpoint.
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq));
  const nx = ax + dx * t, ny = ay + dy * t;
  return { meters: Math.hypot(nx, ny), t };
}
