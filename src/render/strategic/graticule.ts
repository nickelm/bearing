/**
 * Graticule and range rings on the strategic map (visual-style Part II, Base Map;
 * decision 91).
 *
 * - **Graticule.** Latitude and longitude lines one pixel wide, at a round spacing
 *   (`GRATICULE_STEPS_DEG`) chosen each frame so that lines fall about
 *   `GRATICULE_TARGET_PX` apart at the screen center. Longitude lines fade out above
 *   80° latitude, where they converge. The equator is drawn a little stronger.
 * - **Range rings.** Great-circle circles around a selected point at multiples of a
 *   round distance (`RING_STEPS_M`), chosen so rings fall about `RING_TARGET_PX` apart,
 *   out to `RING_COUNT` steps, plus a small mark at the center.
 * - Distances become pixels through the fragment's footprint, so lines stay one
 *   pixel wide at any zoom and tilt.
 *
 * The CPU helpers (`graticuleStep`, `ringStep`, `pickSphere`) are pure, for tests.
 */
import type { Node } from 'three/webgpu';
import {
  abs,
  asin,
  atan,
  clamp,
  cos,
  cross,
  dot,
  float,
  floor,
  length,
  max,
  min,
  round,
  select,
  smoothstep,
} from 'three/tsl';
import { DEG } from '../../core/units';
import { Vec3d } from '../../core/vec3d';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Graticule spacings (degrees), coarsest first. */
export const GRATICULE_STEPS_DEG = [30, 15, 10, 5, 2, 1, 0.5] as const;
export const GRATICULE_TARGET_PX = 120;
/** Range-ring spacings (m), coarsest first. */
export const RING_STEPS_M = [500e3, 250e3, 100e3, 50e3, 25e3] as const;
export const RING_TARGET_PX = 90;
export const RING_COUNT = 8;

/** Graticule spacing (radians): the finest step at least `GRATICULE_TARGET_PX` apart. */
export function graticuleStep(mapScale: number, radius: number): number {
  const want = (GRATICULE_TARGET_PX * mapScale) / radius;
  let step: number = GRATICULE_STEPS_DEG[0] * DEG;
  for (const d of GRATICULE_STEPS_DEG) if (d * DEG >= want) step = d * DEG;
  return step;
}

/** Ring spacing (m): the finest step at least `RING_TARGET_PX` apart. */
export function ringStep(mapScale: number): number {
  const want = RING_TARGET_PX * mapScale;
  let step: number = RING_STEPS_M[0];
  for (const d of RING_STEPS_M) if (d >= want) step = d;
  return step;
}

/**
 * Where a ray from `eye` along unit `dir` first meets the sphere of `radius` about the
 * planet center, as a unit direction; null if it misses.
 */
export function pickSphere(
  eye: Readonly<Vec3d>,
  dir: Readonly<Vec3d>,
  radius: number,
): Vec3d | null {
  const b = eye.dot(dir);
  const c = eye.dot(eye) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0) return null;
  return eye.clone().addScaled(dir, t).normalize();
}

/** Coverage of a one-pixel line at a distance of `meters`, for a footprint of m per px. */
const line = (meters: F, footprint: F) => clamp(float(1).sub(meters.div(footprint)), 0, 1) as F;

/** Graticule coverage at unit radial `r` (strength 0..1). */
export function graticuleNode(r: V3, footprint: F, step: F, radius: number): F {
  const lat = asin(clamp(r.y, -1, 1));
  const lon = atan(r.x, r.z);
  const latMeters = abs(lat.sub(round(lat.div(step)).mul(step))).mul(radius);
  const dLon = abs(lon.sub(round(lon.div(step)).mul(step)));
  const lonMeters = dLon.mul(radius).mul(max(cos(lat), 1e-4));
  const polar = smoothstep(80 * DEG, 75 * DEG, abs(lat));
  const equator = line(abs(lat).mul(radius) as F, footprint);
  return max(
    max(line(latMeters as F, footprint), line(lonMeters as F, footprint).mul(polar)),
    equator.mul(1.6),
  ) as F;
}

/** Range-ring coverage around unit direction `center` at unit radial `r`. */
export function rangeRingsNode(r: V3, center: V3, footprint: F, step: F, radius: number): F {
  const d = atan(length(cross(r, center)), dot(r, center)).mul(radius);
  const k = min(round(d.div(step)), RING_COUNT);
  // Rings 1..RING_COUNT only: none at the center, none beyond the last.
  const inRange = select(
    k.greaterThan(0.5).and(floor(d.div(step)).lessThan(RING_COUNT + 0.5)),
    float(1),
    float(0),
  );
  const ring = line(abs(d.sub(k.mul(step))) as F, footprint).mul(inRange);
  // Center mark: a dot three pixels across.
  const mark = clamp(float(2).sub(d.div(footprint)), 0, 1);
  return max(ring, mark) as F;
}
