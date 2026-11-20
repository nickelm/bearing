/**
 * Promotion and demotion of a campaign flight (roadmap R2.5; design, "Fidelity
 * consistency"): the aircraft of a flight the player follows or flies become
 * `FlownAircraft` from their analytic state, and fold back into the flight's
 * analytic record when the player leaves them.
 *
 * - **Promotion** takes each aircraft's pose as the simulation view draws it
 *   (the analytic route in formation, on the sited field and lifted over the drawn
 *   ground: full fidelity flies where the view draws, owner decision 8), and the
 *   flight's state from its route: fuel as the same share of the load, the gear by
 *   whether it flies, cruise power in the air. Stores are the mission's loadout with
 *   nothing expended, and no aircraft is damaged, until R2.6 gives stores and damage
 *   states to the aggregate flight; the records carry both so demotion can return them.
 * - **Demotion** reads the flown aircraft back: the aircraft still flying, those
 *   crashed (losses), and where the flight is (its lowest surviving slot, the lead
 *   when it lives), with the fuel as a share of the route's load again. The worker
 *   turns that state into a route from there (`rejoinRoute`, R2.5).
 *
 * Fuel goes by share because the two models count it differently: the air war's
 * load includes drop tanks (the F-21's 5,800 kg), the flight model's tanks hold the
 * internal fuel (3,200 kg) until R2.6 hangs tanks on pylons.
 *
 * No render, DOM or worker imports: it runs on the main thread beside the flown
 * aircraft (owner decision 1a) and headless in tests.
 */
import type { Dir } from '../../core/greatCircle';
import { DEG } from '../../core/units';
import type { GameTime, Meters } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import type { AnalyticPose } from '../air/analyticPose';
import type { Mission } from '../air/mission';
import { routeState } from '../air/route';
import { neutralControls } from './controlLaws';
import type { FlightControls } from './controlLaws';
import { FlightModel } from './flightModel';
import type { FlightSpec } from './flightSpec';
import { FlownAircraft } from './flownAircraft';
import { headingOf } from './runway';

/** What an aircraft carries (R2.6 fills it from the pylons): its loadout and what it has used. */
export interface StoresState {
  loadout: string;
  /** Stores released or fired, by store id. */
  expended: Record<string, number>;
}

/** One aircraft of a promoted flight. */
export interface PromotedAircraft {
  /** Its slot in the flight (0: the lead). */
  slot: number;
  flown: FlownAircraft<FlightControls>;
  stores: StoresState;
  /** Damage, 0 (none) .. 1 (destroyed); R2.6's damage states set it. */
  damage: number;
}

/** The mission fields promotion reads. */
export type PromotedMission = Pick<
  Mission,
  'id' | 'aircraftType' | 'aircraft' | 'loadout' | 'route' | 'expended'
>;

/** Pitch above the flight path a promoted aircraft starts at: about its 1-g angle of attack. */
export const PROMOTION_ALPHA = 3.5 * DEG;
/** Throttle a promoted aircraft starts at in the air (its laws and director take it from there). */
export const PROMOTION_POWER = 0.45;

/** Fuel in the flight model's tanks for `routeFuel` of a route loaded with `routeLoad` (kg). */
export function flightFuel(routeFuel: number, routeLoad: number, capacity: number): number {
  if (routeLoad <= 0) return 0;
  return Math.max(0, Math.min(capacity, (capacity * routeFuel) / routeLoad));
}

/** The route's fuel (kg) for `fuel` in the flight model's tanks of `capacity`. */
export function routeFuelOf(fuel: number, capacity: number, routeLoad: number): number {
  if (capacity <= 0) return 0;
  return Math.max(0, (routeLoad * fuel) / capacity);
}

/**
 * One aircraft at full fidelity from its drawn pose: placed with the pose's
 * velocity, heading, bank and flight path (plus the 1-g angle of attack in the
 * air), body rates at rest; gear down and idle on the ground, gear up and cruise
 * power in the air. Its laws settle the attitude in the first seconds.
 */
export function aircraftFromPose(
  spec: FlightSpec,
  radius: Meters,
  pose: Readonly<AnalyticPose>,
  fuel: number,
  type: string,
): FlownAircraft<FlightControls> {
  const m = new FlightModel(spec, radius);
  const pos = new Vec3d(pose.pos[0], pose.pos[1], pose.pos[2]);
  const vel = pose.airborne
    ? new Vec3d(pose.velocity[0], pose.velocity[1], pose.velocity[2])
    : new Vec3d();
  if (pose.airborne) {
    m.place(pos, vel, pose.heading, pose.pitch + PROMOTION_ALPHA, pose.bank);
  } else {
    // On the ground the CG stands at the gear's height over the drawn pose's wheels.
    const up = pos.clone().normalize();
    m.place(pos.clone().addScaled(up, m.gearHeight - 0.08), vel, pose.heading, 0, 0);
  }
  m.fuel = Math.min(spec.mass.fuel, fuel);
  m.unlimitedFuel = false;
  m.gear = pose.airborne ? 0 : 1;
  m.speedbrake = 0;
  m.power = pose.airborne ? PROMOTION_POWER : 0;
  m.afterburner = 0;
  // Long airborne, as far as the laws know: not the moment of a liftoff.
  if (pose.airborne) m.lawState.airborne = 30;
  return new FlownAircraft(m, neutralControls(), type);
}

/**
 * The flight's aircraft at full fidelity at game time t, one per pose (the
 * flight's aircraft in slot order, as the view draws them).
 */
export function promoteFlight(
  mission: Readonly<PromotedMission>,
  t: GameTime,
  radius: Meters,
  spec: FlightSpec,
  poses: readonly Readonly<AnalyticPose>[],
): PromotedAircraft[] {
  const s = routeState(mission.route, t, radius);
  const fuel = flightFuel(s.fuel, mission.route.fuel, spec.mass.fuel);
  return poses.slice(0, mission.aircraft).map((p, slot) => ({
    slot,
    flown: aircraftFromPose(spec, radius, p, fuel, mission.aircraftType),
    // What full fidelity expended before stays expended (decision 275).
    stores: { loadout: mission.loadout, expended: { ...(mission.expended?.[slot] ?? {}) } },
    damage: 0,
  }));
}

/** A promoted flight folded back (R2.5): what the worker needs to carry it on analytically. */
export interface DemotedFlight {
  mission: number;
  time: GameTime;
  /** Aircraft still flying, and those lost at full fidelity (crashed), with where and why. */
  aircraft: number;
  lost: { slot: number; point: Dir; cause: string }[];
  /** Where the flight is: its lowest surviving slot (the lead while it lives). */
  slot: number;
  point: Dir;
  /** Height above sea level (m), track (rad, clockwise from north) and ground speed (m/s). */
  altitude: Meters;
  heading: number;
  speed: number;
  /** Fuel per aircraft in the route's terms (kg): the least of the survivors. */
  fuel: number;
  airborne: boolean;
  /** Stores per surviving slot (R2.6 folds them into the flight's loadout). */
  stores: { slot: number; stores: StoresState }[];
}

/** Folds a promoted flight back into its analytic state at game time t. */
export function demoteFlight(
  mission: Readonly<PromotedMission>,
  t: GameTime,
  radius: Meters,
  aircraft: readonly PromotedAircraft[],
  /** The flight model's fuel capacity (kg; the spec's internal fuel). */
  capacity: number,
): DemotedFlight | null {
  const lost: DemotedFlight['lost'] = [];
  const alive: PromotedAircraft[] = [];
  for (const a of aircraft) {
    const m = a.flown.airframe;
    if (m.crashed || a.damage >= 1) {
      const d = m.pos.clone().normalize();
      lost.push({ slot: a.slot, point: [d.x, d.y, d.z], cause: m.crashed ?? 'damage' });
    } else alive.push(a);
  }
  const lead = alive[0];
  const base = { mission: mission.id, time: t, lost, aircraft: alive.length };
  if (!lead) return null;
  const m = lead.flown.airframe;
  const up = m.pos.clone().normalize();
  const vel = m.vel;
  const vertical = vel.dot(up);
  const speed = Math.sqrt(Math.max(0, vel.lengthSq() - vertical * vertical));
  let fuel = Infinity;
  for (const a of alive) fuel = Math.min(fuel, a.flown.airframe.fuel);
  return {
    ...base,
    slot: lead.slot,
    point: [up.x, up.y, up.z],
    altitude: m.pos.length() - radius,
    heading: speed > 1 ? headingOf(up, vel) : m.telemetry.heading,
    speed,
    fuel: routeFuelOf(fuel, capacity, mission.route.fuel),
    airborne: !m.onGround,
    stores: alive.map((a) => ({ slot: a.slot, stores: a.stores })),
  };
}
