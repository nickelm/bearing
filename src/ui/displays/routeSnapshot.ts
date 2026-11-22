/**
 * The flight plan and the fronts for the displays (decision 305): places relative to the
 * aircraft as bearing and distance, which the moving map projects as its picture does.
 * Pure: great circles on unit directions.
 */
import { arcDistance, initialHeading, slerp } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import type { Waypoint } from '../../sim/air/waypoints';
import type { MapBearing, SnapshotFront, SnapshotRoute } from './snapshot';

/** The longest step between a leg's samples (m). */
export const ROUTE_STEP = 10_000;
/** How far from the aircraft the fronts are kept (m): past the map's longest range, turned. */
export const FRONT_REACH = 600_000;
/** The least step between a front's samples (m). */
const FRONT_STEP = 4_000;

/** Where `p` is from `from` (unit directions) on a planet of radius R. */
export function mapBearing(from: Readonly<Dir>, p: Readonly<Dir>, R: number): MapBearing {
  const d = arcDistance(from, p, R);
  return [d < 1 ? 0 : initialHeading(from, p), d];
}

/** The plan from `from` (the aircraft's unit direction): waypoints numbered from 1, legs sampled. */
export function routeSnapshot(
  wps: readonly Waypoint[],
  next: number,
  from: Readonly<Dir>,
  R: number,
): SnapshotRoute {
  const legs: MapBearing[][] = [];
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i]!.point;
    const b = wps[i + 1]!.point;
    const n = Math.max(1, Math.ceil(arcDistance(a, b, R) / ROUTE_STEP));
    const leg: MapBearing[] = [];
    for (let k = 0; k <= n; k++) leg.push(mapBearing(from, slerp(a, b, k / n), R));
    legs.push(leg);
  }
  return {
    waypoints: wps.map((w, i) => ({
      number: i + 1,
      kind: w.kind,
      label: w.label,
      at: mapBearing(from, w.point, R),
    })),
    next,
    legs,
  };
}

/** A front line as the strategic map draws it: unit directions (xyz), its teeth's side, its color. */
export interface FrontTrace {
  points: ArrayLike<number>;
  teeth: 1 | -1;
  color: number;
}

/**
 * The fronts within FRONT_REACH of `from`, thinned to FRONT_STEP, a line split where it
 * leaves the reach.
 */
export function frontsSnapshot(
  fronts: readonly FrontTrace[],
  from: Readonly<Dir>,
  R: number,
): SnapshotFront[] {
  const out: SnapshotFront[] = [];
  for (const f of fronts) {
    const color = `#${f.color.toString(16).padStart(6, '0')}`;
    let run: MapBearing[] = [];
    let last: Dir | null = null;
    const n = f.points.length / 3;
    const flush = () => {
      if (run.length >= 2) out.push({ points: run, teeth: f.teeth, color });
      run = [];
    };
    for (let i = 0; i < n; i++) {
      const p: Dir = [f.points[i * 3]!, f.points[i * 3 + 1]!, f.points[i * 3 + 2]!];
      const at = mapBearing(from, p, R);
      if (at[1] > FRONT_REACH) {
        flush();
        last = null;
        continue;
      }
      if (last && i < n - 1 && arcDistance(last, p, R) < FRONT_STEP) continue;
      run.push(at);
      last = p;
    }
    flush();
  }
  return out;
}
