/**
 * Cartographic hillshade for the strategic map (visual-style Part II, Base Map;
 * decision 78).
 *
 * - **Light.** From the screen's upper left, at `elevation` (20° by default) above the local
 *   ground, everywhere on the globe: the light's horizontal part is the screen's
 *   up-left direction projected onto the tangent plane at each point. It turns with
 *   the camera and never with the sun, so ranges always read the same way.
 * - **Relative to flat.** The factor is n·L / sin(elevation), so flat ground is 1
 *   and keeps its palette color anywhere on the globe (no limb darkening); slopes
 *   facing the light rise toward 1/sin(elevation), slopes facing away fall toward 0.
 *   `strength` blends from no relief shading (0) to the full factor (1) and beyond.
 * - **Soft ambient.** The result never drops below `ambient`, so shadowed slopes
 *   keep their color.
 *
 * Shading is per fragment from the interpolated 4× normals: one dot product, and
 * a light that moves with the camera every frame would invalidate any bake.
 * `hillshade()` is the CPU reference for tests; `hillshadeNode()` is the same
 * formula in TSL.
 */
import { clamp, dot, float, max, mix, normalize, sin, cos } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { DEG } from '../../core/units';
import { Vec3d } from '../../core/vec3d';

/** A low light, 20° above the ground (owner's choice; cartographic convention is 45°). */
export const HILLSHADE_ELEVATION = 20 * DEG;
/** Twice the plain factor: the owner's choice, so the 4× relief reads strongly. */
export const HILLSHADE_STRENGTH = 2;
export const HILLSHADE_AMBIENT = 0.3;
/** Brightest a lit slope gets, relative to flat ground. */
export const HILLSHADE_MAX = 1.35;

export interface HillshadeParams {
  elevation: number;
  strength: number;
  ambient: number;
}

export const DEFAULT_HILLSHADE: HillshadeParams = {
  elevation: HILLSHADE_ELEVATION,
  strength: HILLSHADE_STRENGTH,
  ambient: HILLSHADE_AMBIENT,
};

/**
 * Direction toward the light at a point with unit radial `radial`, for a camera
 * whose screen right and up are `right` and `up` (unit, world frame).
 */
export function hillshadeLight(
  radial: Readonly<Vec3d>,
  right: Readonly<Vec3d>,
  up: Readonly<Vec3d>,
  elevation: number,
  out = new Vec3d(),
): Vec3d {
  // Screen up-left, projected onto the tangent plane.
  const t = new Vec3d().copy(up).sub(right);
  t.addScaled(radial, -t.dot(radial));
  const len = t.length();
  if (len < 1e-9) return out.copy(radial);
  t.scale(1 / len);
  return out.set(0, 0, 0).addScaled(radial, Math.sin(elevation)).addScaled(t, Math.cos(elevation));
}

/** Shading factor for a surface normal: 1 on flat ground (see the header). */
export function hillshade(
  normal: Readonly<Vec3d>,
  radial: Readonly<Vec3d>,
  right: Readonly<Vec3d>,
  up: Readonly<Vec3d>,
  p: HillshadeParams = DEFAULT_HILLSHADE,
): number {
  const L = hillshadeLight(radial, right, up, p.elevation);
  const relief = Math.max(0, normal.dot(L)) / Math.sin(p.elevation);
  const shaded = 1 + (relief - 1) * p.strength;
  return Math.min(HILLSHADE_MAX, Math.max(p.ambient, shaded));
}

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** TSL uniforms the shader form reads. */
export interface HillshadeUniforms {
  /** Screen right and up, world frame (set each frame). */
  right: V3;
  up: V3;
  elevation: F;
  strength: F;
  ambient: F;
}

/** `hillshade()` in TSL, for a normal and radial in the world frame. */
export function hillshadeNode(normal: V3, radial: V3, u: HillshadeUniforms): F {
  const v = u.up.sub(u.right);
  const tangent = v.sub(radial.mul(dot(v, radial)));
  const t = tangent.div(max(tangent.length(), 1e-6));
  const L = normalize(radial.mul(sin(u.elevation)).add(t.mul(cos(u.elevation))));
  const relief = max(dot(normal, L), 0).div(sin(u.elevation));
  const shaded = mix(float(1), relief, u.strength);
  return clamp(shaded, u.ambient, HILLSHADE_MAX) as F;
}
