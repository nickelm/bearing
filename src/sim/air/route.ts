/**
 * Analytic flight routes (C2): great-circle legs with climb and descent
 * profiles, racetrack orbits on station, and ground time at bases. A route is
 * a list of segments with start and end times, so position, altitude,
 * heading and fuel at any game time are closed-form (`routeState`): the sim
 * never integrates a flight it does not follow at full fidelity (P1).
 *
 * - **Legs** follow the great circle at constant ground speed; altitude
 *   changes linearly in time along a leg (a climb or a descent is a leg of its
 *   own).
 * - **Orbits** fly a racetrack: two straight legs ORBIT_LEG long, joined by
 *   half turns of radius `turn`, laid out in the tangent plane at the orbit's
 *   center (small enough that the plane is exact to a few meters).
 * - **Ground** segments hold the flight at a point: taxi and takeoff, landing
 *   and taxi, or a stop on the ground at an airlift destination.
 * - **Fuel** (per aircraft) falls linearly within a segment at the regime's
 *   flow (aircraft.ts FLOW). The cast's range factor scales the fuel load,
 *   never the flows (decision 51): a route is feasible while fuel stays above
 *   the reserve.
 *
 * - **Winds aloft** (R2.1): with a wind source, each leg flies at its ground
 *   speed, the true airspeed less the crosswind's crab plus the wind along the
 *   track, from the wind at the leg's middle and mean altitude; time, and so
 *   fuel, follows. Orbits fly at their airspeed (the wind's effect around a
 *   racetrack averages out). Without one, airspeed is ground speed.
 */
import {
  arcDistance,
  destination,
  dot,
  headingTangent,
  initialHeading,
  normalize,
  slerp,
  tangentHeading,
  toward,
} from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import type { GameTime, Meters } from '../../core/units';
import type { Wind } from '../weather/frame';
import { FLOW, FUEL_RESERVE } from './aircraft';
import type { AircraftType, FlowRegime } from './aircraft';
import type { MissionPhase } from './mission';

export type SegmentKind = 'ground' | 'leg' | 'orbit';

export interface RouteSegment {
  kind: SegmentKind;
  phase: MissionPhase;
  regime: FlowRegime;
  t0: GameTime;
  t1: GameTime;
  /** Leg: start and end. Orbit: the center and a point ahead of it along the racetrack's axis. Ground: the point (twice). */
  a: Dir;
  b: Dir;
  /** Altitude at the start and end (m above sea level). */
  alt0: number;
  alt1: number;
  /** Ground speed (m/s): along the leg or around the racetrack; 0 on the ground. */
  speed: number;
  /** Orbit: turn radius (m). */
  turn: number;
  /**
   * Orbit: distance around the racetrack at t0 (m), where the flight joined it
   * (decision 256); absent in routes planned before: 0, the lower leg's start.
   */
  around?: number;
  /** Ground: heading held (rad). */
  heading: number;
  /** Fuel per aircraft at t0 (kg) and flow (kg/s). */
  fuel0: number;
  flow: number;
}

export interface Route {
  segments: RouteSegment[];
  /** Fuel per aircraft at departure (kg, after the range factor) and the reserve kept. */
  fuel: number;
  reserve: number;
}

export interface RouteState {
  point: Dir;
  altitude: number;
  /** Heading of travel, clockwise from north (rad). */
  heading: number;
  speed: number;
  fuel: number;
  phase: MissionPhase;
  /** Index of the segment, or −1 before the start or after the end. */
  segment: number;
  airborne: boolean;
  /**
   * On the ground away from its base: a rescue at its pickup, later a sling load's
   * delivery or a forward refueling point. The map keeps drawing a landed flight, where
   * it drops one on its base's ground time (decision 371).
   */
  landed: boolean;
}

/** Wind at a point and altitude above sea level (m/s east and north), or null in calm air. */
export type WindSource = (p: Readonly<Dir>, altitude: Meters) => Wind | null;

/** Least ground speed as a share of airspeed, whatever the wind. */
export const MIN_GROUND_SPEED = 0.3;

/** Ground speed along a track `heading` (rad) at airspeed `tas` in wind `w`. */
export function groundSpeed(tas: number, heading: number, w: Wind | null): number {
  if (!w) return tas;
  const sh = Math.sin(heading);
  const ch = Math.cos(heading);
  const along = w.east * sh + w.north * ch;
  const cross = w.east * ch - w.north * sh;
  const lo = MIN_GROUND_SPEED * tas;
  return Math.max(lo, Math.sqrt(Math.max(lo * lo, tas * tas - cross * cross)) + along);
}

/** Length of each straight leg of a racetrack orbit (m). */
export const ORBIT_LEG = 40e3;
/** Racetrack turn radius for jets and helicopters (m): a rate-one turn is about 3 km for a jet at 250 m/s. */
export const ORBIT_TURN = 8e3;
export const HELICOPTER_ORBIT_TURN = 2e3;

export function perimeter(turn: number): number {
  return 2 * ORBIT_LEG + 2 * Math.PI * turn;
}

/**
 * Point and planar tangent at distance d around a racetrack centered at the
 * origin, axis +x, starting at the start of the lower leg (−L/2, −r) heading +x
 * (counterclockwise seen from above: the turns are to the left).
 */
function racetrack(d: number, turn: number): { x: number; y: number; tx: number; ty: number } {
  const L = ORBIT_LEG;
  const P = perimeter(turn);
  const s = ((d % P) + P) % P;
  const arc = Math.PI * turn;
  if (s < L) return { x: -L / 2 + s, y: -turn, tx: 1, ty: 0 };
  if (s < L + arc) {
    const th = -Math.PI / 2 + (s - L) / turn;
    return {
      x: L / 2 + turn * Math.cos(th),
      y: turn * Math.sin(th),
      tx: -Math.sin(th),
      ty: Math.cos(th),
    };
  }
  if (s < 2 * L + arc) return { x: L / 2 - (s - L - arc), y: turn, tx: -1, ty: 0 };
  const th = Math.PI / 2 + (s - 2 * L - arc) / turn;
  return {
    x: -L / 2 + turn * Math.cos(th),
    y: turn * Math.sin(th),
    tx: -Math.sin(th),
    ty: Math.cos(th),
  };
}

/** Racetrack position on the sphere: center c, axis toward `ahead`, `d` m around it. */
export function orbitPoint(
  c: Readonly<Dir>,
  ahead: Readonly<Dir>,
  turn: number,
  d: number,
  radius: Meters,
): { point: Dir; heading: number } {
  const k = dot(c, ahead);
  const u = normalize([ahead[0] - c[0] * k, ahead[1] - c[1] * k, ahead[2] - c[2] * k]);
  // Left of the axis, seen from above: c × u.
  const l: Dir = [c[1] * u[2] - c[2] * u[1], c[2] * u[0] - c[0] * u[2], c[0] * u[1] - c[1] * u[0]];
  const r = racetrack(d, turn);
  const point = normalize([
    c[0] + (r.x * u[0] + r.y * l[0]) / radius,
    c[1] + (r.x * u[1] + r.y * l[1]) / radius,
    c[2] + (r.x * u[2] + r.y * l[2]) / radius,
  ]);
  const t: Dir = [r.tx * u[0] + r.ty * l[0], r.tx * u[1] + r.ty * l[1], r.tx * u[2] + r.ty * l[2]];
  return { point, heading: tangentHeading(point, t) };
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Candidate join points around a racetrack. */
const JOIN_SAMPLES = 64;

/**
 * Where a flight at `from`, heading `heading`, joins a racetrack (decision 256): the
 * distance around it whose point it reaches by a straight leg with the least turning,
 * at the leg's start and where it meets the racetrack's direction, and a little
 * preference for near points. Joining at the lower leg's start whatever the arrival
 * reversed a flight coming from the base side by about 170°.
 */
export function orbitJoin(
  c: Readonly<Dir>,
  ahead: Readonly<Dir>,
  turn: number,
  from: Readonly<Dir>,
  heading: number,
  radius: Meters,
): number {
  const P = perimeter(turn);
  let best = 0;
  let bestScore = Infinity;
  for (let k = 0; k < JOIN_SAMPLES; k++) {
    const d = (P * k) / JOIN_SAMPLES;
    const o = orbitPoint(c, ahead, turn, d, radius);
    const dist = arcDistance(from, o.point, radius);
    let score = (0.5 * dist) / P;
    if (dist > 1) {
      const out = initialHeading(from, o.point);
      const arrive = initialHeading(o.point, from) + Math.PI;
      score += Math.abs(wrapAngle(out - heading)) + Math.abs(wrapAngle(o.heading - arrive));
    } else {
      score += Math.abs(wrapAngle(o.heading - heading));
    }
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** The flight's state at game time t. */
export function routeState(route: Route, t: GameTime, radius: Meters): RouteState {
  const segs = route.segments;
  // The last segment starting at or before t (the first if none): a binary search, since a
  // route with a terrain floor has dozens of segments (terrainFloor.ts).
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid]!.t0 > t) hi = mid - 1;
    else lo = mid;
  }
  const i = lo;
  const s = segs[i]!;
  const outside = t < s.t0 || t > s.t1;
  const dt = Math.min(Math.max(t - s.t0, 0), s.t1 - s.t0);
  const f = s.t1 > s.t0 ? dt / (s.t1 - s.t0) : 1;
  const altitude = s.alt0 + (s.alt1 - s.alt0) * f;
  const fuel = s.fuel0 - s.flow * dt;
  const base = { altitude, fuel, phase: s.phase, segment: outside ? -1 : i };
  if (s.kind === 'ground') {
    const landed = !outside && s.phase !== 'departure' && s.phase !== 'recovery';
    return { ...base, point: [...s.a], heading: s.heading, speed: 0, airborne: false, landed };
  }
  if (s.kind === 'orbit') {
    const o = orbitPoint(s.a, s.b, s.turn, (s.around ?? 0) + s.speed * dt, radius);
    return {
      ...base,
      point: o.point,
      heading: o.heading,
      speed: s.speed,
      airborne: !outside,
      landed: false,
    };
  }
  const point = slerp(s.a, s.b, f);
  const end = f < 1 ? s.b : point;
  const heading =
    f < 1 ? initialHeading(point, end) : (initialHeading(s.b, s.a) + Math.PI) % (2 * Math.PI);
  return { ...base, point, heading, speed: s.speed, airborne: !outside, landed: false };
}

/** Time spent at each phase start, in route order (the route's phase timeline). */
export function routeTimeline(route: Route): { phase: MissionPhase; time: GameTime }[] {
  const out: { phase: MissionPhase; time: GameTime }[] = [];
  for (const s of route.segments) {
    if (out[out.length - 1]?.phase !== s.phase) out.push({ phase: s.phase, time: s.t0 });
  }
  const last = route.segments[route.segments.length - 1]!;
  out.push({ phase: 'complete', time: last.t1 });
  return out;
}

/** Fuel per aircraft left at the end of the route (kg). */
export function routeEndFuel(route: Route): number {
  const s = route.segments[route.segments.length - 1]!;
  return s.fuel0 - s.flow * (s.t1 - s.t0);
}

export function routeFeasible(route: Route): boolean {
  return routeEndFuel(route) >= route.reserve - 1e-6;
}

/**
 * Builds a route segment by segment from a start point and time, tracking
 * position, altitude and fuel. `flow` is the type's cruise flow with its
 * loadout (aircraft.ts cruiseFlow); `fuel` the load after the range factor.
 */
export class RouteBuilder {
  readonly segments: RouteSegment[] = [];
  point: Dir;
  altitude = 0;
  time: GameTime;
  fuel: number;
  heading = 0;
  /** Winds aloft for leg ground speeds (R2.1); null: airspeed is ground speed. */
  wind: WindSource | null = null;

  constructor(
    readonly type: AircraftType,
    readonly radius: Meters,
    readonly cruiseFlow: number,
    start: Readonly<Dir>,
    t0: GameTime,
    fuel: number,
  ) {
    this.point = [...start];
    this.time = t0;
    this.fuel = fuel;
  }

  private push(s: Omit<RouteSegment, 'fuel0' | 'flow'>): void {
    const flow = this.cruiseFlow * FLOW[s.regime];
    this.segments.push({ ...s, fuel0: this.fuel, flow });
    this.fuel -= flow * (s.t1 - s.t0);
    this.time = s.t1;
  }

  /** Holds on the ground at the current point for `duration` (s). */
  ground(duration: number, phase: MissionPhase, heading = this.heading): this {
    this.altitude = 0;
    this.push({
      kind: 'ground',
      phase,
      regime: 'ground',
      t0: this.time,
      t1: this.time + duration,
      a: [...this.point],
      b: [...this.point],
      alt0: 0,
      alt1: 0,
      speed: 0,
      turn: 0,
      heading,
    });
    return this;
  }

  /** A straight leg to `to`, changing altitude linearly to `alt`. */
  leg(
    to: Readonly<Dir>,
    alt: number,
    speed: number,
    regime: FlowRegime,
    phase: MissionPhase,
  ): this {
    const d = arcDistance(this.point, to, this.radius);
    if (d < 1) return this;
    this.heading = initialHeading(this.point, to);
    if (this.wind) {
      const mid = slerp(this.point, to, 0.5);
      speed = groundSpeed(
        speed,
        initialHeading(mid, to),
        this.wind(mid, (this.altitude + alt) / 2),
      );
    }
    this.push({
      kind: 'leg',
      phase,
      regime,
      t0: this.time,
      t1: this.time + d / speed,
      a: [...this.point],
      b: [...to],
      alt0: this.altitude,
      alt1: alt,
      speed,
      turn: 0,
      heading: this.heading,
    });
    this.point = [...to];
    this.altitude = alt;
    return this;
  }

  /**
   * Climbs (or descends) toward `to` at the type's climb rate until `alt`, then
   * stops; if `to` comes first, the change finishes there.
   */
  changeAltitudeToward(
    to: Readonly<Dir>,
    alt: number,
    speed: number,
    regime: FlowRegime,
    phase: MissionPhase,
  ): this {
    const dh = Math.abs(alt - this.altitude);
    if (dh < 1) return this;
    const rate = regime === 'descent' ? Math.max(this.type.climbRate, 15) : this.type.climbRate;
    const need = (dh / rate) * speed;
    const d = arcDistance(this.point, to, this.radius);
    const end = need < d ? toward(this.point, to, need, this.radius) : to;
    return this.leg(end, alt, speed, regime, phase);
  }

  /** A racetrack centered at c with its axis along `heading`, for `duration` (s), entered from the current point. */
  orbit(
    c: Readonly<Dir>,
    heading: number,
    duration: number,
    speed: number,
    phase: MissionPhase,
  ): this {
    const turn = this.type.helicopter ? HELICOPTER_ORBIT_TURN : ORBIT_TURN;
    const ahead = destination(c, heading, 10e3, this.radius);
    const around = orbitJoin(c, ahead, turn, this.point, this.heading, this.radius);
    const entry = orbitPoint(c, ahead, turn, around, this.radius).point;
    this.leg(entry, this.altitude, speed, 'cruise', phase);
    const t0 = this.time;
    this.push({
      kind: 'orbit',
      phase,
      regime: 'loiter',
      t0,
      t1: t0 + duration,
      a: [...c],
      b: ahead,
      alt0: this.altitude,
      alt1: this.altitude,
      speed,
      turn,
      around,
      heading,
    });
    const end = orbitPoint(c, ahead, turn, around + speed * duration, this.radius);
    this.point = end.point;
    this.heading = end.heading;
    return this;
  }

  /** The point `distance` ahead along the current heading. */
  ahead(distance: number): Dir {
    return destination(this.point, this.heading, distance, this.radius);
  }

  /** Unit tangent of the current heading. */
  tangent(): Dir {
    return headingTangent(this.point, this.heading);
  }

  build(startFuel: number): Route {
    return { segments: this.segments, fuel: startFuel, reserve: startFuel * FUEL_RESERVE };
  }
}

/**
 * The route as flown until game time `t`: the segments before it, and the current
 * one cut at `t` (an orbit keeps its center and axis; routeState stops at t1).
 */
export function routeBefore(route: Route, t: GameTime, radius: Meters): RouteSegment[] {
  const s = routeState(route, t, radius);
  const kept: RouteSegment[] = [];
  for (const seg of route.segments) {
    if (seg.t1 <= t) {
      kept.push(seg);
      continue;
    }
    if (seg.t0 < t) {
      const cut = { ...seg, t1: t };
      if (seg.kind === 'leg') {
        cut.b = [...s.point];
        cut.alt1 = s.altitude;
      } else if (seg.kind === 'ground') {
        cut.alt1 = 0;
      }
      kept.push(cut);
    }
    break;
  }
  return kept;
}

/** The route's cruise flow with its loadout (kg/s), from any segment that burns fuel. */
export function routeCruiseFlow(route: Route): number {
  const burning = route.segments.find((x) => FLOW[x.regime] > 0);
  return burning ? burning.flow / FLOW[burning.regime] : 0;
}

/**
 * The route cut at game time `t` and turned home (an abort, R2.2): the segments
 * before `t` as flown, the current one cut at `t`, then a climb or descent to
 * cruise altitude toward `home`, cruise, the approach and the recovery on the
 * ground. Fuel carries on from the cut. A flight on the ground at `t` stays
 * there and ends.
 */
export function returnRoute(
  route: Route,
  t: GameTime,
  home: Readonly<Dir>,
  type: AircraftType,
  radius: Meters,
  recovery: number,
  /**
   * Turns the builder from the flight's heading toward home through a real radius
   * (missionRoute.ts's `turnToward` at the rejoin's bank, decision 281); without it the
   * way home starts at a corner, as before.
   */
  turn?: (b: RouteBuilder, home: Readonly<Dir>) => void,
): Route {
  const s = routeState(route, t, radius);
  const kept = routeBefore(route, t, radius);
  const flow = routeCruiseFlow(route);
  const b = new RouteBuilder(type, radius, flow, s.point, t, s.fuel);
  b.altitude = s.altitude;
  b.heading = s.heading;
  if (!s.airborne && s.altitude <= 0 && arcDistance(s.point, home, radius) < 5e3) {
    b.ground(recovery, 'recovery');
  } else {
    const alt = type.cruiseAltitude;
    if (s.airborne) turn?.(b, home);
    b.changeAltitudeToward(home, alt, type.cruiseSpeed * 0.7, 'climb', 'egress');
    const rate = Math.max(type.climbRate, 15);
    const descent = (b.altitude / rate) * type.cruiseSpeed * 0.8;
    const d = arcDistance(b.point, home, radius);
    if (d > descent) {
      b.leg(
        toward(b.point, home, d - descent, radius),
        b.altitude,
        type.cruiseSpeed,
        'cruise',
        'egress',
      );
    }
    b.leg(home, 0, type.cruiseSpeed * 0.8, 'descent', 'approach');
    b.ground(recovery, 'recovery');
  }
  return { segments: [...kept, ...b.segments], fuel: route.fuel, reserve: route.reserve };
}
