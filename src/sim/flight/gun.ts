/**
 * The internal gun (roadmap R2.6, decision 295): its rounds leave the muzzle along the
 * boresight at the muzzle velocity plus the aircraft's own, slow with drag and fall with
 * gravity, and live for a few seconds. The gun fires while its trigger is held, armed and
 * with rounds left, at its rate; every `tracerEvery`th round is a tracer. Hits are R2.6's
 * next task; the rounds carry what it needs (where, how fast, whose).
 *
 * The lead-computing pipper (`leadSolution`): the shooter is assumed to hold its turn, and
 * a target in that turn with it (the classic gunsight's assumption), at the range a radar
 * lock gives or a fixed range. The rounds fired now and the shooter are flown ahead
 * together until the rounds reach that range; the pipper is where they then are, seen in
 * the shooter's frame as it will be turned by then. With no turn it sits below the
 * boresight by the rounds' drop.
 *
 * Headless and deterministic: the sim's types only.
 */
import { Vec3d } from '../../core/vec3d';
import type { Quatd } from '../../core/quat';
import { standardAtmosphere } from './atmosphere';
import { gravityAt, modelToBody } from './rigidBody';

/** A type's gun (its bundle's `gun`; rule 17). */
export interface GunSpec {
  name: string;
  /** The real gun its figures come from. */
  reference: string;
  /** Rounds carried. */
  rounds: number;
  /** Rounds per second. */
  rate: number;
  /** m/s. */
  muzzleVelocity: number;
  /** The muzzle in the model's frame (m). */
  at: [number, number, number];
  /** A round's mass (kg) and drag area (m²). */
  roundMass: number;
  roundDragArea: number;
  /** One round in this many is a tracer. */
  tracerEvery: number;
}

/** A round in flight. */
export interface Round {
  pos: Vec3d;
  vel: Vec3d;
  /** Seconds since it left the muzzle. */
  age: number;
  tracer: boolean;
}

/** How long a round is followed (s): past its useful range. */
export const ROUND_LIFE = 3;
/** The pipper's range without a lock (m): about 2,000 ft. */
export const PIPPER_RANGE = 610;

/** Steps a round by dt (s) on a planet of radius R: drag, then gravity. */
export function stepRound(r: Round, spec: Readonly<GunSpec>, dt: number, R: number): void {
  const rad = r.pos.length();
  const air = standardAtmosphere(rad - R);
  const v = r.vel.length();
  const k = (0.5 * air.density * spec.roundDragArea * v) / spec.roundMass;
  r.vel.scale(1 - k * dt).addScaled(r.pos, (-gravityAt(R, rad) / rad) * dt);
  r.pos.addScaled(r.vel, dt);
  r.age += dt;
}

/** The shooter as the gun reads it: CG, velocity, attitude and body rates. */
export interface Shooter {
  pos: Readonly<Vec3d>;
  vel: Readonly<Vec3d>;
  q: Readonly<Quatd>;
  /** Body rates p, q, r (rad/s). */
  omega: Readonly<Vec3d>;
}

/** The muzzle's world position and a round's initial velocity (the aircraft's plus the muzzle's). */
function muzzle(
  s: Shooter,
  spec: Readonly<GunSpec>,
  cg: readonly [number, number, number],
): { pos: Vec3d; vel: Vec3d } {
  const pos = s.pos.clone().add(s.q.rotate(modelToBody(spec.at, cg)));
  const vel = s.vel.clone().add(s.q.rotate(new Vec3d(spec.muzzleVelocity, 0, 0)));
  return { pos, vel };
}

export class Gun {
  /** Rounds left. */
  rounds: number;
  /** The trigger, held or not (the player's input, or the AI's in R3). */
  trigger = false;
  /** The rounds in flight. */
  readonly live: Round[] = [];
  /** Fractional rounds owed at the rate. */
  private owed = 0;
  private fired = 0;

  constructor(
    readonly spec: Readonly<GunSpec>,
    rounds = spec.rounds,
  ) {
    this.rounds = Math.max(0, Math.min(spec.rounds, rounds));
  }

  /**
   * One step of dt: fires while the trigger is held and `armed`, and flies the rounds in
   * flight. Returns the rounds fired in this step.
   */
  step(
    s: Shooter,
    cg: readonly [number, number, number],
    dt: number,
    R: number,
    armed: boolean,
  ): number {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const r = this.live[i]!;
      stepRound(r, this.spec, dt, R);
      if (r.age > ROUND_LIFE) this.live.splice(i, 1);
    }
    if (!this.trigger || !armed || this.rounds <= 0) {
      this.owed = 0;
      return 0;
    }
    this.owed += this.spec.rate * dt;
    let n = 0;
    while (this.owed >= 1 && this.rounds > 0) {
      this.owed -= 1;
      this.rounds--;
      this.fired++;
      const m = muzzle(s, this.spec, cg);
      // Spread along the step: the rounds of one step leave at their own times.
      const lead = this.owed / this.spec.rate;
      const r: Round = {
        pos: m.pos.addScaled(m.vel, lead),
        vel: m.vel,
        age: lead,
        tracer: this.fired % this.spec.tracerEvery === 0,
      };
      this.live.push(r);
      n++;
    }
    return n;
  }
}

/** Rotates v about the unit axis `a` by angle `t` (rad), right-handed (Rodrigues). */
function rotateAbout(v: Readonly<Vec3d>, a: Readonly<Vec3d>, t: number): Vec3d {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const axv = a.clone().cross(v);
  const d = a.dot(v);
  return v
    .clone()
    .scale(c)
    .addScaled(axv, s)
    .addScaled(a, d * (1 - c));
}

/**
 * The lead-computing pipper: the direction in the shooter's body frame (unit; x forward,
 * y right, z down) at which a target `range` m away, holding the shooter's turn, is hit by
 * rounds fired now, and the rounds' time of flight (s). Null if the rounds never reach
 * the range within their life.
 */
export function leadSolution(
  s: Shooter,
  spec: Readonly<GunSpec>,
  cg: readonly [number, number, number],
  R: number,
  range = PIPPER_RANGE,
): { dir: Vec3d; tof: number } | null {
  const m = muzzle(s, spec, cg);
  const round: Round = { pos: m.pos, vel: m.vel, age: 0, tracer: false };
  // The shooter's turn, in the world: its velocity turns about this axis at this rate.
  const w = s.q.rotate(s.omega);
  const rate = w.length();
  const axis = rate > 1e-6 ? w.clone().scale(1 / rate) : new Vec3d(1, 0, 0);
  const own = s.pos.clone();
  const dt = 0.005;
  let t = 0;
  const rel = new Vec3d();
  while (t < ROUND_LIFE) {
    stepRound(round, spec, dt, R);
    t += dt;
    const v = rate > 1e-6 ? rotateAbout(s.vel, axis, rate * (t - dt / 2)) : s.vel;
    own.addScaled(v, dt);
    rel.copy(round.pos).sub(own);
    if (rel.length() >= range) {
      // Seen in the shooter's frame as turned by then: undo the turn, then the attitude.
      const back = rate > 1e-6 ? rotateAbout(rel, axis, -rate * t) : rel.clone();
      return { dir: s.q.unrotate(back).normalize(), tof: t };
    }
  }
  return null;
}
