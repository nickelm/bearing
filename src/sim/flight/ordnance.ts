/**
 * Unguided bombs and rockets (roadmap R2.6, decision 300): one projectile model for both.
 * A bomb leaves its station with the aircraft's velocity, pushed clear; a rocket leaves
 * its pod along the boresight and burns its motor along its velocity. Both slow with drag
 * on their drag area and fall with gravity until they reach the ground, where they
 * impact. The same flight, run ahead from the aircraft's state now, gives the HUD's
 * continuously computed impact point (`impactPoint`, CCIP). Hit and damage resolution
 * read the impacts (R2.6's next task).
 *
 * Headless and deterministic: the sim's types only.
 */
import { Vec3d } from '../../core/vec3d';
import type { Quatd } from '../../core/quat';
import { STORES } from '../air/stores';
import { standardAtmosphere } from './atmosphere';
import { gravityAt } from './rigidBody';

/** What a projectile flies with: mass, drag area and an optional motor. */
export interface Ballistics {
  mass: number;
  dragArea: number;
  thrust: number;
  burn: number;
  propellant: number;
}

/** A bomb or rocket in flight. */
export interface Projectile {
  /** The store it is (a bomb's id, or a pod's for its rockets). */
  store: string;
  kind: 'bomb' | 'rocket';
  pos: Vec3d;
  vel: Vec3d;
  age: number;
  ballistics: Ballistics;
}

/** Where a projectile reached the ground, and when. */
export interface Impact {
  store: string;
  kind: 'bomb' | 'rocket';
  at: Vec3d;
  time: number;
  /** Its speed at impact (m/s). */
  speed: number;
}

/** The ballistics of store `id`: a bomb's own, or one rocket of a pod. */
export function ballisticsOf(id: string): Ballistics | null {
  const s = STORES[id];
  if (!s) return null;
  if (s.kind === 'bomb')
    return { mass: s.mass, dragArea: s.dragArea, thrust: 0, burn: 0, propellant: 0 };
  if (s.rocket) {
    const r = s.rocket;
    return {
      mass: r.mass,
      dragArea: r.dragArea,
      thrust: r.thrust,
      burn: r.burn,
      propellant: r.propellant,
    };
  }
  return null;
}

/** Steps a projectile by dt on a planet of radius R: motor, drag, gravity. */
export function stepProjectile(p: Projectile, dt: number, R: number): void {
  const b = p.ballistics;
  const r = p.pos.length();
  const air = standardAtmosphere(r - R);
  const v = p.vel.length();
  const burning = p.age < b.burn;
  const m = b.mass - b.propellant * Math.min(1, b.burn > 0 ? p.age / b.burn : 1);
  const acc = new Vec3d();
  if (v > 0.1) {
    const fwd = p.vel.clone().scale(1 / v);
    if (burning) acc.addScaled(fwd, b.thrust / m);
    acc.addScaled(fwd, -(0.5 * air.density * v * v * b.dragArea) / m);
  }
  acc.addScaled(p.pos, -gravityAt(R, r) / r);
  p.vel.addScaled(acc, dt);
  p.pos.addScaled(p.vel, dt);
  p.age += dt;
}

/** How a bomb leaves its station: pushed clear down the aircraft's axis (m/s). */
export const BOMB_EJECT = 3;
/** How a rocket leaves its pod: its own speed along the boresight at the start (m/s). */
export const ROCKET_EXIT = 30;

/**
 * A projectile of store `id` released now from `pos` by an aircraft with velocity `vel`
 * and attitude `q` (body x forward, z down).
 */
export function launchProjectile(
  id: string,
  pos: Readonly<Vec3d>,
  vel: Readonly<Vec3d>,
  q: Readonly<Quatd>,
): Projectile | null {
  const b = ballisticsOf(id);
  const s = STORES[id];
  if (!b || !s) return null;
  const rocket = s.kind === 'rockets';
  const v = vel
    .clone()
    .add(q.rotate(rocket ? new Vec3d(ROCKET_EXIT, 0, 0) : new Vec3d(0, 0, BOMB_EJECT)));
  return {
    store: id,
    kind: rocket ? 'rocket' : 'bomb',
    pos: pos.clone(),
    vel: v,
    age: 0,
    ballistics: b,
  };
}

/**
 * Steps projectile p by dt and reports its impact if it reached the ground (`groundAt`:
 * the ground's height under a unit direction), placed where its path met the ground.
 */
export function flyProjectile(
  p: Projectile,
  dt: number,
  R: number,
  groundAt: (dir: Readonly<Vec3d>) => number,
  t: number,
): Impact | null {
  const before = p.pos.clone();
  const h0 = before.length() - R - groundAt(before.clone().normalize());
  stepProjectile(p, dt, R);
  const h1 = p.pos.length() - R - groundAt(p.pos.clone().normalize());
  if (h1 > 0) return null;
  const k = h0 > 0 ? h0 / (h0 - h1) : 0;
  return {
    store: p.store,
    kind: p.kind,
    at: before.addScaled(p.pos.clone().sub(before), k),
    time: t + k * dt,
    speed: p.vel.length(),
  };
}

/**
 * The continuously computed impact point (CCIP) of store `id` released now: where it
 * would reach the ground, and in how many seconds; null beyond `maxTime`. Coarse steps,
 * the last one placed where the path met the ground.
 */
export function impactPoint(
  id: string,
  pos: Readonly<Vec3d>,
  vel: Readonly<Vec3d>,
  q: Readonly<Quatd>,
  R: number,
  groundAt: (dir: Readonly<Vec3d>) => number,
  maxTime = 60,
): { at: Vec3d; time: number } | null {
  const p = launchProjectile(id, pos, vel, q);
  if (!p) return null;
  let t = 0;
  while (t < maxTime) {
    // Fine steps while a motor burns, coarser after.
    const dt = p.age < p.ballistics.burn + 0.2 ? 0.02 : 0.1;
    const hit = flyProjectile(p, dt, R, groundAt, t);
    if (hit) return { at: hit.at, time: hit.time };
    t += dt;
  }
  return null;
}

/** The explosive mass an impact stands for (kg): a bomb's, or one rocket's. */
export function impactMass(i: Pick<Impact, 'store' | 'kind'>): number {
  const s = STORES[i.store];
  if (!s) return 0;
  return i.kind === 'rocket' ? (s.rocket?.mass ?? 0) : s.mass;
}
