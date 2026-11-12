/**
 * Night lights as camera-facing points (V3; visual-style Part I, _Bases_ and
 * _Light and Emissives_): runway edge, threshold and end lights, apron
 * floods, tower windows and beacons, lit windows in towns. The structure
 * layer emits them per tile with its buildings (structureLayer.ts); this
 * module draws them.
 *
 * - One instanced quad per light, turned to face the camera with the view
 *   matrix's right and up axes, at the anchor's world size but never under
 *   LIGHT_MIN_PIXELS across; held at that size, a light dims with the square
 *   root of the area ratio, between constant brightness and constant total
 *   flux, so distant rows stay visible without turning into blobs.
 * - Additive, with a bright core and a soft halo; dimmed by the air's
 *   transmittance between the light and the camera. Lights come on as the sun
 *   sets (`lightsOn`), fully at a sun elevation of −2°.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  cameraWorldMatrix,
  clamp,
  dot,
  exp,
  float,
  Fn,
  max,
  min,
  modelWorldMatrix,
  normalize,
  screenSize,
  smoothstep,
  varyingProperty,
  vec4,
} from 'three/tsl';
import { EMISSIVE_COLORS, hexToLinear } from '../../common/models/palettes';
import type { PlanetLighting } from '../lighting/planetLighting';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Per light: base xyz (relative to the tile origin), up xyz, offset xyz (m), ground height, rgb, size (m). */
export const LIGHT_FLOATS = 14;
/** Smallest drawn diameter (device pixels). */
export const LIGHT_MIN_PIXELS = 6;

/** World diameter (m) and linear color of each emissive kind. */
export const LIGHT_KINDS: Record<string, { size: number; color: [number, number, number] }> = {
  runway: { size: 2.2, color: hexToLinear(EMISSIVE_COLORS.runway!) },
  threshold: { size: 2.2, color: hexToLinear(EMISSIVE_COLORS['nav-green']!) },
  'runway-end': { size: 2.2, color: hexToLinear(EMISSIVE_COLORS['nav-red']!) },
  flood: { size: 7, color: hexToLinear(EMISSIVE_COLORS.flood!) },
  window: { size: 2.4, color: hexToLinear(EMISSIVE_COLORS.window!) },
  beacon: { size: 2, color: hexToLinear(EMISSIVE_COLORS.beacon!) },
};

/** A unit quad, corners at (±1, ±1), two triangles. */
export function lightQuad(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new BufferAttribute(Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** 0 by day to 1 once the sun is 2° below the horizon, from the sun's elevation at `up`. */
export function lightsOn(up: V3, sunDirection: V3): F {
  return smoothstep(0.1, -0.035, dot(up, sunDirection)) as F;
}

/**
 * The material of a tile's light points: instanced attributes `lBase`, `lUp`,
 * `lOffset` (offset xyz, ground height) and `lColor` (rgb, size), drawn
 * within `range` of the camera.
 */
export function lightPointMaterial(
  lighting: PlanetLighting,
  exaggeration: UniformNode<'float', number>,
  range: UniformNode<'float', number>,
  brightness: UniformNode<'float', number>,
): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const base = attribute('lBase', 'vec3');
  const up = normalize(attribute('lUp', 'vec3'));
  const offset = attribute('lOffset', 'vec4');
  const color = attribute('lColor', 'vec4');
  const corner = attribute('position', 'vec3');
  const vCorner = varyingProperty('vec3', 'vLightCorner');
  const vColor = varyingProperty('vec3', 'vLightColor');
  m.positionNode = Fn(() => {
    // The ground point (not sunk like the buildings' bases), then the anchor's offset.
    const center = base.add(up.mul(max(offset.w, 0).mul(exaggeration))).add(offset.xyz);
    const world = modelWorldMatrix.mul(vec4(center, 1)).xyz;
    const dist = world.length();
    // Meters per device pixel at that distance.
    const focal = cameraProjectionMatrix.mul(vec4(0, 1, 0, 0)).y;
    const pixel = dist.mul(2).div(focal.mul(screenSize.y));
    const size = max(color.w, pixel.mul(LIGHT_MIN_PIXELS));
    const area = min(color.w.div(size), 1);
    // Camera-facing: the camera's right and up axes in world space.
    const right = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
    const camUp = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
    const ap = lighting.atmosphere.aerialPerspective(world as V3, 6);
    const fade = smoothstep(range, range.mul(0.85), dist);
    const on = lightsOn(up as V3, lighting.sunDirection);
    vColor.assign(
      color.xyz.mul(ap.transmittance).mul(area.sqrt()).mul(on).mul(fade).mul(brightness),
    );
    vCorner.assign(corner);
    return center
      .add(right.mul(corner.x.mul(size).mul(0.5)))
      .add(camUp.mul(corner.y.mul(size).mul(0.5)));
  })();
  m.colorNode = Fn(() => {
    const r2 = dot(vCorner.xy, vCorner.xy);
    // A hot core and a soft halo, zero at the quad's edge.
    const core = exp(r2.mul(-6));
    const halo = exp(r2.mul(-2)).mul(0.3);
    const edge = clamp(float(1).sub(r2), 0, 1);
    return vec4(vColor.mul(core.add(halo).mul(edge)), 1);
  })();
  return m;
}
