import type { CleanPoint } from './clean.ts';
import { haversineMeters, kphToMph } from './geo.ts';

/** Below this the vehicle is treated as stopped, absorbing GPS jitter at rest. */
export const STOPPED_KPH = 3;

export interface TripSummary {
  startMs: number;
  endMs: number;
  durationSec: number;
  movingSec: number;
  stoppedSec: number;
  distanceMeters: number;
  /** Mean over the whole trip, including time spent stopped. */
  averageSpeedKph: number;
  /** Mean over moving samples only -- usually the more useful number. */
  averageMovingSpeedKph: number;
  maxSpeedKph: number;
  start?: { latitude: number; longitude: number };
  end?: { latitude: number; longitude: number };
  bounds?: { north: number; south: number; east: number; west: number };
  /** Time in seconds spent in each bucket of `SPEED_BUCKETS_MPH`. */
  histogramMph: number[];
  /** Samples whose forward acceleration exceeded the harsh-event threshold. */
  harshEvents: { timestampMs: number; deltaKph: number; kind: 'braking' | 'acceleration' }[];
}

/**
 * Band edges in mph, matching the map's speed ramp.
 *
 * The top band starts at 80 because that is where the colour ramp tops out, so
 * "time spent at 80+" is exactly the time painted in the deepest colour.
 */
export const SPEED_BUCKETS_MPH = [0, 15, 35, 60, 80, Infinity];

/**
 * A speed change of more than this between consecutive 1 Hz samples is a harsh
 * event. 12 km/h in one second is ~0.34g, a firm but not emergency stop.
 */
export const HARSH_DELTA_KPH = 12;

/**
 * Derives trip metrics from a cleaned track.
 *
 * Distance is integrated from GPS positions rather than the reported speed:
 * the speed field reads consistently ~10% below the GPS-derived value on the
 * reference card, so trusting it would under-report every trip.
 *
 * Speed statistics use `smoothedSpeedKph`, not the raw reading. The receiver
 * emits isolated spikes that are too low to trip the outlier filter but still
 * wrong -- a lone 161 km/h sample in an otherwise 35 km/h trip would otherwise
 * be reported as the trip's top speed. Raw `speedKph` stays on each point for
 * the live readout, which should show what the camera actually said.
 */
export function summarize(points: CleanPoint[]): TripSummary | null {
  if (points.length === 0) return null;

  const first = points[0]!;
  const last = points.at(-1)!;
  let distanceMeters = 0;
  let movingSec = 0;
  let stoppedSec = 0;
  let maxSpeedKph = 0;
  let speedSum = 0;
  let movingSpeedSum = 0;
  let movingSamples = 0;

  const histogramMph = new Array(SPEED_BUCKETS_MPH.length - 1).fill(0);
  const harshEvents: TripSummary['harshEvents'] = [];
  let north = -90, south = 90, east = -180, west = 180;

  for (const [i, point] of points.entries()) {
    const previous = points[i - 1];
    // Each sample stands for the interval since the previous one, capped so a
    // recording gap inside a trip is not counted as driving time.
    const seconds = previous
      ? Math.min(Math.max((point.timestampMs - previous.timestampMs) / 1000, 0), 5)
      : 0;

    if (previous) distanceMeters += haversineMeters(previous, point);

    const speedKph = point.smoothedSpeedKph;
    const moving = speedKph > STOPPED_KPH;
    if (moving) { movingSec += seconds; movingSpeedSum += speedKph; movingSamples++; }
    else stoppedSec += seconds;

    speedSum += speedKph;
    maxSpeedKph = Math.max(maxSpeedKph, speedKph);

    const mph = kphToMph(speedKph);
    const bucket = SPEED_BUCKETS_MPH.findIndex((upper, b) => b > 0 && mph < upper) - 1;
    if (bucket >= 0) histogramMph[bucket] += seconds;

    if (previous && seconds > 0) {
      const deltaKph = (speedKph - previous.smoothedSpeedKph) / seconds;
      if (Math.abs(deltaKph) >= HARSH_DELTA_KPH) {
        harshEvents.push({
          timestampMs: point.timestampMs,
          deltaKph,
          kind: deltaKph < 0 ? 'braking' : 'acceleration',
        });
      }
    }

    north = Math.max(north, point.latitude);
    south = Math.min(south, point.latitude);
    east = Math.max(east, point.longitude);
    west = Math.min(west, point.longitude);
  }

  const durationSec = (last.timestampMs - first.timestampMs) / 1000;
  return {
    startMs: first.timestampMs,
    endMs: last.timestampMs,
    durationSec,
    movingSec,
    stoppedSec,
    distanceMeters,
    averageSpeedKph: speedSum / points.length,
    averageMovingSpeedKph: movingSamples > 0 ? movingSpeedSum / movingSamples : 0,
    maxSpeedKph,
    start: { latitude: first.latitude, longitude: first.longitude },
    end: { latitude: last.latitude, longitude: last.longitude },
    bounds: { north, south, east, west },
    histogramMph,
    harshEvents,
  };
}
