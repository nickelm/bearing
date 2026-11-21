/**
 * A released store in free fall (decision 294): gravity toward the planet's center and
 * drag on its drag area, in the air's density at its height, with the wind; a slow
 * tumble for a store with no fins to hold it (a tank). Headless and deterministic: the
 * falling tanks the view draws use it now, and the bombs' fall lines (CCIP) and their
 * impact points will (R2.6).
 */
import { Quatd } from '../../core/quat';
import { Vec3d } from '../../core/vec3d';
import { standardAtmosphere } from './atmosphere';
import { gravityAt } from './rigidBody';

export interface FallingStore {
  pos: Vec3d;
  vel: Vec3d;
  /** Body-to-world rotation (body x forward, y right, z down), as the aircraft's. */
  q: Quatd;
  /** kg and m². */
  mass: number;
  dragArea: number;
  /** Body rates (rad/s) it tumbles at: a tank pitches nose down and yaws a little. */
  tumble: [number, number, number];
}

/** Steps a falling store by dt (s) on a planet of radius R, in still air or `wind` (m/s). */
export function stepFalling(
  s: FallingStore,
  dt: number,
  R: number,
  wind: Readonly<Vec3d> | null = null,
): void {
  const r = s.pos.length();
  const air = standardAtmosphere(r - R);
  const rel = s.vel.clone();
  if (wind) rel.sub(wind);
  const v = rel.length();
  const k = (0.5 * air.density * s.dragArea * v) / s.mass;
  const g = gravityAt(R, r);
  // Semi-implicit Euler: velocity first, then position with the new velocity.
  s.vel.addScaled(rel, -k * dt).addScaled(s.pos, (-g / r) * dt);
  s.pos.addScaled(s.vel, dt);
  s.q.integrateBodyRates(s.tumble[0], s.tumble[1], s.tumble[2], dt);
}
