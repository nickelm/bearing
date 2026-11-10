/**
 * Water drawn by the terrain material (decision 37). The sea is not a
 * separate mesh: terrain below sea level is displaced flat to 0 m, and its raw
 * (negative) height is interpolated per fragment. That gives:
 *
 * - a water mask whose coastline follows the h = 0 isoline, finer than the
 *   vertex grid, antialiased by fwidth;
 * - a depth per fragment, used for color.
 *
 * Lakes come from a per-vertex coverage attribute, at a nominal depth.
 *
 * Color is absorption over twice the depth (down to the bed and back up),
 * measured in reference meters (depth ÷ reliefScale). Decision 14 makes real
 * depths about 6× shallower than Earth's; reference depth keeps shelves
 * turquoise and the deep ocean navy.
 */
import { Color } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { exp, fwidth, max, mix, normalize, smoothstep, uniform, vec3 } from 'three/tsl';
import type { PlanetLighting } from '../lighting/planetLighting';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Absorption of clear water per reference meter (red goes first, blue last). */
const ABSORPTION: [number, number, number] = [0.35, 0.055, 0.022];
/** Nominal reference depth for lakes (their depth is not carried per vertex). */
const LAKE_DEPTH = 18;

export interface WaterInputs {
  /** Land albedo, or the seabed under the sea (linear). */
  albedo: V3;
  /** Terrain normal (world). */
  normal: V3;
  /** Raw surface height, interpolated (m; negative under the sea). */
  height: F;
  /** Lake coverage 0..1. */
  lake: F;
  /** Unit radial direction at the fragment. */
  up: V3;
  /** Camera-relative position of the fragment. */
  relative: V3;
}

export class WaterShading {
  /** 1 draws water; 0 in debug color modes, which show the raw vertex colors. */
  readonly enabled = uniform(1);
  /** World relief scale (decision 14), for reference depths. */
  readonly reliefScale = uniform(0.157);
  /** Color of deep water lit from above (linear albedo of the water body). */
  readonly deepColor = uniform(new Color(0.006, 0.022, 0.06));

  constructor(private readonly lighting: PlanetLighting) {}

  /** Radiance of a terrain fragment: land, or water over a seabed. */
  shade(i: WaterInputs): V3 {
    const fw = max(fwidth(i.height), 1e-3);
    const sea = smoothstep(fw.negate(), fw, i.height.negate()).mul(this.enabled);
    const lake = i.lake.mul(this.enabled);
    const wet = max(sea, lake);
    const depth = mix(vec3(LAKE_DEPTH), vec3(max(i.height.negate(), 0).div(this.reliefScale)), sea);
    const bedVisible = exp(depth.mul(vec3(...ABSORPTION)).mul(-2));
    const water = mix(this.deepColor, i.albedo, bedVisible);
    const albedo = mix(i.albedo, water, wet) as V3;
    const normal = normalize(mix(i.normal, i.up, wet)) as V3;
    return this.lighting.shadeDiffuse(albedo, normal, i.relative);
  }
}
