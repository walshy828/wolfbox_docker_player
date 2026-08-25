import type { LatLon } from './geo.ts';

/** One OpenStreetMap way, as much of it as this app needs. */
export interface RoadWay {
  id: number;
  /** Raw OSM tags, trimmed by the server to the handful that matter. */
  tags: Record<string, string>;
  /** The way's nodes in order. Two or more. */
  geometry: LatLon[];
}

/** Which road a sample was driven on, if any could be established. */
export interface RoadMatch {
  timestampMs: number;
  /** Undefined when no road was near enough to claim the sample. */
  wayId?: number;
  /** How far the sample sat from the matched way's centreline, in metres. */
  offsetMeters?: number;
  /** Whether travel was along the way's node order, for directional tags. */
  forward?: boolean;
}
