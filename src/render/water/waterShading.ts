/**
 * Water drawn by the terrain material (decisions 37, 38). The sea is not a
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
 *
 * Surface (decision 38):
 * - Waves are a fixed set of plane waves in 3D. Their wave vectors are
 *   integer multiples of 2π/WAVE_PERIOD, so they tile with that period, and
 *   each mesh passes its origin modulo the period (computed in float64).
 *   Fragments evaluate the waves on small, precise coordinates.
 * - Waves shorter than a few pixels fade out. Their slope variance moves into
 *   the GGX roughness, so from orbit the glint widens into a sunglint instead
 *   of aliasing.
 * - Fresnel (Schlick, F0 = 0.02) mixes the water body with a reflection of
 *   the average sky.
 */
import { Color } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  clamp,
  cos,
  dot,
  exp,
  float,
  fwidth,
  length,
  max,
  mix,
  normalize,
  pow,
  smoothstep,
  time,
  uniform,
  vec3,
} from 'three/tsl';
import { rng } from '../../core/rng';
import type { PlanetLighting } from '../lighting/planetLighting';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Absorption of clear water per reference meter (red goes first, blue last). */
const ABSORPTION: [number, number, number] = [0.35, 0.055, 0.022];
/** Nominal reference depth for lakes (their depth is not carried per vertex). */
const LAKE_DEPTH = 18;
/** Wave field period (m): every wave vector is an integer multiple of 2π/WAVE_PERIOD. */
export const WAVE_PERIOD = 4096;
const GRAVITY = 9.81;

export interface Wave {
  /** Integer lattice vector: k = 2π·n / WAVE_PERIOD. */
  n: [number, number, number];
  wavelength: number;
  /** Peak slope (amplitude × wavenumber). */
  slope: number;
  phase: number;
}

/**
 * The wave set: wavelengths 1.5–180 m (log-spaced, jittered) in random
 * directions, deterministic. Many waves of equal small slope, so the pattern
 * reads as chaotic rather than as a lattice. The total slope variance,
 * count × slope²/2 ≈ 0.03, matches Cox–Munk for a moderate breeze.
 */
export function waveSet(count = 32): Wave[] {
  const r = rng(0, 'render/waves');
  const waves: Wave[] = [];
  for (let i = 0; i < count; i++) {
    const lambda = 180 * Math.pow(1.5 / 180, (i + 0.8 * (r.nextFloat() - 0.5)) / (count - 1));
    // Uniform direction on the sphere.
    const z = 2 * r.nextFloat() - 1;
    const a = 2 * Math.PI * r.nextFloat();
    const s = Math.sqrt(1 - z * z);
    const m = WAVE_PERIOD / lambda;
    const n: [number, number, number] = [
      Math.round(s * Math.cos(a) * m),
      Math.round(s * Math.sin(a) * m),
      Math.round(z * m),
    ];
    const len = Math.hypot(...n);
    waves.push({
      n,
      wavelength: WAVE_PERIOD / len,
      slope: 0.044,
      phase: 2 * Math.PI * r.nextFloat(),
    });
  }
  return waves;
}

/** Slope variance of a wave of peak slope s: s²/2 (one direction). */
const slopeVariance = (s: number) => (s * s) / 2;

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
  /** Fragment position modulo WAVE_PERIOD (per-mesh wrapped origin + local position). */
  wavePosition: V3;
}

export class WaterShading {
  /** 1 draws water; 0 in debug color modes, which show the raw vertex colors. */
  readonly enabled = uniform(1);
  /** World relief scale (decision 14), for reference depths. */
  readonly reliefScale = uniform(0.157);
  /** Color of deep water lit from above (linear albedo of the water body). */
  readonly deepColor = uniform(new Color(0.006, 0.022, 0.06));
  /** Multiplies every wave's slope (0 = mirror-flat). */
  readonly waveStrength = uniform(1);
  /** Roughness of the water surface below the smallest wave. */
  readonly baseRoughness = uniform(0.04);
  readonly waves = waveSet();

  constructor(private readonly lighting: PlanetLighting) {}

  /** Radiance of a terrain fragment: land, or water over a seabed with waves and glint. */
  shade(i: WaterInputs): V3 {
    const L = this.lighting;
    const fw = max(fwidth(i.height), 1e-3);
    const sea = smoothstep(fw.negate(), fw, i.height.negate()).mul(this.enabled);
    const lake = i.lake.mul(this.enabled);
    const wet = max(sea, lake);

    // Body color: the seabed seen through the water column.
    const depth = mix(vec3(LAKE_DEPTH), vec3(max(i.height.negate(), 0).div(this.reliefScale)), sea);
    const bedVisible = exp(depth.mul(vec3(...ABSORPTION)).mul(-2));
    const body = mix(this.deepColor, i.albedo, bedVisible) as V3;

    // Waves: tangent-plane slope from resolved waves, variance from the rest.
    const footprint = max(length(fwidth(i.wavePosition)), 1e-4);
    let grad: V3 = vec3(0);
    let unresolved: F = float(0);
    for (const w of this.waves) {
      const k = (2 * Math.PI) / WAVE_PERIOD;
      const kv = vec3(w.n[0] * k, w.n[1] * k, w.n[2] * k);
      const omega = Math.sqrt(GRAVITY * ((2 * Math.PI) / w.wavelength));
      const resolved = smoothstep(2, 6, footprint.reciprocal().mul(w.wavelength));
      const s = this.waveStrength.mul(w.slope);
      const phase = dot(kv, i.wavePosition).sub(time.mul(omega)).add(w.phase);
      const dir = vec3(w.n[0], w.n[1], w.n[2]).div(Math.hypot(...w.n));
      grad = grad.add(dir.mul(cos(phase).mul(s).mul(resolved))) as V3;
      unresolved = unresolved.add(
        float(slopeVariance(w.slope))
          .mul(this.waveStrength.mul(this.waveStrength))
          .mul(float(1).sub(resolved)),
      ) as F;
    }
    const tangentGrad = grad.sub(i.up.mul(dot(grad, i.up)));
    const waveNormal = normalize(i.up.sub(tangentGrad)) as V3;
    // Beckmann–GGX correspondence: α² ≈ 2σ².
    const alpha2 = this.baseRoughness.mul(this.baseRoughness).add(unresolved.mul(2));

    // Lighting of the water surface.
    const p = L.planetPosition(i.relative);
    const v = normalize(i.relative.negate()) as V3;
    const sun = L.sunDirection;
    const h = normalize(v.add(sun));
    const nDotL = max(dot(waveNormal, sun), 0);
    const nDotV = max(dot(waveNormal, v), 1e-3);
    const nDotH = max(dot(waveNormal, h), 0);
    const d = nDotH.mul(nDotH).mul(alpha2.sub(1)).add(1);
    const ggx = alpha2.div(d.mul(d).mul(Math.PI));
    const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(nDotV), 5)));
    // Specular radiance: π·E·D·F/(4·N·V) with E = π × the display sun illuminance (decision 34).
    const sunLight = L.atmosphere.sunTransmittance(p).mul(L.sunIlluminance);
    const glint = sunLight.mul(ggx.mul(fresnel).mul(nDotL).div(nDotV.mul(4)).mul(Math.PI));
    // Sky reflection: the average sky radiance at this sun elevation.
    const sky = L.atmosphere
      .skyIrradiance(dot(i.up, sun))
      .mul(L.sunIlluminance.mul(L.skyLight))
      .mul(fresnel);
    const bodyLight = L.shadeDiffuse(body, i.up, i.relative).mul(float(1).sub(fresnel));
    const water = bodyLight.add(sky).add(glint.mul(clamp(nDotL.mul(20), 0, 1)));

    const land = L.shadeDiffuse(i.albedo, i.normal, i.relative);
    return mix(land, water, wet) as V3;
  }
}
