/**
 * The strategic map's finish (visual-style Part II, Strategic Post-Processing;
 * decision 92), applied in the map's own shaders rather than in a separate pass:
 *
 * - **Vignette.** Corners darken by up to `VIGNETTE` (8%), starting 45% of the way
 *   from the center to a corner.
 * - **Paper grain.** A constant per-pixel variation of ±`GRAIN` (2.5%), fixed to the
 *   screen like the paper under a printed map, so it never swims with the terrain.
 * - **Rim.** The background draws a thin pale rim (`RIM`, about 1.5 px) just outside
 *   the globe's silhouette, in place of the simulation view's limb glow. Part II
 *   allows no atmosphere on the map.
 *
 * The relief and the background apply `paperFinish`; the night lights' additive
 * halos are the only glow (decision 88). `vignetteFactor` is the CPU reference.
 */
import type { Node } from 'three/webgpu';
import {
  acos,
  asin,
  clamp,
  dot,
  exp,
  float,
  floor,
  Fn,
  length,
  mix,
  normalize,
  normalWorldGeometry,
  screenCoordinate,
  screenUV,
  smoothstep,
  vec3,
} from 'three/tsl';
import { srgbToLinear } from '../common/palette';
import { hash12Node } from './patterns';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

export const VIGNETTE = 0.08;
export const GRAIN = 0.025;
/** Rim width (px, Gaussian scale) and color. */
export const RIM_PX = 1.5;
export const RIM = 0xd9e4e8;
/** Background behind the globe (Part II has no physical sky). */
export const BACKGROUND = 0x1e2630;

const lin = (h: number) =>
  vec3(
    srgbToLinear(((h >> 16) & 255) / 255),
    srgbToLinear(((h >> 8) & 255) / 255),
    srgbToLinear((h & 255) / 255),
  ) as V3;

/** Vignette multiplier at screen coordinates (u, v in 0..1). */
export function vignetteFactor(u: number, v: number): number {
  const d = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2) / Math.SQRT2;
  const t = Math.min(1, Math.max(0, (d - 0.45) / (1 - 0.45)));
  return 1 - VIGNETTE * t * t * (3 - 2 * t);
}

/** Vignette and paper grain over a color; `strength` 0..1 (0 turns them off). */
export function paperFinish(color: V3, strength: F): V3 {
  const d = length(screenUV.sub(0.5).mul(2)).div(Math.SQRT2);
  const vignette = float(1).sub(smoothstep(0.45, 1, d).mul(VIGNETTE));
  const grain = hash12Node(floor(screenCoordinate.xy))
    .sub(0.5)
    .mul(2 * GRAIN);
  const finish = mix(float(1), vignette.mul(grain.add(1)), strength);
  return color.mul(finish) as V3;
}

export interface RimUniforms {
  /** Planet center relative to the camera (−eye), and the planet radius (m). */
  center: V3;
  radius: number;
  /** Radians per drawing-buffer pixel. */
  pixelAngle: F;
  strength: F;
}

/** The map's background: flat, with the pale rim outside the globe, finished like the map. */
export function backgroundNode(u: RimUniforms): V3 {
  return Fn(() => {
    const rd = normalize(normalWorldGeometry);
    const dist = length(u.center);
    const toCenter = u.center.div(dist);
    // Angle of the ray outside the limb, in pixels.
    const angle = acos(clamp(dot(rd, toCenter), -1, 1));
    const limb = asin(clamp(float(u.radius).div(dist), 0, 1));
    const px = angle.sub(limb).div(u.pixelAngle);
    // The globe covers everything inside the limb, so only the outer half shows.
    const rim = exp(px.div(RIM_PX).pow(2).negate());
    const color = mix(lin(BACKGROUND), lin(RIM), rim.mul(0.85));
    return paperFinish(color as V3, u.strength);
  })() as V3;
}
