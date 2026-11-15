/**
 * The rigid body every airframe flies as (track H, decision 154): state on the
 * non-rotating planet, gravity, Euler's equations with a diagonal inertia, the
 * semi-implicit integrator, attitude from heading, pitch and bank, and the
 * attitude and speed telemetry. The Kestrel's `FlightModel` and, later, the
 * helicopters' rotorcraft model share it, so they integrate the same way.
 *
 * Bit-identity with the model before the split (tests/flightLockstep.test.ts):
 * the expressions here are the ones `FlightModel` evaluated inline, with the
 * same operands in the same order. Do not reassociate them.
 */
import { Quatd } from '../../core/quat';
import { Vec3d } from '../../core/vec3d';
import { G0 } from './atmosphere';
import { headingOf } from './runway';

/** Fixed step of the flight models (s) and its substeps. */
export const FLIGHT_STEP = 1 / 120;
export const SUBSTEPS = 4;

/** Principal moments of inertia about body x, y, z (kg·m²). */
export type Inertia = readonly [number, number, number];

/** What the integrator and the attitude telemetry read and write. */
export interface RigidBodyState {
  /** The planet's radius (m). */
  readonly radius: number;
  /** CG position and velocity (world, float64 m and m/s; CLAUDE.md rule 3). */
  readonly pos: Vec3d;
  readonly vel: Vec3d;
  /** Body-to-world rotation; body axes x forward, y right, z down. */
  readonly q: Quatd;
  /** Body rates p, q, r (rad/s). */
  readonly omega: Vec3d;
  /** Velocity of the air at the aircraft (world, m/s), set by the owner before a step (wind.ts). */
  readonly wind: Vec3d;
  /** Game seconds flown, advanced per substep. */
  time: number;
}

/** Attitude, speeds and altitude, from the state alone. */
export interface AttitudeTelemetry {
  /** Compass heading, pitch and bank of the body axes (rad). */
  heading: number;
  pitch: number;
  bank: number;
  /** Flight path angle (rad). */
  gamma: number;
  /** Vertical speed (m/s, + up) and ground speed (m/s). */
  verticalSpeed: number;
  groundSpeed: number;
  /** Altitude above sea level (m). */
  altitude: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Model frame (+x forward, +y up, +z starboard) relative to the CG → body axes (x, y right, z down). */
export function modelToBody(
  p: readonly [number, number, number],
  cg: readonly [number, number, number],
): Vec3d {
  return new Vec3d(p[0] - cg[0], p[2] - cg[2], -(p[1] - cg[1]));
}

/** Gravity (m/s²) at distance `r` from the center of a planet of radius `R`: g₀·(R/r)². */
export function gravityAt(R: number, r: number): number {
  return G0 * (R / r) * (R / r);
}

/** The air's velocity relative to the body, in body axes, into `out`; `tmp` is scratch. */
export function airVelocityBody(b: Readonly<RigidBodyState>, tmp: Vec3d, out: Vec3d): Vec3d {
  return b.q.unrotate(tmp.copy(b.vel).sub(b.wind), out);
}

/** Euler's equations, I ω̇ = M − ω × Iω, for a diagonal inertia: the body's angular acceleration into `out`. */
export function eulerRates(
  inertia: Inertia,
  omega: Readonly<Vec3d>,
  mx: number,
  my: number,
  mz: number,
  out: Vec3d,
): Vec3d {
  const [ixx, iyy, izz] = inertia;
  const p = omega.x;
  const qr = omega.y;
  const rr = omega.z;
  const dp = (mx - (izz - iyy) * qr * rr) / ixx;
  const dq = (my - (ixx - izz) * rr * p) / iyy;
  const dr = (mz - (iyy - ixx) * p * qr) / izz;
  return out.set(dp, dq, dr);
}

/**
 * One substep of semi-implicit Euler: the world force `fWorld` (N) on `mass`
 * (kg) changes the velocity, the new velocity moves the body, the angular
 * acceleration `rates` (rad/s², eulerRates) changes the body rates, and the new
 * rates turn the attitude. Advances the body's time.
 */
export function integrate(
  b: RigidBodyState,
  fWorld: Readonly<Vec3d>,
  mass: number,
  rates: Readonly<Vec3d>,
  dt: number,
): void {
  const p = b.omega.x;
  const qr = b.omega.y;
  const rr = b.omega.z;
  b.vel.addScaled(fWorld, dt / mass);
  b.pos.addScaled(b.vel, dt);
  b.omega.set(p + rates.x * dt, qr + rates.y * dt, rr + rates.z * dt);
  b.q.integrateBodyRates(b.omega.x, b.omega.y, b.omega.z, dt);
  b.time += dt;
}

/**
 * The body-to-world rotation at world position `pos` for body axes from
 * `heading` (rad, clockwise from north), `pitch` and `bank` (+ right wing down),
 * into `out`.
 */
export function attitudeQuat(
  pos: Readonly<Vec3d>,
  heading: number,
  pitch: number,
  bank: number,
  out: Quatd,
): Quatd {
  const up = pos.clone().normalize();
  const east = new Vec3d(0, 1, 0).cross(up);
  if (east.length() < 1e-9) east.set(1, 0, 0);
  east.normalize();
  const north = up.clone().cross(east);
  const h = east.clone().scale(Math.sin(heading)).addScaled(north, Math.cos(heading));
  const fwd = h.clone().scale(Math.cos(pitch)).addScaled(up, Math.sin(pitch));
  const right0 = fwd.clone().cross(up).normalize();
  const up0 = right0.clone().cross(fwd).normalize();
  // Bank turns the right wing down for positive bank.
  const right = right0.clone().scale(Math.cos(bank)).addScaled(up0, -Math.sin(bank));
  const down = fwd.clone().cross(right).normalize();
  return out.copy(Quatd.fromAxes(fwd, right, down));
}

/** Body axis `axis` (0 x forward, 1 y right, 2 z down) of rotation `q` in world coordinates, into `out`; `tmp` is scratch. */
export function bodyAxisOf(q: Readonly<Quatd>, axis: 0 | 1 | 2, tmp: Vec3d, out: Vec3d): Vec3d {
  const v = tmp.set(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  return q.rotate(v, out);
}

/**
 * Writes the attitude, speeds and altitude of body `b` into `tel`; returns the
 * local up (a new vector), for the caller's radar altitude. `tmp` is scratch.
 */
export function attitudeTelemetry(
  b: Readonly<RigidBodyState>,
  tel: AttitudeTelemetry,
  tmp: Vec3d,
): Vec3d {
  const up = b.pos.clone().normalize();
  const fwd = bodyAxisOf(b.q, 0, tmp, new Vec3d());
  const right = bodyAxisOf(b.q, 1, tmp, new Vec3d());
  tel.heading = headingOf(up, fwd);
  tel.pitch = Math.asin(clamp(fwd.dot(up), -1, 1));
  // Bank: the right wing's drop below the horizon, about the nose.
  const horizRight = fwd.clone().cross(up);
  const hl = horizRight.length();
  if (hl > 1e-6) {
    horizRight.scale(1 / hl);
    const upPerp = horizRight.clone().cross(fwd);
    tel.bank = Math.atan2(-right.dot(upPerp), right.dot(horizRight));
  }
  const vs = b.vel.dot(up);
  tel.verticalSpeed = vs;
  const gs2 = b.vel.lengthSq() - vs * vs;
  tel.groundSpeed = Math.sqrt(Math.max(0, gs2));
  const v = b.vel.length();
  tel.gamma = v > 0.5 ? Math.asin(clamp(vs / v, -1, 1)) : 0;
  tel.altitude = b.pos.length() - b.radius;
  return up;
}

/** Velocity (world, a new vector) of the point at `arm` from the CG (world axes): v + ω × r. */
export function pointVelocity(
  b: Readonly<Pick<RigidBodyState, 'q' | 'omega' | 'vel'>>,
  arm: Readonly<Vec3d>,
): Vec3d {
  const omegaW = b.q.rotate(b.omega, new Vec3d());
  return omegaW.cross(arm).add(b.vel);
}
