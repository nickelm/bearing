/**
 * Front segments for the air tasking order (roadmap R2.1): each continental
 * front's start line cut into segments of about SEGMENT_LENGTH, each with the
 * pressure an offensive puts on it.
 *
 * Until the ground war (R2.3) gives a force balance per segment, pressure comes
 * from the start line's corridors (the graph's weak segments, decision 96): a
 * corridor's weight is its road crossings by class against its barrier
 * strength, and each segment takes the weight of the corridors nearest it.
 * Pressure is BASE_PRESSURE everywhere plus the rest by that weight, the
 * heaviest segment at 1. Both sides see the same pressure: the attacker pushes
 * there and the defender holds there.
 */
import type { Side } from '../../campaign/cast';
import {
  alongPolyline,
  arcDistance,
  polylineStations,
  tangentHeading,
  toward,
} from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import type { FrontInput } from './campaignInput';

/** Wanted length of a front segment (m). */
export const SEGMENT_LENGTH = 80e3;
export const MIN_SEGMENTS = 2;
export const MAX_SEGMENTS = 8;
/** Pressure on a segment with no corridor. */
export const BASE_PRESSURE = 0.2;

export interface FrontSegment {
  theater: number;
  index: number;
  /** Fractions of the line's length where the segment starts and ends. */
  from: number;
  to: number;
  /** The segment's middle on the line, and the line's heading there (rad). */
  point: Dir;
  heading: number;
  pressure: number;
  /** Name of the heaviest corridor in the segment, or null. */
  corridor: string | null;
  attacker: Side;
}

/** A point on a front line at fraction `frac`, pulled `setback` toward `side`'s centroid, and the line's heading there. */
export function frontPoint(
  f: FrontInput,
  stations: Float64Array,
  frac: number,
  side: Side,
  setback: number,
  radius: number,
): { point: Dir; heading: number } {
  const at = alongPolyline(f.points, stations, frac * stations[stations.length - 1]!);
  const centroid = f.centroid[side];
  const d = arcDistance(at.point, centroid, radius);
  const point =
    setback > 0 ? toward(at.point, centroid, Math.min(setback, 0.7 * d), radius) : at.point;
  return { point, heading: tangentHeading(at.point, at.tangent) };
}

/** The front's segments with their pressure. */
export function frontSegments(f: FrontInput, radius: number): FrontSegment[] {
  const stations = polylineStations(f.points, radius);
  const length = stations[stations.length - 1]!;
  const n = Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.round(length / SEGMENT_LENGTH)));
  const segments: FrontSegment[] = [];
  for (let i = 0; i < n; i++) {
    const mid = alongPolyline(f.points, stations, ((i + 0.5) / n) * length);
    segments.push({
      theater: f.theater,
      index: i,
      from: i / n,
      to: (i + 1) / n,
      point: mid.point,
      heading: tangentHeading(mid.point, mid.tangent),
      pressure: BASE_PRESSURE,
      corridor: null,
      attacker: f.attacker,
    });
  }
  const weight = new Float64Array(n);
  const best = new Float64Array(n).fill(-1);
  for (const c of f.corridors) {
    const w = (0.25 + c.roadScore) * (1 - Math.min(1, Math.max(0, c.strength)));
    let k = 0;
    let dk = Infinity;
    for (let i = 0; i < n; i++) {
      const d = arcDistance(segments[i]!.point, c.point, radius);
      if (d < dk) {
        dk = d;
        k = i;
      }
    }
    weight[k]! += w;
    if (w > best[k]!) {
      best[k] = w;
      segments[k]!.corridor = c.name;
    }
  }
  const max = Math.max(...weight);
  if (max > 0) {
    for (let i = 0; i < n; i++) {
      segments[i]!.pressure = BASE_PRESSURE + (1 - BASE_PRESSURE) * (weight[i]! / max);
    }
  }
  return segments;
}
