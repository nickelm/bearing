/**
 * A mission's waypoints (roadmap R2.6, decision 305): the flight plan's points that the
 * navigation system steers to and the moving map draws, read from the route's phases.
 * Pure: the route's segments only.
 *
 * - **The points.** The base the flight left from; the initial point where the fence-in
 *   starts (IP); the target of a pass (TGT), the center of a station's racetrack (STN) or
 *   the field of a landing (LZ); and the field it recovers to (HOME). The climb, the
 *   ingress, the turn off the target and the way home all run along great circles
 *   between them, so straight legs from point to point are the plan as flown.
 * - **Sequencing.** A waypoint is passed once the mission's phase has gone past it (the
 *   IP from the fence-in, the target or station from the egress, the base at once); a
 *   turn point also once the aircraft came within SEQUENCE_RADIUS of it, as an F-16's
 *   steerpoints sequence at 2 nm. The target and the station never pass by proximity, so
 *   overflying the target keeps steering to it (decision 310). The next waypoint is the
 *   first one not passed; the pilot may choose another by hand (`AvionicsState.steerpoint`).
 */
import { arcDistance } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { NAUTICAL_MILE } from '../../core/units';
import type { GameTime } from '../../core/units';
import { MISSION_PHASES } from './mission';
import type { MissionPhase } from './mission';
import type { Route } from './route';

export type WaypointKind = 'base' | 'ip' | 'target' | 'station' | 'landing' | 'home';

export interface Waypoint {
  kind: WaypointKind;
  /** What the HUD and the map call it: BASE, IP, TGT, STN, LZ, HOME. */
  label: string;
  point: Dir;
  /** The planned time over it (game time, s). */
  time: GameTime;
  /** The phase from which it counts as passed. */
  passedFrom: MissionPhase;
}

export const WAYPOINT_LABELS: Readonly<Record<WaypointKind, string>> = {
  base: 'BASE',
  ip: 'IP',
  target: 'TGT',
  station: 'STN',
  landing: 'LZ',
  home: 'HOME',
};

/** Within this distance of a waypoint it counts as passed (m): 2 nm. */
export const SEQUENCE_RADIUS = 2 * NAUTICAL_MILE;

const point = (d: Readonly<Dir>): Dir => [d[0], d[1], d[2]];

function waypoint(
  kind: WaypointKind,
  at: Readonly<Dir>,
  time: GameTime,
  passedFrom: MissionPhase,
): Waypoint {
  return { kind, label: WAYPOINT_LABELS[kind], point: point(at), time, passedFrom };
}

/** The route's waypoints in the order flown (see the module's comment). */
export function routeWaypoints(route: Readonly<Route>): Waypoint[] {
  const s = route.segments;
  const out: Waypoint[] = [];
  const first = s[0];
  if (first?.kind === 'ground' && first.phase === 'departure')
    out.push(waypoint('base', first.a, first.t1, 'departure'));
  const fence = s.find((x) => x.phase === 'fence-in');
  if (fence) out.push(waypoint('ip', fence.a, fence.t0, 'fence-in'));
  // On target: a racetrack (joined by a leg of its own), a stop on the ground, or a pass
  // whose first leg ends over the target.
  const work = s.filter((x) => x.phase === 'on-target');
  const orbit = work.find((x) => x.kind === 'orbit');
  const stop = work.find((x) => x.kind === 'ground');
  if (orbit) out.push(waypoint('station', orbit.a, orbit.t0, 'egress'));
  else if (stop) out.push(waypoint('landing', stop.a, stop.t0, 'egress'));
  else if (work[0]) out.push(waypoint('target', work[0].b, work[0].t1, 'egress'));
  const last = s[s.length - 1];
  if (last && (last.phase === 'recovery' || last.phase === 'approach'))
    out.push(waypoint('home', last.kind === 'ground' ? last.a : last.b, last.t0, 'complete'));
  return out;
}

/**
 * The index of the next waypoint to steer to, or −1 when every one is passed: the first
 * not passed in `phase` and not in `passed` (those reached within SEQUENCE_RADIUS).
 */
export function nextWaypoint(
  wps: readonly Waypoint[],
  phase: MissionPhase | 'planned',
  passed: ReadonlySet<number>,
): number {
  const at = phase === 'planned' ? -1 : MISSION_PHASES.indexOf(phase);
  for (let i = 0; i < wps.length; i++) {
    if (passed.has(i)) continue;
    if (at >= MISSION_PHASES.indexOf(wps[i]!.passedFrom)) continue;
    return i;
  }
  return -1;
}

/**
 * Marks the next waypoint passed when `pos` (a unit direction) is within SEQUENCE_RADIUS of
 * it. Only turn points (the IP) sequence so: the target and the station stay the steerpoint
 * until their phase ends, so a pass over the target or a re-attack keeps steering to it, and
 * home is where the flight ends (decision 310).
 */
export function sequenceWaypoints(
  wps: readonly Waypoint[],
  next: number,
  pos: Readonly<Dir>,
  radius: number,
  passed: Set<number>,
): boolean {
  const w = wps[next];
  if (!w || w.kind !== 'ip') return false;
  if (arcDistance(w.point, pos, radius) > SEQUENCE_RADIUS) return false;
  passed.add(next);
  return true;
}
