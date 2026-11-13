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
 * Winds aloft are not applied yet (ATO weather task); speeds are true
 * airspeeds used as ground speeds.
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
  /** Orbit: turn radius (m) and distance flown around the racetrack at t0. */
  turn: number;
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
}

/** Length of each straight leg of a racetrack orbit (m). */
export const ORBIT_LEG = 40e3;
/** Racetrack turn radius for jets and helicopters (m): a rate-one turn is about 3 km for a jet at 250 m/s. */
export const ORBIT_TURN = 8e3;
export const HELICOPTER_ORBIT_TURN = 2e3;

function perimeter(turn: number): number {
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

/** Racetrack position on the sphere: center c, axis toward `ahead`. */
function orbitPoint(
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

/** Where a racetrack centered at c with its axis toward `ahead` begins (its entry point). */
export function orbitEntry(
  c: Readonly<Dir>,
  ahead: Readonly<Dir>,
  turn: number,
  radius: Meters,
): Dir {
  return orbitPoint(c, ahead, turn, 0, radius).point;
}

/** The flight's state at game time t. */
export function routeState(route: Route, t: GameTime, radius: Meters): RouteState {
  const segs = route.segments;
  let i = segs.length - 1;
  // Segments are few (about ten): a linear scan from the end is fine.
  while (i > 0 && segs[i]!.t0 > t) i--;
  const s = segs[i]!;
  const outside = t < s.t0 || t > s.t1;
  const dt = Math.min(Math.max(t - s.t0, 0), s.t1 - s.t0);
  const f = s.t1 > s.t0 ? dt / (s.t1 - s.t0) : 1;
  const altitude = s.alt0 + (s.alt1 - s.alt0) * f;
  const fuel = s.fuel0 - s.flow * dt;
  const base = { altitude, fuel, phase: s.phase, segment: outside ? -1 : i };
  if (s.kind === 'ground') {
    return { ...base, point: [...s.a], heading: s.heading, speed: 0, airborne: false };
  }
  if (s.kind === 'orbit') {
    const o = orbitPoint(s.a, s.b, s.turn, s.speed * dt, radius);
    return { ...base, point: o.point, heading: o.heading, speed: s.speed, airborne: !outside };
  }
  const point = slerp(s.a, s.b, f);
  const end = f < 1 ? s.b : point;
  const heading =
    f < 1 ? initialHeading(point, end) : (initialHeading(s.b, s.a) + Math.PI) % (2 * Math.PI);
  return { ...base, point, heading, speed: s.speed, airborne: !outside };
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
    const entry = orbitEntry(c, ahead, turn, this.radius);
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
      heading,
    });
    const end = orbitPoint(c, ahead, turn, speed * duration, this.radius);
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
