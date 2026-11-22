/**
 * The puff as a sphere impostor (Proposal 0011, decision 320): each puff is one quad
 * facing the camera, two triangles at any size on screen, and the fragment shader draws a
 * solid sphere in it.
 *
 * - **Quad.** Centered on the puff, across the view, as wide as the sphere's silhouette
 *   seen from the camera (r·d/√(d² − r²)), with room for the radius bump. A dead puff, one
 *   the lens is inside, or one beyond the draw range collapses to a point behind the camera.
 * - **Sphere.** The view ray meets the sphere in the puff's own frame, squashed along the
 *   local up by the look's squash; a second test against a radius bumped by a smooth
 *   function of the first hit's normal and the puff's seed makes the outline lumpy. The hit
 *   gives the normal and the depth, which the shader writes: puffs cut into each other, the
 *   ground and the aircraft as solids do, with no sorting.
 * - **Toon light.** Three bands of the sun's light by N·L (highlight, midtone, shadow),
 *   the sky's light nearly flat, the moon's as the sun's, and a thin rim of sky light at
 *   the outline; all from `PlanetLighting.at` at the hit, so the puff takes the terrain's
 *   and the clouds' shadows and the zone's light like the ground. Glowing puffs (fire, a
 *   flash, a motor) add their color times the glow and keep only a hint of the bands.
 *   Aerial perspective at the puff's center, per vertex.
 * - **Dithered fade.** Coverage under 1 discards pixels by a 4 × 4 ordered dither, offset
 *   per puff so two fading puffs do not share holes. No blending, no sorting; the fade
 *   reads as the stylized dissolve. Puffs also dissolve near the lens and at the far edge of
 *   the draw range.
 */
import { DoubleSide, MeshBasicNodeMaterial } from 'three/webgpu';
import type { Vector3 } from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  abs,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  cross,
  Discard,
  dot,
  float,
  floor,
  Fn,
  fract,
  If,
  length,
  max,
  mix,
  mod,
  normalize,
  positionGeometry,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  sqrt,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { PuffBuffers } from './puffCompute';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** The shades of the three bands: shadow, midtone, highlight (shares of the sun's light). */
export const TOON_BANDS: readonly [number, number, number] = [0.12, 0.55, 1];
/** N·L at which the shadow turns to midtone, and the midtone to highlight. */
export const TOON_EDGES: readonly [number, number] = [-0.05, 0.45];
/** Room for the radius bump around the sphere (share of the radius). */
const BUMP = 0.12;
/** Puffs nearer than this (m) dissolve: the lens never sits inside a ball. */
const NEAR_FADE: readonly [number, number] = [4, 14];

/** The bump of the radius (share) at a unit normal, for a seed: smooth, low frequency. */
export function radiusBump(n: readonly [number, number, number], seed: number): number {
  return (
    0.08 *
      Math.sin(n[0] * 2.7 + seed * 6.1) *
      Math.sin(n[1] * 3.1 + seed * 4.3 + 1) *
      Math.sin(n[2] * 2.3 + seed * 9.7 + 2) +
    0.04 * Math.sin(n[0] * 5.3 + n[2] * 4.1 + seed * 13.1)
  );
}

/** The 4 × 4 ordered dither's threshold (0..1) at a pixel. */
export function bayer4(x: number, y: number): number {
  const b2 = (a: number, b: number) => ((a ^ b) & 1) * 2 + (b & 1);
  return (b2(x & 1, y & 1) * 4 + b2((x >> 1) & 1, (y >> 1) & 1) + 0.5) / 16;
}

export interface PuffMaterialOptions {
  /** The pool's anchor minus the eye (m), float64 subtracted, then float32. */
  anchorRel: UniformNode<'vec3', Vector3>;
  /** Puffs beyond this distance (m) are not drawn. */
  range: UniformNode<'float', number>;
  /** The least radius a puff is drawn with, as an angle (rad): about a pixel and a half. */
  minAngle: UniformNode<'float', number>;
  /** Extra light at a camera-relative point (the flash lights), or null. */
  localLight?: ((relative: V3) => V3) | null;
}

export function puffMaterial(
  buffers: PuffBuffers,
  lighting: PlanetLighting,
  o: PuffMaterialOptions,
): MeshBasicNodeMaterial {
  const L = lighting;
  const m = new MeshBasicNodeMaterial({ side: DoubleSide });
  m.name = 'puffs';
  const pos = buffers.pos.toAttribute() as unknown as V4;
  const vel = buffers.vel.toAttribute() as unknown as V4;
  const color = buffers.color.toAttribute() as unknown as V4;
  const params = buffers.params.toAttribute() as unknown as V4;
  const extra = buffers.extra.toAttribute() as unknown as V4;
  const vCenter = varyingProperty('vec3', 'vPuffCenter');
  const vRel = varyingProperty('vec3', 'vPuffRel');
  const vColor = varyingProperty('vec4', 'vPuffColor');
  /** radius, coverage, squash, seed */
  const vShape = varyingProperty('vec4', 'vPuffShape');
  const vUp = varyingProperty('vec3', 'vPuffUp');
  const vIn = varyingProperty('vec3', 'vPuffInscatter');
  const vTr = varyingProperty('vec3', 'vPuffTransmittance');

  m.positionNode = Fn(() => {
    const center = pos.xyz.add(o.anchorRel).toVar();
    const dist = length(center);
    // Far puffs never shrink below a pixel or so: a distant trail stays a line of balls.
    const r = select(vel.w.greaterThan(0), max(vel.w, dist.mul(o.minAngle)), float(0));
    const reach = r.mul(1 + BUMP);
    const alive = r
      .greaterThan(0)
      .and(extra.y.greaterThan(0))
      .and(dist.greaterThan(reach.mul(1.05)))
      .and(dist.lessThan(o.range));
    const view = center.div(max(dist, 1e-3));
    const camUp = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
    const right = normalize(cross(view, camUp));
    const up2 = cross(right, view);
    const half = reach.mul(dist).div(sqrt(max(dist.mul(dist).sub(reach.mul(reach)), 1e-6)));
    const corner = center
      .add(right.mul(positionGeometry.x.mul(half)))
      .add(up2.mul(positionGeometry.y.mul(half)));
    // Dead or unseen: a point behind the camera, so the quad has no area and is clipped.
    const behind = cameraWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz.mul(10);
    const p = select(alive, corner, behind);
    vCenter.assign(center);
    vRel.assign(p);
    vColor.assign(color);
    // Coverage dissolves near the lens and at the far edge of the range.
    const near = smoothstep(NEAR_FADE[0], NEAR_FADE[1], dist.sub(r));
    const far = float(1).sub(smoothstep(o.range.mul(0.85), o.range, dist));
    vShape.assign(vec4(r, extra.y.mul(near).mul(far), extra.z, params.w));
    vUp.assign(normalize(L.planetPosition(center)));
    const ap = L.atmosphere.aerialPerspective(center as V3, 4);
    vIn.assign(ap.inscatter);
    vTr.assign(ap.transmittance);
    return p;
  })();

  // Everything is worked out in the depth node, which the material builds before its color:
  // the dither, the hit (or a discard), the depth and the light. The color reads the result.
  const radiance = vec3(0).toVar('puffRadiance');
  m.depthNode = Fn(() => {
    const r0 = vShape.x;
    const coverage = vShape.y;
    const squash = vShape.z;
    const seed = vShape.w;
    // Dither first: most of a fading puff's pixels end here.
    const px = floor(screenCoordinate.xy);
    const b2 = (a: F, b: F): F => abs(a.sub(b)).mul(2).add(b) as F;
    const a0 = mod(px.x, 2) as F;
    const c0 = mod(px.y, 2) as F;
    const a1 = mod(floor(px.x.div(2)), 2) as F;
    const c1 = mod(floor(px.y.div(2)), 2) as F;
    const threshold = fract(
      b2(a0, c0)
        .mul(4)
        .add(b2(a1, c1))
        .add(0.5)
        .div(16)
        .add(fract(seed.mul(7.31))),
    );
    If(coverage.lessThan(threshold), () => {
      Discard();
    });
    const u = vUp;
    // World to the puff's sphere: the local up stretched by 1 / squash.
    const k = float(1).div(squash).sub(1);
    const toSphere = (v: V3): V3 => v.add(u.mul(dot(v, u).mul(k))) as V3;
    const dir = normalize(vRel) as V3;
    const o3 = toSphere(vCenter.negate() as V3);
    const d3 = toSphere(dir);
    const a = dot(d3, d3);
    const b = dot(o3, d3);
    const oo = dot(o3, o3);
    // First the plain sphere, for the normal the bump is read at.
    const disc0 = b.mul(b).sub(a.mul(oo.sub(r0.mul(r0))));
    const t0 = b
      .negate()
      .sub(sqrt(max(disc0, 0)))
      .div(a);
    const n0 = normalize(o3.add(d3.mul(t0)));
    const bump = float(0.08)
      .mul(sin(n0.x.mul(2.7).add(seed.mul(6.1))))
      .mul(sin(n0.y.mul(3.1).add(seed.mul(4.3)).add(1)))
      .mul(sin(n0.z.mul(2.3).add(seed.mul(9.7)).add(2)))
      .add(float(0.04).mul(sin(n0.x.mul(5.3).add(n0.z.mul(4.1)).add(seed.mul(13.1)))));
    const r1 = r0.mul(bump.add(1));
    const disc = b.mul(b).sub(a.mul(oo.sub(r1.mul(r1))));
    If(disc.lessThan(0), () => {
      Discard();
    });
    const t = b
      .negate()
      .sub(sqrt(max(disc, 0)))
      .div(a);
    // The normal back in the world: the gradient of |M w|² is M (M w), M symmetric.
    const n = normalize(toSphere(o3.add(d3.mul(t)) as V3));
    const hit = dir.mul(t) as V3;
    const at = L.at(hit);
    const ndl = dot(n, L.sunDirection);
    const w = 0.04;
    const band = mix(
      mix(
        float(TOON_BANDS[0]),
        float(TOON_BANDS[1]),
        smoothstep(TOON_EDGES[0] - w, TOON_EDGES[0] + w, ndl),
      ),
      float(TOON_BANDS[2]),
      smoothstep(TOON_EDGES[1] - w, TOON_EDGES[1] + w, ndl),
    );
    const moonBand = mix(
      float(TOON_BANDS[0]),
      float(1),
      smoothstep(-0.1, 0.1, dot(n, L.moonDirection)),
    );
    const sky = at.sky.mul(dot(n, at.up).mul(0.2).add(0.8));
    const rim = smoothstep(0.82, 0.9, float(1).sub(abs(dot(n, dir)))).mul(0.45);
    const night = vec3(0.55, 0.65, 1.0).mul(L.nightLight);
    let light = at.sunlight
      .mul(band)
      .add(sky)
      .add(at.sky.add(at.sunlight.mul(0.25)).mul(rim))
      .add(at.moonlight.mul(moonBand))
      .add(at.moonSky)
      .add(night) as V3;
    if (o.localLight) light = light.add(o.localLight(hit)) as V3;
    const albedo = vColor.xyz;
    const glow = vColor.w;
    const lit = albedo.mul(light);
    const fire = albedo.mul(glow).mul(band.mul(0.35).add(0.65));
    radiance.assign(mix(lit, fire.add(lit.mul(0.3)), clamp(glow, 0, 1)));
    // The hit's depth: puffs are solids in the depth buffer.
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(hit, 1)));
    return clip.z.div(clip.w);
  })();
  m.colorNode = vec4(L.applyAerial(radiance as V3, vIn as V3, vTr as V3), 1);
  return m;
}
