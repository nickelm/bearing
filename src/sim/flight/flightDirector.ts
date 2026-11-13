/**
 * The flight director (Proposal 0002, Controls; decision 134): turns a desired
 * course, flight path angle and speed into stick and throttle for the flight
 * model, through the same control laws a pilot's stick goes through. Mouse aim
 * gives it the direction under the mouse; the scripted test pilot and, later,
 * AI pilots give it their own targets. It never moves the aircraft itself.
 *
 * It flies bank-to-turn: the course error sets a turn rate and the bank angle
 * of a coordinated turn at that rate; the flight path error sets a climb rate,
 * and from both the load factor (or, at low speed, the pitch rate) that the
 * stick asks for. An integrator on calibrated airspeed drives the throttle.
 */
import type { Vec3d } from '../../core/vec3d';
import { DEG } from '../../core/units';
import { SEA_LEVEL_DENSITY } from './atmosphere';
import { MIL_DETENT, pitchBlend } from './controlLaws';
import type { FlightControls } from './controlLaws';
import { lookup } from './flightSpec';
import type { FlightModel } from './flightModel';
import { headingOf } from './runway';

export interface DirectorTarget {
  /** Course over the ground (rad, clockwise from north). */
  course: number;
  /** Flight path angle (rad, + climbing). */
  gamma: number;
  /** Calibrated airspeed to hold (m/s), or null to leave the throttle alone. */
  speed: number | null;
  /** Bank limit (rad); default 60°. */
  maxBank?: number;
  /** Turn-rate limit (rad/s); default 12°/s. */
  maxTurnRate?: number;
  /** Whether the throttle may enter the afterburner. */
  afterburner?: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Course and flight path angle from the aircraft toward world point `point`. */
export function toward(
  model: FlightModel,
  point: Readonly<Vec3d>,
): { course: number; gamma: number } {
  const up = model.pos.clone().normalize();
  const d = point.clone().sub(model.pos);
  const n = d.length() || 1;
  return { course: headingOf(up, d), gamma: Math.asin(clamp(d.dot(up) / n, -1, 1)) };
}

/** Course and flight path angle of world direction `dir` at the aircraft. */
export function along(model: FlightModel, dir: Readonly<Vec3d>): { course: number; gamma: number } {
  const up = model.pos.clone().normalize();
  const n = dir.length() || 1;
  return { course: headingOf(up, dir), gamma: Math.asin(clamp(dir.dot(up) / n, -1, 1)) };
}

/**
 * The calibrated airspeed (m/s) at which the aircraft flies at 1 g and angle of
 * attack `alpha` in its current configuration: the approach speed at 13°.
 */
export function speedForAlpha(model: FlightModel, alpha = 13 * DEG): number {
  const s = model.spec;
  const cl = lookup(s.aero.cl, alpha) + s.aero.flapCl * model.gear;
  return Math.sqrt((2 * model.mass * 9.806_65) / (SEA_LEVEL_DENSITY * s.wing.area * cl));
}

export class FlightDirector {
  /** Integrated speed error (m·s/s) of the autothrottle. */
  private throttleI = 0;
  /** Gains: course → turn rate (1/s), bank error → roll rate (1/s), flight path → climb rate (1/s). */
  courseGain = 0.6;
  bankGain = 2.5;
  gammaGain = 0.8;
  throttleGain = 0.04;
  throttleIntegral = 0.006;

  reset(): void {
    this.throttleI = 0;
  }

  /** Writes pitch, roll, yaw and (with a speed) throttle into `ctl` for one step of `dt` s. */
  fly(model: FlightModel, target: Readonly<DirectorTarget>, ctl: FlightControls, dt: number): void {
    const t = model.telemetry;
    const spec = model.spec;
    const g = 9.806_65;
    const v = Math.max(t.tas, 40);
    const up = model.pos.clone().normalize();
    const track = t.groundSpeed > 10 ? headingOf(up, model.vel) : t.heading;
    // Lateral: course error → turn rate → bank of a coordinated turn.
    const maxBank = target.maxBank ?? 60 * DEG;
    const maxTurn = target.maxTurnRate ?? 12 * DEG;
    const turn = clamp(this.courseGain * wrap(target.course - track), -maxTurn, maxTurn);
    const bankCmd = clamp(Math.atan((v * turn) / g), -maxBank, maxBank);
    const pDes = clamp(this.bankGain * (bankCmd - t.bank), -2, 2);
    ctl.roll = clamp(pDes / spec.controls.maxRollRate, -1, 1);
    ctl.yaw = 0;
    // Vertical: flight path error → climb rate → load factor.
    const gammaRate = clamp(this.gammaGain * (target.gamma - t.gamma), -0.25, 0.25);
    const cb = Math.cos(clamp(t.bank, -80 * DEG, 80 * DEG));
    const nDes = (Math.cos(t.gamma) + (v * gammaRate) / g) / cb;
    const c = spec.controls;
    const sLoad = nDes >= 1 ? (nDes - 1) / (c.maxLoad - 1) : (nDes - 1) / (1 - c.minLoad);
    // At low speed the stick commands pitch rate: the body rate of that path.
    const qDes = (g / v) * (nDes - Math.cos(t.gamma) * cb);
    const sRate = qDes / c.maxPitchRate;
    const w = pitchBlend(spec, t.cas, t.wow);
    ctl.pitch = clamp(w * sLoad + (1 - w) * sRate, -1, 1);
    // Speed: PI on calibrated airspeed.
    if (target.speed !== null) {
      const e = target.speed - t.cas;
      const max = target.afterburner ? 1 : MIL_DETENT;
      const base = 0.35;
      let lever = base + this.throttleGain * e + this.throttleI;
      if ((lever < max || e < 0) && (lever > 0 || e > 0))
        this.throttleI += this.throttleIntegral * e * dt;
      this.throttleI = clamp(this.throttleI, -0.6, 0.8);
      lever = base + this.throttleGain * e + this.throttleI;
      ctl.throttle = clamp(lever, 0, max);
    }
  }
}
