/**
 * IR missiles (roadmap R2.6, decision 297): the seeker on the launching aircraft and the
 * missile in flight. Headless and deterministic: the sim's types only.
 *
 * - **Heat sources** are the aircraft an IR seeker can see: where each was at a time and
 *   its velocity, so a step between two refreshes reads where it is now (`sourceAt`). The
 *   seeker is itself a sensor: it sees what is hot inside its cone, within its lock range.
 * - **The aircraft's seeker** (`Seeker`) looks along the boresight (caged), or along a
 *   radar lock inside its gimbal limit (slaved); a source inside its acquisition cone and
 *   lock range locks it, and it then tracks that source until it leaves the gimbal limit or
 *   the range. The HUD's seeker circle shows where it looks.
 * - **The missile** (`Missile`) leaves its pylon with the aircraft's velocity, burns its
 *   motor along its velocity, slows with drag (more while it pulls) and falls with gravity.
 *   Its own seeker keeps the target it was launched at while that target stays inside its
 *   gimbal limit and range, and it steers by proportional navigation, its pull limited by
 *   its g limit scaled with dynamic pressure. Its proximity fuze fires at the closest
 *   approach within the fuze radius (checked along each step, since it covers several
 *   meters a step); past its life, slowed below guidance speed after burnout, or into the
 *   ground, it is spent. Hit and kill resolution reads its outcome (R2.6's next task).
 */
import { Vec3d } from '../../core/vec3d';
import type { Quatd } from '../../core/quat';
import type { MissileSpec } from '../air/stores';
import { standardAtmosphere } from './atmosphere';
import { gravityAt } from './rigidBody';

const G0 = 9.80665;

/** An aircraft an IR seeker can see: where it was at `time`, and its velocity. */
export interface HeatSource {
  id: string;
  pos: Readonly<Vec3d>;
  vel: Readonly<Vec3d>;
  time: number;
}

/** Where source s is at time t, carried along its velocity. */
export function sourceAt(s: Readonly<HeatSource>, t: number, out = new Vec3d()): Vec3d {
  return out.copy(s.pos).addScaled(s.vel, t - s.time);
}

function angle(a: Readonly<Vec3d>, b: Readonly<Vec3d>): number {
  const d = a.dot(b) / Math.max(1e-9, a.length() * b.length());
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

/** The launching aircraft's seeker: where it looks and what it tracks. */
export class Seeker {
  /** Where it looks (world, unit). */
  readonly dir = new Vec3d(1, 0, 0);
  /** The source it tracks, or null (caged or slaved, searching). */
  target: string | null = null;

  constructor(readonly spec: Readonly<MissileSpec>) {}

  /**
   * Looks again at time t from `pos` with boresight `boresight` (world, unit): keeps its
   * target while it can, else searches about the boresight or `slave` (a radar lock's
   * direction, used inside the gimbal limit) for the source nearest its axis.
   */
  update(
    pos: Readonly<Vec3d>,
    boresight: Readonly<Vec3d>,
    sources: readonly Readonly<HeatSource>[],
    t: number,
    slave: Readonly<Vec3d> | null = null,
  ): void {
    const sp = this.spec;
    const at = new Vec3d();
    if (this.target) {
      const s = sources.find((x) => x.id === this.target);
      if (s) {
        const los = sourceAt(s, t, at).sub(pos);
        if (los.length() <= sp.lockRange && angle(los, boresight) <= sp.gimbal) {
          this.dir.copy(los).normalize();
          return;
        }
      }
      this.target = null;
    }
    const axis = slave && angle(slave, boresight) <= sp.gimbal ? slave : boresight;
    this.dir.copy(axis).normalize();
    let best = sp.cone;
    for (const s of sources) {
      const los = sourceAt(s, t, at).sub(pos);
      const a = angle(los, this.dir);
      if (a <= best && los.length() <= sp.lockRange) {
        best = a;
        this.target = s.id;
      }
    }
  }
}

export type MissileState = 'flying' | 'hit' | 'spent';

/** Below this speed after burnout a missile can no longer steer (m/s). */
const GUIDANCE_SPEED = 250;
/** The dynamic pressure at which it can pull its full g (Pa). */
const Q_FULL = 40_000;
/** The pull at which its drag doubles, in g. */
const PULL_DRAG_G = 25;

export class Missile {
  readonly pos: Vec3d;
  readonly vel: Vec3d;
  age = 0;
  state: MissileState = 'flying';
  /** The source it was launched at and still guides on, or null. */
  target: string | null;
  /** Its pull last step (m/s²), for the drawn smoke and tests. */
  pull = 0;
  /** Where its fuze fired, the source it fired at and the miss distance (m). */
  burst: { at: Vec3d; target: string; distance: number } | null = null;
  private readonly lastLos = new Vec3d();
  private hadLos = false;

  constructor(
    readonly store: string,
    readonly spec: Readonly<MissileSpec>,
    /** The store's mass at launch (kg), propellant included. */
    readonly launchMass: number,
    readonly dragArea: number,
    pos: Readonly<Vec3d>,
    vel: Readonly<Vec3d>,
    target: string | null,
    /** Who fired it (an aircraft's id), so hit resolution can credit the kill. */
    readonly shooter: string,
    /** The game time it left the pylon. */
    readonly launched: number,
  ) {
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.target = target;
  }

  /** Whether its motor burns. */
  get burning(): boolean {
    return this.state === 'flying' && this.age < this.spec.burn;
  }

  get mass(): number {
    const sp = this.spec;
    return this.launchMass - sp.propellant * Math.min(1, this.age / sp.burn);
  }

  /**
   * One step of dt at game time t (the step's start) on a planet of radius R, among
   * `sources`; `groundAt` gives the ground's height (m) under a unit direction.
   */
  step(
    dt: number,
    t: number,
    R: number,
    sources: readonly Readonly<HeatSource>[],
    groundAt: ((dir: Readonly<Vec3d>) => number) | null = null,
  ): void {
    if (this.state !== 'flying') return;
    const sp = this.spec;
    const r = this.pos.length();
    const air = standardAtmosphere(r - R);
    const v = this.vel.length();
    const fwd = this.vel.clone().scale(1 / Math.max(1, v));
    const m = this.mass;
    const acc = new Vec3d();
    // Guidance: proportional navigation on the line of sight's rate.
    let src: Readonly<HeatSource> | undefined;
    if (this.target) {
      src = sources.find((s) => s.id === this.target);
      const los = src ? sourceAt(src, t).sub(this.pos) : null;
      if (!los || angle(los, fwd) > sp.gimbal || los.length() > sp.lockRange * 1.5) {
        this.target = null;
        src = undefined;
        this.hadLos = false;
      }
    }
    this.pull = 0;
    if (src && (this.burning || v > GUIDANCE_SPEED)) {
      const los = sourceAt(src, t).sub(this.pos);
      const range = los.length();
      const u = los.clone().scale(1 / range);
      if (this.hadLos) {
        // The line of sight's rate (rad/s) as a vector, ω = û_prev × û / dt.
        const w = this.lastLos
          .clone()
          .cross(u)
          .scale(1 / dt);
        const cmd = w.cross(this.vel).scale(sp.gain);
        const q = 0.5 * air.density * v * v;
        const limit = sp.maxG * G0 * Math.min(1, q / Q_FULL);
        const n = cmd.length();
        if (n > limit) cmd.scale(limit / n);
        acc.add(cmd);
        this.pull = Math.min(n, limit);
      }
      this.lastLos.copy(u);
      this.hadLos = true;
    }
    // Thrust along its velocity, drag against it (more while pulling), gravity.
    if (this.burning) acc.addScaled(fwd, sp.thrust / m);
    const pullG = this.pull / G0 / PULL_DRAG_G;
    const drag = (0.5 * air.density * v * v * this.dragArea * (1 + pullG * pullG)) / m;
    acc.addScaled(fwd, -drag);
    acc.addScaled(this.pos, -gravityAt(R, r) / r);
    const before = this.pos.clone();
    this.vel.addScaled(acc, dt);
    this.pos.addScaled(this.vel, dt);
    this.age += dt;
    // The fuze: the closest approach to any source along this step.
    for (const s of sources) {
      const a0 = sourceAt(s, t).sub(before);
      const a1 = sourceAt(s, t + dt).sub(this.pos);
      const d = a1.clone().sub(a0);
      const k = Math.max(0, Math.min(1, -a0.dot(d) / Math.max(1e-9, d.lengthSq())));
      const miss = a0.clone().addScaled(d, k).length();
      if (miss <= sp.fuze && s.id !== this.shooter) {
        this.state = 'hit';
        this.burst = {
          at: before.clone().addScaled(this.pos.clone().sub(before), k),
          target: s.id,
          distance: miss,
        };
        return;
      }
    }
    const h = this.pos.length() - R;
    if (
      this.age > sp.life ||
      (!this.burning && this.vel.length() < GUIDANCE_SPEED * 0.6) ||
      (groundAt && h <= groundAt(this.pos.clone().normalize()))
    )
      this.state = 'spent';
  }
}

/** The boresight (world, unit) of an aircraft with attitude q: its body x. */
export function boresightOf(q: Readonly<Quatd>): Vec3d {
  return q.rotate(new Vec3d(1, 0, 0));
}
