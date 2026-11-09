/**
 * Stage: continental crust (decisions 17 and 18).
 *
 * Two east–west elongated continents (decisions 17 and 20): the main one is
 * centered at temperate latitudes, and the second one sits across an ocean
 * gap in the other hemisphere. Continental crust is the larger of two
 * elliptical cone fields (1 at a center, 0 on the ellipse), domain-warped and
 * roughened with noise. It is then
 * shifted so that exactly the land fraction of the planet's area lies above
 * zero. The result is a signed "continentalness": > 0 continental, < 0 oceanic.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Noise3 } from '../core/noise';
import { latLonToDirection } from '../core/coords';
import type { Rng } from '../core/rng';
import { DEG } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { clamp, weightedQuantile } from './fields';
import type { PlanetParams } from './params';

/** Shares of the land fraction given to the main and second continents; the rest is islands. */
export const MAIN_CONTINENT_SHARE = 0.6;
export const SECOND_CONTINENT_SHARE = 0.3;
/** Allowed |latitude| range for the main continent's center (radians), decision 20. */
export const MAIN_CONTINENT_LATITUDE: readonly [number, number] = [32 * DEG, 45 * DEG];
/** Allowed |latitude| range for the second continent's center (radians). */
export const SECOND_CONTINENT_LATITUDE: readonly [number, number] = [22 * DEG, 55 * DEG];
/** East–west elongation (major / minor axis) of each continent, like Eurasia. */
export const MAIN_CONTINENT_ASPECT = 1.8;
export const SECOND_CONTINENT_ASPECT = 1.6;
/** Maximum tilt of a continent's long axis away from east–west. */
const MAX_AXIS_TILT = 25 * DEG;
const LAYOUT_ATTEMPTS = 48;
const BOUNDARY_SAMPLES = 32;

/**
 * An elliptical continent in the tangent plane at its center: semi-axes in
 * radians of arc, with the major axis rotated `tilt` from local east.
 */
export interface ContinentShape {
  center: Vec3d;
  east: Vec3d;
  north: Vec3d;
  semiMajor: number;
  semiMinor: number;
  tilt: number;
}

export interface ContinentLayout {
  main: Vec3d;
  second: Vec3d;
  mainShape: ContinentShape;
  secondShape: ContinentShape;
  /** Nominal angular radii (radians) of caps with the target areas. */
  mainRadius: number;
  secondRadius: number;
  /** Angle between the centers (radians). */
  separation: number;
  /** Shortest boundary-to-boundary angle of the two ellipses before noise (radians). */
  nominalGap: number;
}

/** Angular radius of a spherical cap covering `fraction` of the sphere. */
export function capRadius(fraction: number): number {
  return Math.acos(clamp(1 - 2 * fraction, -1, 1));
}

export function makeShape(
  center: Vec3d,
  nominalRadius: number,
  aspect: number,
  tilt: number,
): ContinentShape {
  const east = new Vec3d(0, 1, 0).cross(center);
  if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
  east.normalize();
  const north = center.clone().cross(east);
  const s = Math.sqrt(aspect);
  return { center, east, north, semiMajor: nominalRadius * s, semiMinor: nominalRadius / s, tilt };
}

/** Distance from the shape's center to its boundary along tangent bearing `beta` (from east). */
function boundaryRadius(shape: ContinentShape, beta: number): number {
  const a = beta - shape.tilt;
  const u = Math.cos(a) / shape.semiMajor;
  const v = Math.sin(a) / shape.semiMinor;
  return 1 / Math.sqrt(u * u + v * v);
}

/** Angular distance from the center divided by the boundary radius in that direction (1 on the boundary). */
export function normalizedDistance(shape: ContinentShape, x: Readonly<Vec3d>): number {
  const c = shape.center;
  const dot = clamp(x.dot(c), -1, 1);
  const r = Math.acos(dot);
  if (r < 1e-9) return 0;
  const vx = x.x - c.x * dot;
  const vy = x.y - c.y * dot;
  const vz = x.z - c.z * dot;
  const e = vx * shape.east.x + vy * shape.east.y + vz * shape.east.z;
  const n = vx * shape.north.x + vy * shape.north.y + vz * shape.north.z;
  return r / boundaryRadius(shape, Math.atan2(n, e));
}

function boundaryPoints(shape: ContinentShape): Vec3d[] {
  const pts: Vec3d[] = [];
  for (let k = 0; k < BOUNDARY_SAMPLES; k++) {
    const beta = (k / BOUNDARY_SAMPLES) * 2 * Math.PI;
    const r = boundaryRadius(shape, beta);
    const t = shape.east.clone().scale(Math.cos(beta)).addScaled(shape.north, Math.sin(beta));
    pts.push(shape.center.clone().scale(Math.cos(r)).addScaled(t, Math.sin(r)).normalize());
  }
  return pts;
}

function minBoundaryAngle(a: ContinentShape, b: ContinentShape): number {
  // Overlapping shapes have no gap.
  if (normalizedDistance(a, b.center) <= 1 || normalizedDistance(b, a.center) <= 1) return 0;
  const pa = boundaryPoints(a);
  const pb = boundaryPoints(b);
  let best = Infinity;
  for (const p of pa) {
    if (normalizedDistance(b, p) <= 1) return 0;
    for (const q of pb) best = Math.min(best, Math.acos(clamp(p.dot(q), -1, 1)));
  }
  return best;
}

/**
 * Places two east–west elongated continents (decisions 17 and 20).
 * - The main center lies at 32–45° latitude.
 * - For each candidate bearing, the separation is searched so that the
 *   ellipse-to-ellipse gap is closest to the middle of `oceanGap`.
 * - A candidate is accepted if the second continent's center is temperate.
 */
export function layoutContinents(params: PlanetParams, r: Rng): ContinentLayout {
  const land = 1 - params.oceanFraction;
  const mainRadius = capRadius(MAIN_CONTINENT_SHARE * land);
  const secondRadius = capRadius(SECOND_CONTINENT_SHARE * land);
  const gapTarget = (params.oceanGap[0] + params.oceanGap[1]) / 2 / params.radius;

  const lat =
    r.range(MAIN_CONTINENT_LATITUDE[0], MAIN_CONTINENT_LATITUDE[1]) * (r.chance(0.5) ? 1 : -1);
  const main = latLonToDirection(lat, r.range(-Math.PI, Math.PI));
  const mainShape = makeShape(
    main,
    mainRadius,
    MAIN_CONTINENT_ASPECT,
    r.range(-MAX_AXIS_TILT, MAX_AXIS_TILT),
  );

  let best: ContinentLayout | null = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < LAYOUT_ATTEMPTS; attempt++) {
    const bearing = r.range(0, 2 * Math.PI);
    const tilt2 = r.range(-MAX_AXIS_TILT, MAX_AXIS_TILT);
    const t = mainShape.east
      .clone()
      .scale(Math.cos(bearing))
      .addScaled(mainShape.north, Math.sin(bearing));
    for (let sepDeg = 100; sepDeg <= 178; sepDeg += 2) {
      const sep = sepDeg * DEG;
      const second = main.clone().scale(Math.cos(sep)).addScaled(t, Math.sin(sep)).normalize();
      const lat2 = Math.abs(Math.asin(clamp(second.y, -1, 1)));
      const secondShape = makeShape(second, secondRadius, SECOND_CONTINENT_ASPECT, tilt2);
      const gap = minBoundaryAngle(mainShape, secondShape);
      const latPenalty =
        lat2 < SECOND_CONTINENT_LATITUDE[0]
          ? SECOND_CONTINENT_LATITUDE[0] - lat2
          : Math.max(0, lat2 - SECOND_CONTINENT_LATITUDE[1]);
      const score = Math.abs(gap - gapTarget) + 4 * latPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = {
          main,
          second,
          mainShape,
          secondShape,
          mainRadius,
          secondRadius,
          separation: sep,
          nominalGap: gap,
        };
      }
    }
    // Good enough: temperate second continent and gap within ~50 km of the target.
    if (bestScore < 50_000 / params.radius) break;
  }
  return best!;
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
    const cone = Math.max(
      1 - normalizedDistance(layout.mainShape, w),
      1 - normalizedDistance(layout.secondShape, w),
    );
    field[c] = cone + 0.22 * rough.fbm(x.x * 5, x.y * 5, x.z * 5, 5);
  }
  const threshold = weightedQuantile(field, grid.areas, params.oceanFraction);
  const out = new Float32Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) out[c] = field[c] - threshold;
  return out;
}
