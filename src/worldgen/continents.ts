/**
 * Stage: continental crust (decisions 17 and 18).
 *
 * Two continent centers sit nearly antipodal: their separation is the sum
 * of both radii plus the middle of the ocean-gap range. Continental crust is
 * the larger of two cone fields around the centers (1 at a center, 0 at
 * its nominal radius), domain-warped and roughened with noise. It is then
 * shifted so that exactly the land fraction of the planet's area lies above
 * zero. The result is a signed "continentalness": > 0 continental, < 0 oceanic.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Noise3 } from '../core/noise';
import { randomUnitVector } from '../core/coords';
import type { Rng } from '../core/rng';
import { DEG } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { clamp, weightedQuantile } from './fields';
import type { PlanetParams } from './params';

/** Shares of the land fraction given to the main and second continents; the rest is islands. */
export const MAIN_CONTINENT_SHARE = 0.6;
export const SECOND_CONTINENT_SHARE = 0.3;

export interface ContinentLayout {
  main: Vec3d;
  second: Vec3d;
  /** Nominal angular radii (radians). */
  mainRadius: number;
  secondRadius: number;
  /** Angle between the centers (radians). */
  separation: number;
}

/** Angular radius of a spherical cap covering `fraction` of the sphere. */
export function capRadius(fraction: number): number {
  return Math.acos(clamp(1 - 2 * fraction, -1, 1));
}

export function layoutContinents(params: PlanetParams, r: Rng): ContinentLayout {
  const land = 1 - params.oceanFraction;
  const mainRadius = capRadius(MAIN_CONTINENT_SHARE * land);
  const secondRadius = capRadius(SECOND_CONTINENT_SHARE * land);
  const gapMid = (params.oceanGap[0] + params.oceanGap[1]) / 2 / params.radius;
  const separation = clamp(
    mainRadius + secondRadius + gapMid + r.range(-3, 3) * DEG,
    100 * DEG,
    178 * DEG,
  );

  const main = randomUnitVector(r);
  // A random tangent direction at the main center gives the bearing to the second continent.
  const t = randomUnitVector(r);
  t.addScaled(main, -t.dot(main));
  if (t.lengthSq() < 1e-12) t.set(main.y, -main.x, 0); // astronomically unlikely
  t.normalize();
  const second = main
    .clone()
    .scale(Math.cos(separation))
    .addScaled(t, Math.sin(separation))
    .normalize();
  return { main, second, mainRadius, secondRadius, separation };
}

/** Signed continentalness per cell; positive cells cover (1 − oceanFraction) of the area. */
export function continentalCrust(
  grid: CubeGrid,
  params: PlanetParams,
  layout: ContinentLayout,
  r: Rng,
): Float32Array {
  const warp = new Noise3(r.fork('warp'));
  const rough = new Noise3(r.fork('rough'));
  const field = new Float64Array(grid.cellCount);
  const x = new Vec3d();
  const w = new Vec3d();
  for (let c = 0; c < grid.cellCount; c++) {
    grid.center(c, x);
    // Domain warp bends the cone edges into irregular coastlines.
    w.set(
      x.x + 0.28 * warp.fbm(x.x * 2.2 + 11.1, x.y * 2.2, x.z * 2.2, 4),
      x.y + 0.28 * warp.fbm(x.x * 2.2, x.y * 2.2 + 23.7, x.z * 2.2, 4),
      x.z + 0.28 * warp.fbm(x.x * 2.2, x.y * 2.2, x.z * 2.2 + 37.3, 4),
    ).normalize();
    const a1 = Math.acos(clamp(w.dot(layout.main), -1, 1));
    const a2 = Math.acos(clamp(w.dot(layout.second), -1, 1));
    const cone = Math.max(1 - a1 / layout.mainRadius, 1 - a2 / layout.secondRadius);
    field[c] = cone + 0.22 * rough.fbm(x.x * 5, x.y * 5, x.z * 5, 5);
  }
  const threshold = weightedQuantile(field, grid.areas, params.oceanFraction);
  const out = new Float32Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) out[c] = field[c] - threshold;
  return out;
}
