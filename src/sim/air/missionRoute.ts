/**
 * Plans a mission's route from its profile (mission.ts) and the aircraft type:
 * departure, climb-out, ingress to the fence-in point, fence-in, on target
 * or on station, egress, approach and recovery (design, "Mission Types").
 *
 * - **Climb-out** climbs toward the target at the type's climb rate and
 *   CLIMB_SPEED of cruise speed until cruise altitude.
 * - **Fence-in** starts FENCE_IN before the target (LOW_FENCE_IN for low-level
 *   profiles, which descend there to LOW_ALTITUDE and fly at low-level speed).
 * - **On target:** a pass flies PASS_HALF before the target to PASS_HALF past
 *   it at combat power; an orbit holds a racetrack on the station; a landing
 *   stops on the ground at the destination.
 * - **Egress** stays low for LOW_EGRESS after a low-level attack, climbs back
 *   to cruise altitude, and cruises home until the descent point.
 * - **Approach** descends at the climb rate (at least MIN_DESCENT_RATE) and
 *   DESCENT_SPEED of cruise speed to the recovery base.
 * - **Station time** is the profile's wanted time, cut to what the fuel allows;
 *   below the profile's least time the plan fails (returns null).
 * - **Carriers.** The recovery point is the group's predicted position at the
 *   landing time, found by planning twice (the group moves slowly, so the
 *   second plan's landing time is within seconds of the first).
 */
import type { Dir } from '../../core/greatCircle';
import { arcDistance, destination, initialHeading, toward } from '../../core/greatCircle';
import { MINUTE } from '../../core/units';
import type { GameTime, Meters } from '../../core/units';
import { cruiseFlow, FLOW } from './aircraft';
import type { AircraftType, Loadout } from './aircraft';
import type { MissionProfile } from './mission';
import { RouteBuilder, routeEndFuel, routeFeasible } from './route';
import type { Route } from './route';

export const FENCE_IN = 40e3;
export const LOW_FENCE_IN = 120e3;
export const LOW_EGRESS = 60e3;
export const PASS_HALF = 10e3;
/** Low-level altitude for jets and helicopters (m). Terrain following comes with the execution layer (V4, P1). */
export const LOW_ALTITUDE = 100;
export const HELICOPTER_LOW_ALTITUDE = 30;
export const CLIMB_SPEED = 0.7;
export const DESCENT_SPEED = 0.8;
export const LOITER_SPEED = 0.85;
export const MIN_DESCENT_RATE = 15;

export interface RoutePlanInput {
  type: AircraftType;
  loadout: Loadout;
  profile: MissionProfile;
  radius: Meters;
  rangeFactor: number;
  /** Where the flight starts and ends at a given game time (airbases ignore the time). */
  basePoint: (t: GameTime) => Dir;
  carrierBased: boolean;
  target: Readonly<Dir>;
  launch: GameTime;
  /** Upper bound on station time (s); the profile's wanted time if absent. */
  stationTime?: number;
  /** Racetrack axis heading for orbits (rad); toward the base's side by default. */
  orbitHeading?: number;
}

/** Ground time before takeoff (taxi, takeoff, join-up) and after landing (s). */
function groundTimes(t: AircraftType, carrier: boolean): { departure: number; recovery: number } {
  if (t.helicopter) return { departure: 3 * MINUTE, recovery: 3 * MINUTE };
  if (carrier) return { departure: 12 * MINUTE, recovery: 10 * MINUTE };
  const heavy = t.crew >= 3;
  return { departure: (heavy ? 12 : 6) * MINUTE, recovery: (heavy ? 12 : 8) * MINUTE };
}

function build(p: RoutePlanInput, stationTime: number, recovery: Dir): Route {
  const t = p.type;
  const R = p.radius;
  const flow = cruiseFlow(t, p.loadout.radiusFactor);
  const fuel = t.fuel * p.rangeFactor;
  const start = p.basePoint(p.launch);
  const g = groundTimes(t, p.carrierBased);
  const b = new RouteBuilder(t, R, flow, start, p.launch, fuel);
  const cruise = t.cruiseSpeed;
  const low = p.profile.low;
  const lowAlt = t.helicopter ? HELICOPTER_LOW_ALTITUDE : LOW_ALTITUDE;
  const cruiseAlt = t.cruiseAltitude;
  const target = p.target;

  b.heading = initialHeading(start, target);
  b.ground(g.departure, 'departure');
  b.changeAltitudeToward(target, cruiseAlt, cruise * CLIMB_SPEED, 'climb', 'climb-out');

  // Ingress to the fence-in point, unless the climb already ended inside it.
  const fence = low ? LOW_FENCE_IN : FENCE_IN;
  if (arcDistance(b.point, target, R) > fence) {
    b.leg(toward(target, b.point, fence, R), cruiseAlt, cruise, 'cruise', 'ingress');
  }

  // Fence-in to the attack, the station or the destination.
  const station = p.profile.station;
  if (low) b.changeAltitudeToward(target, lowAlt, cruise, 'descent', 'fence-in');
  const inSpeed = low ? t.lowLevelSpeed : cruise;
  const inAlt = low ? lowAlt : b.altitude;
  const inRegime = low ? 'lowLevel' : 'cruise';
  if (station === 'pass') {
    if (arcDistance(b.point, target, R) > PASS_HALF) {
      b.leg(toward(target, b.point, PASS_HALF, R), inAlt, inSpeed, inRegime, 'fence-in');
    }
    const heading = initialHeading(b.point, target);
    b.leg(target, inAlt, inSpeed, 'combat', 'on-target');
    b.leg(destination(target, heading, PASS_HALF, R), inAlt, inSpeed, 'combat', 'on-target');
  } else if (station === 'orbit') {
    if (arcDistance(b.point, target, R) > 15e3) {
      b.leg(toward(target, b.point, 15e3, R), inAlt, inSpeed, inRegime, 'fence-in');
    }
    const axis = p.orbitHeading ?? initialHeading(target, start);
    b.orbit(target, axis, stationTime, cruise * LOITER_SPEED, 'on-target');
  } else {
    // Land at the destination: descend on the way in, stop, take off again.
    b.changeAltitudeToward(target, 0, cruise * DESCENT_SPEED, 'descent', 'fence-in');
    b.leg(target, 0, cruise * DESCENT_SPEED, 'descent', 'fence-in');
    b.heading = initialHeading(target, recovery);
    b.ground(stationTime, 'on-target');
  }

  // Egress: low for a while after a low attack, back up to cruise altitude, home.
  if (low && station !== 'land' && arcDistance(b.point, recovery, R) > LOW_EGRESS) {
    b.leg(toward(b.point, recovery, LOW_EGRESS, R), lowAlt, t.lowLevelSpeed, 'lowLevel', 'egress');
  }
  b.changeAltitudeToward(recovery, cruiseAlt, cruise * CLIMB_SPEED, 'climb', 'egress');
  const rate = Math.max(t.climbRate, MIN_DESCENT_RATE);
  const descentDistance = (b.altitude / rate) * cruise * DESCENT_SPEED;
  const home = arcDistance(b.point, recovery, R);
  if (home > descentDistance) {
    b.leg(
      toward(b.point, recovery, home - descentDistance, R),
      b.altitude,
      cruise,
      'cruise',
      'egress',
    );
  }
  b.leg(recovery, 0, cruise * DESCENT_SPEED, 'descent', 'approach');
  b.heading = initialHeading(start, target);
  b.ground(g.recovery, 'recovery');
  return b.build(fuel);
}

/** Recovery point for a draft route: the base at the draft's landing time. */
function recoveryFor(p: RoutePlanInput, draft: Route | null): Dir {
  if (!p.carrierBased || !draft) return p.basePoint(p.launch);
  const landing = draft.segments.find((s) => s.phase === 'recovery')?.t0 ?? p.launch;
  return p.basePoint(landing);
}

function planOnce(p: RoutePlanInput, stationTime: number): Route {
  let recovery = recoveryFor(p, null);
  let route = build(p, stationTime, recovery);
  if (p.carrierBased) {
    recovery = recoveryFor(p, route);
    route = build(p, stationTime, recovery);
  }
  return route;
}

/** The mission's route, or null if the fuel does not reach (with the least station time). */
export function planMissionRoute(p: RoutePlanInput): Route | null {
  const [least, wanted] = p.profile.stationTime;
  let stationTime = Math.min(wanted, p.stationTime ?? wanted);
  if (stationTime < least) stationTime = least;
  let route = planOnce(p, stationTime);
  if (routeFeasible(route)) return route;
  if (p.profile.station !== 'orbit') return null;
  // Cut the station time by the shortfall at loiter flow.
  const flow = cruiseFlow(p.type, p.loadout.radiusFactor) * FLOW.loiter;
  const short = route.reserve - routeEndFuel(route);
  stationTime -= short / flow + 1;
  if (stationTime < least) return null;
  route = planOnce(p, stationTime);
  return routeFeasible(route) ? route : null;
}

/** Time the route reaches the target or the station (its first on-target segment). */
export function timeOnTarget(route: Route): GameTime {
  return route.segments.find((s) => s.phase === 'on-target')?.t0 ?? NaN;
}
