/**
 * Faceted flat shading for the simulation view's terrain (docs/visual-style.md
 * Part I, Terrain; decision 123).
 *
 * The normal of the triangle under a fragment, from screen-space derivatives
 * of its camera-relative position: a position interpolated across a triangle
 * lies in its plane, so the cross product of its derivatives is the plane's
 * normal, constant over the triangle. The terrain mesh needs no extra
 * vertices. Camera-relative positions keep the same relative precision at
 * every distance, so the normal does not get noisy near the camera.
 *
 * The cross product's sign depends on the screen's handedness, so the normal
 * is turned to face up (terrain has no overhangs). Skirts hang straight down,
 * where that sign is undefined; there, and wherever `facets` is 0, the smooth
 * vertex normal stands in.
 *
 * Call it before any per-fragment branch: WGSL takes derivatives only in
 * uniform control flow (decision 69).
 */
import type { Node } from 'three/webgpu';
import { abs, cross, dFdx, dFdy, dot, mix, normalize, sign, step } from 'three/tsl';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** |n · up| under which a face counts as a skirt (about 87° from level). */
const SKIRT_FACING = 0.05;

/**
 * The shading normal: the face normal blended over the smooth one by
 * `facets` (0..1).
 *
 * @param position fragment position, camera-relative (positionWorld)
 * @param up unit radial direction
 * @param smooth the interpolated vertex normal
 * @param facets 1 for flat facets, 0 for smooth shading
 */
export function facetNormal(position: V3, up: V3, smooth: V3, facets: F): V3 {
  const face = normalize(cross(dFdx(position), dFdy(position)));
  const facing = dot(face, up);
  const oriented = face.mul(sign(facing));
  const usable = step(SKIRT_FACING, abs(facing));
  return normalize(mix(smooth, oriented, facets.mul(usable))) as V3;
}
