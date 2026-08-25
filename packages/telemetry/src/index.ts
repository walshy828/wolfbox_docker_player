export type { ByteReader } from './reader.ts';
export { blobReader } from './reader.ts';
export type { Box, Track } from './mp4.ts';
export { findMoov, parseTracks } from './mp4.ts';
export type { TelemetryPoint } from './gpmd.ts';
export {
  readTelemetry, findTelemetryTrack, resolveTimestamp, clipStartMs, SAMPLE_INTERVAL_MS,
} from './gpmd.ts';
export type { CleanPoint, CleanOptions } from './clean.ts';
export { cleanTrack } from './clean.ts';
export type { LatLon } from './geo.ts';
export type { SegmentHit } from './geo.ts';
export {
  haversineMeters, bearingDeg, angleDelta, pointToSegmentMeters,
  kphToMph, mphToKph, KPH_PER_MPH,
} from './geo.ts';
export type { Camera, ClipKind, ClipRef, ClipPair, Trip } from './catalog.ts';
export {
  parseClipName, clipFolder, pairClips, groupTrips, buildTrips,
  CLIP_FOLDERS, CLIP_DURATION_MS, TRIP_GAP_MS, PAIR_TOLERANCE_MS,
} from './catalog.ts';
export type { TripSummary } from './summary.ts';
export { summarize, SPEED_BUCKETS_MPH, STOPPED_KPH } from './summary.ts';
export type { RoadWay, RoadMatch } from './roads.ts';
export type { MatchOptions } from './matchRoads.ts';
export {
  matchRoads, MAX_MATCH_METERS, STICKY_MATCH_METERS, HEADING_WEIGHT_M,
  CONTINUITY_BONUS_M, MIN_RUN_SAMPLES,
} from './matchRoads.ts';
export type { LimitSource, RegionCode, SpeedLimit } from './maxspeed.ts';
export { parseMaxspeed, limitForWay, inferRegion } from './maxspeed.ts';
export type { Severity, OverLimitStretch, Coverage, TripAdherence } from './adherence.ts';
export {
  assessAdherence, severityFor, TOLERANCE_MPH, SUSTAIN_SEC, RELEASE_SEC, MIN_COVERAGE_FOR_SCORE,
} from './adherence.ts';
export type { HarshKind, HarshSeverity, HarshEvent } from './harshEvents.ts';
export {
  detectHarshEvents, HARSH_DELTA_KPH, SEVERE_DELTA_KPH, MERGE_GAP_SAMPLES, MAX_RELIABLE_GAP_SEC,
} from './harshEvents.ts';
export type { AccelG } from './accel.ts';
export {
  longitudinalGAt, lateralGAt, COUNTS_PER_G, REST_BASELINE, MODERATE_G, SEVERE_G,
} from './accel.ts';
export type { DriveScoreInput, DriveScore, DriveScoreBand } from './driveScore.ts';
export { computeDriveScore, bandFor } from './driveScore.ts';
