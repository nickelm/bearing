/**
 * Energy on the approach (decision 207): the cues that tell a pilot whether the jet will slow
 * down in time. Pure functions of the flight spec and the aircraft's state, shared by the HUD
 * and the tests.
 *
 * - **Approach speed:** the calibrated airspeed of 1 g at on-speed angle of attack (13°) in
 *   the landing configuration (gear and flaps down) at the present weight: the speed bug.
 * - **Distance to slow:** level flight at idle from the present speed to the approach speed
 *   with the speedbrake out, as the procedure flies it: 60° with the gear up above the gear
 *   limit, then gear down and 43°. The engine is taken at idle at once, the gear and
 *   speedbrake at their stops, the drag from `drag.ts`, the model's own.
 * - **The approach energy cue** flies the approach on paper at idle with the speedbrake: level
 *   to the glide path (or down to it from above), then down it, and compares the distance it
 *   takes to slow to the approach speed with the distance left to the stabilization gate,
 *   5 km out: green (it makes it with a fifth to spare), amber (marginal), red (it cannot).
 *   The gate, not the intercept, ends it: at idle on the 3° path the jet keeps slowing (its
 *   idle glide is about 6°), so slowing before the intercept asks too much (decision 207).
 */
import { DEG, KNOT } from '../../core/units';
import {
  calibratedAirspeed,
  G0,
  SEA_LEVEL_DENSITY,
  standardAtmosphere,
  trueAirspeed,
} from './atmosphere';
import { dragCoefficient, emptyDrag, speedbrakeShare } from './drag';
import { lookup, lookup2 } from './flightSpec';
import type { FlightSpec } from './flightSpec';
import { AIM_POINT, GLIDE_PATH } from './runway';

/** On-speed angle of attack: the middle of the HUD's angle-of-attack bracket (decision 208). */
export const ON_SPEED_ALPHA = 13 * DEG;
/** Within this much over the approach speed the aircraft counts as slowed (m/s). */
export const ON_SPEED_MARGIN = 5 * KNOT;
/** The cue is green while the distance to slow is under this share of the distance left. */
export const ENERGY_MARGIN = 0.8;

/** Approach speed (CAS, m/s) at `mass` kg: 1 g at `alpha` with gear and flaps down. */
export function approachSpeed(spec: FlightSpec, mass: number, alpha = ON_SPEED_ALPHA): number {
  const cl = lookup(spec.aero.cl, alpha) + spec.aero.flapCl;
  return Math.sqrt((2 * mass * G0) / (SEA_LEVEL_DENSITY * spec.wing.area * cl));
}

/**
 * Horizontal distance (m) to slow from `fromCas` to `toCas` (m/s) in level flight at
 * `altitude` m at idle with the speedbrake, as above; Infinity if the jet cannot slow there.
 */
export function distanceToSlow(
  spec: FlightSpec,
  mass: number,
  altitude: number,
  fromCas: number,
  toCas: number,
): number {
  if (fromCas <= toCas) return 0;
  const air = standardAtmosphere(altitude);
  const S = spec.wing.area;
  const W = mass * G0;
  const sb = spec.speedbrake;
  const th = spec.engine.thrust;
  const terms = emptyDrag();
  const dt = 0.25;
  let tas = trueAirspeed(fromCas, air);
  let dist = 0;
  for (let i = 0; i < 4000; i++) {
    const cas = calibratedAirspeed(tas, air);
    if (cas <= toCas) return dist;
    const gearDown = cas <= spec.gear.maxSpeed;
    const delta = gearDown ? sb.gearDownDeflection : sb.maxDeflection;
    const q = 0.5 * air.density * tas * tas;
    const mach = tas / air.speedOfSound;
    const cl = W / (q * S);
    const cd = dragCoefficient(
      spec,
      {
        cl,
        alpha: 0,
        mach,
        gear: gearDown ? 1 : 0,
        flaps: gearDown ? 1 : 0,
        gearDamaged: false,
        speedbrake: speedbrakeShare(spec, delta),
        groundEffect: 0,
      },
      terms,
    );
    const thrust = lookup2(th.altitude, th.mach, th.idle, altitude, mach);
    const decel = (q * S * cd - thrust) / mass;
    if (decel <= 0) return Infinity;
    tas -= decel * dt;
    dist += tas * dt;
  }
  return Infinity;
}

export type EnergyState = 'ok' | 'marginal' | 'short';

/** The stabilization gate: on speed on the glide path this far before the threshold (m). */
export const STABLE_GATE = 5000;
/** Steepest descent (rad) the cue's plan flies to rejoin the glide path from above. */
export const REJOIN_DESCENT = 6 * DEG;

export interface ApproachEnergy {
  /** Approach speed (CAS, m/s), the distance to slow to it and the distance left to the gate (m). */
  approach: number;
  needed: number;
  available: number;
  state: EnergyState;
}

/**
 * The approach energy cue for an aircraft of `mass` kg at `cas` m/s, `toAim` m before the aim
 * point (along the runway) and `height` m above the runway at `elevation` m.
 *
 * The distance needed is flown on paper at idle with the speedbrake (60° gear up above the gear
 * limit, then gear down and 43°): level to the glide path from below, down at up to 6° to it
 * from above, then down the 3° path, the drag taking the energy and the descent giving some
 * back, until the speed is down to the approach speed. The distance available runs to the
 * stabilization gate, 5 km before the threshold (decision 207).
 */
export function approachEnergy(
  spec: FlightSpec,
  mass: number,
  elevation: number,
  cas: number,
  toAim: number,
  height: number,
): ApproachEnergy {
  const approach = approachSpeed(spec, mass);
  const available = toAim - (STABLE_GATE + AIM_POINT);
  let needed = 0;
  if (cas > approach + ON_SPEED_MARGIN)
    needed = planToSlow(spec, mass, elevation, cas, approach, toAim, height);
  const state: EnergyState =
    needed === 0 || (available > 0 && needed <= ENERGY_MARGIN * available)
      ? 'ok'
      : needed <= available
        ? 'marginal'
        : 'short';
  return { approach, needed, available, state };
}

/** The distance flown (m) in `approachEnergy`'s plan until the speed is down to `toCas`; Infinity if never before the aim point. */
function planToSlow(
  spec: FlightSpec,
  mass: number,
  elevation: number,
  fromCas: number,
  toCas: number,
  toAim: number,
  height: number,
): number {
  const S = spec.wing.area;
  const W = mass * G0;
  const sb = spec.speedbrake;
  const th = spec.engine.thrust;
  const terms = emptyDrag();
  const tanGs = Math.tan(GLIDE_PATH);
  const tanRejoin = Math.tan(REJOIN_DESCENT);
  const dx = 100;
  let x = toAim;
  let h = height;
  let air = standardAtmosphere(elevation + h);
  let tas = trueAirspeed(fromCas, air);
  // Specific energy (J/kg) over the runway.
  let energy = 0.5 * tas * tas + G0 * h;
  let flown = 0;
  while (x > 0) {
    const cas = calibratedAirspeed(tas, air);
    if (cas <= toCas) return flown;
    const gearDown = cas <= spec.gear.maxSpeed;
    const delta = gearDown ? sb.gearDownDeflection : sb.maxDeflection;
    const q = 0.5 * air.density * tas * tas;
    const mach = tas / air.speedOfSound;
    const cd = dragCoefficient(
      spec,
      {
        cl: W / (q * S),
        alpha: 0,
        mach,
        gear: gearDown ? 1 : 0,
        flaps: gearDown ? 1 : 0,
        gearDamaged: false,
        speedbrake: speedbrakeShare(spec, delta),
        groundEffect: 0,
      },
      terms,
    );
    const thrust = lookup2(th.altitude, th.mach, th.idle, elevation + h, mach);
    energy -= ((q * S * cd - thrust) / mass) * dx;
    x -= dx;
    flown += dx;
    // The plan: level until the glide path from below, down to it from above, then along it.
    const gs = x * tanGs;
    h = h <= gs ? Math.min(h, gs) : Math.max(gs, h - dx * tanRejoin);
    air = standardAtmosphere(elevation + h);
    const kinetic = energy - G0 * h;
    if (kinetic <= 0) return flown;
    tas = Math.sqrt(2 * kinetic);
  }
  return Infinity;
}
