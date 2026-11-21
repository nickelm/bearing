/**
 * Surface art in the terrain shader (Proposal 0010, *Surface*; decision 298): the
 * mesh's own curvature per face, and the interleaved layout that carries the baked
 * curvature, strata strength and rock tone per vertex. The shading itself (curvature
 * light and dark, strata bands, color drift) is in `LandShading.surface`.
 */
import type { Node } from 'three/webgpu';
import { dFdx, dFdy, dot, max } from 'three/tsl';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/**
 * Floats per vertex in the terrain's interleaved buffer: surface (height, lake depth,
 * shore, forest), the canopy edge, and the art (curvature, strata, tone).
 */
export const SURFACE_STRIDE = 8;

/**
 * The divergence of the interpolated surface gradient across the pixel's triangle
 * (1/m): the mesh's Laplacian of height, positive in hollows and creases, negative on
 * crests and spurs. The gradient varies linearly within a triangle, so this is one
 * value per face, the facets' own curvature. Takes screen derivatives: call it in
 * uniform control flow, before any branch (decision 69).
 *
 * With the screen derivatives of position (e1, e2 spanning the face) and of the
 * gradient (its changes along them), the divergence is the trace of the gradient's
 * Jacobian in the face: Σ eᵢ* · ∂ᵢg over the dual basis eᵢ*.
 */
export function meshCurvature(slope: V3, position: V3): F {
  const e1 = dFdx(position);
  const e2 = dFdy(position);
  const g1 = dFdx(slope);
  const g2 = dFdy(slope);
  const a = dot(e1, e1);
  const b = dot(e1, e2);
  const c = dot(e2, e2);
  const det = max(a.mul(c).sub(b.mul(b)), 1e-12);
  const d1 = e1.mul(c).sub(e2.mul(b)).div(det);
  const d2 = e2.mul(a).sub(e1.mul(b)).div(det);
  return dot(d1, g1).add(dot(d2, g2)) as F;
}
