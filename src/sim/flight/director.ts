/**
 * The flight director's interface (Proposal 0002, Controls; Proposal 0004;
 * decision 156): what every director takes and gives, for fixed-wing aircraft
 * and helicopters alike. A director turns a desired course, flight path, speed
 * and, for a helicopter, heading, ground velocity and height into the
 * airframe's controls; it never moves the aircraft itself (rule 12). Mouse aim,
 * scripted test pilots and the AI all fly through one.
 *
 * The fixed-wing director (flightDirector.ts) reads the course, flight path and
 * speed and ignores the rotary-wing fields. The helicopters' director
 * (rotor/heloDirector.ts) reads them all.
 */
import type { Vec3d } from '../../core/vec3d';
import type { Airframe } from './airframe';
import type { RigidBodyState } from './rigidBody';
import { headingOf } from './runway';

/** A velocity over the ground in the local frame at the aircraft (m/s). */
export interface GroundVelocity {
  north: number;
  east: number;
  /** + climbing. */
  up: number;
}

/** A height to hold instead of a flight path: above sea level, or above the ground. */
export interface HeightHold {
  reference: 'altitude' | 'radar';
  /** Meters above sea level, or above the ground under the aircraft. */
  value: number;
}

export interface DirectorTarget {
  /** Course over the ground (rad, clockwise from north). */
  course: number;
  /** Flight path angle (rad, + climbing). */
  gamma: number;
  /** Calibrated airspeed to hold (m/s), or null to leave the throttle (or collective) alone. */
  speed: number | null;
  /** Bank limit (rad); default 60°. */
  maxBank?: number;
  /** Turn-rate limit (rad/s); default 12°/s. */
  maxTurnRate?: number;
  /**
   * Most load factor (g) the path change may add to or take from the path's own
   * cos γ / cos(bank); default 0.6 g, so a gentle descent is not a push to 0.2 g.
   */
  maxLoadDelta?: number;
  /** Whether the throttle may enter the afterburner. */
  afterburner?: boolean;
  /**
   * The most throttle lever it may take (1 with the afterburner allowed, military power
   * without, if absent): a rejoin's afterburner stage (decision 310), a lead's margin below
   * military power (decision 311).
   */
  maxLever?: number;

  // ---- Rotary-wing (Proposal 0004); a fixed-wing director ignores these. ----

  /**
   * Nose heading (rad, clockwise from north), separate from the course: pedal
   * turns, sideward and rearward flight, pointing a gun. Absent: the nose
   * follows the course at speed and holds its heading in the hover.
   */
  heading?: number;
  /**
   * Velocity over the ground to fly (hover, hover taxi, sideward flight). When
   * present it replaces course, flight path and speed.
   */
  groundVelocity?: GroundVelocity;
  /**
   * A world point (planet-centered m) to hover over: the director flies its
   * ground velocity toward it and holds it there. Takes precedence over
   * `groundVelocity`'s horizontal part.
   */
  hoverPoint?: Readonly<Vec3d>;
  /** A height to hold (nap of the earth with `radar`); replaces the flight path's vertical part. */
  height?: HeightHold;
}

/**
 * A flight director for airframe `A` with controls `C`. `fly` writes the
 * controls it decides into `ctl` for one step of `dt` s and leaves the rest
 * (brakes, gear, switches) as they are.
 */
export interface Director<A extends Airframe = Airframe, C = unknown> {
  /** Forgets integrators and holds, e.g. after a respawn or a handback. */
  reset(): void;
  fly(model: A, target: Readonly<DirectorTarget>, ctl: C, dt: number): void;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Course and flight path angle from the aircraft toward world point `point`. */
export function toward(
  model: Readonly<Pick<RigidBodyState, 'pos'>>,
  point: Readonly<Vec3d>,
): { course: number; gamma: number } {
  const up = model.pos.clone().normalize();
  const d = point.clone().sub(model.pos);
  const n = d.length() || 1;
  return { course: headingOf(up, d), gamma: Math.asin(clamp(d.dot(up) / n, -1, 1)) };
}

/** Course and flight path angle of world direction `dir` at the aircraft. */
export function along(
  model: Readonly<Pick<RigidBodyState, 'pos'>>,
  dir: Readonly<Vec3d>,
): { course: number; gamma: number } {
  const up = model.pos.clone().normalize();
  const n = dir.length() || 1;
  return { course: headingOf(up, dir), gamma: Math.asin(clamp(dir.dot(up) / n, -1, 1)) };
}
