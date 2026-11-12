/**
 * Water drawn by the terrain material (decisions 37, 38). The sea is not a
 * separate mesh: terrain below sea level is displaced flat to 0 m, and its raw
 * (negative) height is interpolated per fragment. That gives:
 *
 * - a water mask whose coastline follows the h = 0 isoline, finer than the
 *   vertex grid, antialiased by fwidth;
 * - a depth per fragment, used for color.
 *
 * Lakes work the same way (decision 40): meshes carry a signed lake depth
 * (level − height), lakes are displayed flat at their level, and the zero
 * crossing of the interpolated depth is the shoreline.
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
 *
 * Coastal foam (decision 39): distance to the shore comes per vertex
 * (tileMesh `shore`: depth ÷ depth gradient from the samples). Foam
 * fills a band about `foamWidth` wide with surf lines moving shoreward, broken
 * up by the wave field. Once the band is narrower than a pixel, it fades to
 * its average coverage, so from orbit coasts get a faint light edge.
 */
import { Color } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  clamp,
  cos,
  dot,
  exp,
  float,
  Fn,
  fwidth,
  If,
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
import { rng } from '../../../core/rng';
import type { LightAt, PlanetLighting } from '../lighting/planetLighting';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Absorption of clear water per reference meter (red goes first, blue last). */
const ABSORPTION: [number, number, number] = [0.35, 0.055, 0.022];
/** Nominal river depth (reference m) for color: deep enough to read as water, not land. */
const RIVER_DEPTH = 30;
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
  /** Land albedo, shaded (rock, snow, season). */
  albedo: V3;
  /** The bed under water: the vertex color (seabed under the sea, biome under lakes). */
  bed: V3;
  /** Surface temperature today (°C): lakes freeze below about −2 °C. */
  temperature: F;
  /** Terrain normal (world). */
  normal: V3;
  /** Raw surface height, interpolated (m; negative under the sea). */
  height: F;
  /** Signed lake depth (m): positive under a lake. */
  lake: F;
  /** River coverage 0..1 as drawn (decision 46). */
  river: F;
  /**
   * The river's true pixel fraction, ≤ `river`: only it reflects the sun and
   * sky, so rivers widened for legibility do not glitter (decision 120).
   */
  riverReflect?: F;
  /** Signed coast distance (m), positive at sea. */
  shore: F;
  /** Unit radial direction at the fragment. */
  up: V3;
  /** Camera-relative position of the fragment. */
  relative: V3;
  /** Fragment position modulo WAVE_PERIOD (per-mesh wrapped origin + local position). */
  wavePosition: V3;
  /** Light at the fragment, if the material already built it (PlanetLighting.at). */
  light?: LightAt;
}

/** GGX α² added to the reflection of a river much narrower than its pixel (decision 120). */
const THIN_RIVER_ALPHA2 = 0.5;

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
  /** Width of the surf zone (m). */
  readonly foamWidth = uniform(90);
  /** Foam amount multiplier (0 = none). */
  readonly foamStrength = uniform(1);
  readonly waves = waveSet();
  /** Silt in warm rivers (decision 126): color (linear) and strength at full warmth. */
  readonly siltColor = uniform(new Color(0.16, 0.095, 0.04));
  readonly siltStrength = uniform(0.85);

  constructor(private readonly lighting: PlanetLighting) {}

  /** Radiance of a terrain fragment: land, or water over a seabed with waves and glint. */
  shade(i: WaterInputs): V3 {
    return Fn(() => {
      const L = this.lighting;
      // Everything that takes derivatives runs first, outside the water branch:
      // WGSL allows derivatives only in uniform control flow.
      const at = i.light ?? L.at(i.relative);
      const fw = max(fwidth(i.height), 1e-3);
      const sea = smoothstep(fw.negate(), fw, i.height.negate()).mul(this.enabled).toVar();
      const lfw = max(fwidth(i.lake), 1e-3);
      const lake = smoothstep(lfw.negate(), lfw, i.lake).mul(this.enabled).toVar();
      const river = i.river.mul(this.enabled).mul(float(1).sub(sea)).toVar();
      const wet = max(max(sea, lake), river).toVar();
      const footprint = max(length(fwidth(i.wavePosition)), 1e-4).toVar();
      const land = L.shadeDiffuse(i.albedo, i.normal, i.relative, at).toVar();
      const out = land.toVar();
      // Dry land skips the water body, waves, glint and foam (decision 69).
      If(wet.greaterThan(0), () => {
        // Body color: the bed seen through the water column (reference depth).
        // Rivers run in their carved channels at a nominal depth.
        const standing = mix(max(i.lake, 0), max(i.height.negate(), 0), sea);
        const waterDepth = mix(
          standing,
          float(RIVER_DEPTH).mul(this.reliefScale),
          river.mul(float(1).sub(lake)),
        );
        const depth = vec3(waterDepth.div(this.reliefScale));
        const bedVisible = exp(depth.mul(vec3(...ABSORPTION)).mul(-2));
        const clear = mix(this.deepColor, i.bed, bedVisible) as V3;
        // Warm rivers carry silt (decision 126): the Amazon's and the Nile's brown.
        const riverShare = clamp(river.div(max(wet, 1e-4)), 0, 1).mul(float(1).sub(max(sea, lake)));
        const turbid = riverShare.mul(smoothstep(10, 22, i.temperature)).mul(this.siltStrength);
        const body = mix(clear, this.siltColor, turbid) as V3;

        // Waves: tangent-plane slope from resolved waves, variance from the rest.
        let grad: V3 = vec3(0);
        let unresolved: F = float(0);
        // Crests of the shorter waves, for breaking up the foam.
        let crest: F = float(0);
        for (const [index, w] of this.waves.entries()) {
          const k = (2 * Math.PI) / WAVE_PERIOD;
          const kv = vec3(w.n[0] * k, w.n[1] * k, w.n[2] * k);
          const omega = Math.sqrt(GRAVITY * ((2 * Math.PI) / w.wavelength));
          const resolved = smoothstep(2, 6, footprint.reciprocal().mul(w.wavelength));
          const s = this.waveStrength.mul(w.slope);
          const phase = dot(kv, i.wavePosition).sub(time.mul(omega)).add(w.phase);
          const dir = vec3(w.n[0], w.n[1], w.n[2]).div(Math.hypot(...w.n));
          grad = grad.add(dir.mul(cos(phase).mul(s).mul(resolved))) as V3;
          if (index >= this.waves.length / 2) crest = crest.add(cos(phase).mul(resolved)) as F;
          unresolved = unresolved.add(
            float(slopeVariance(w.slope))
              .mul(this.waveStrength.mul(this.waveStrength))
              .mul(float(1).sub(resolved)),
          ) as F;
        }
        const tangentGrad = grad.sub(i.up.mul(dot(grad, i.up)));
        const waveNormal = normalize(i.up.sub(tangentGrad)) as V3;
        // Beckmann–GGX correspondence: α² ≈ 2σ².
        // A river drawn wider than it is (decision 46) reflects only its true share of
        // the pixel, and over a broad lobe: banks, bends and ripples average out within
        // a pixel it does not fill, so its glint spreads instead of saturating (decision 120).
        // How much of this pixel's water is river alone (1 where no sea or lake).
        const riverOnly = clamp(river.div(max(wet, 1e-4)), 0, 1).mul(float(1).sub(max(sea, lake)));
        const trueShare = i.riverReflect
          ? clamp(i.riverReflect.div(max(river, 1e-4)), 0, 1)
          : float(1);
        const thin = riverOnly.mul(float(1).sub(trueShare));
        const reflectShare = float(1).sub(thin);
        const alpha2 = this.baseRoughness
          .mul(this.baseRoughness)
          .add(unresolved.mul(2))
          .add(thin.mul(THIN_RIVER_ALPHA2));

        // Lighting of the water surface.
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
        const sunLight = at.sunlight;
        const glint = sunLight.mul(ggx.mul(fresnel).mul(nDotL).div(nDotV.mul(4)).mul(Math.PI));
        // Sky reflection: the average sky radiance at this sun elevation.
        const sky = L.atmosphere
          .skyIrradiance(dot(i.up, sun))
          .mul(L.sunIlluminance.mul(L.skyLight))
          .mul(fresnel);
        // Coastal foam.
        const shoreDistance = max(i.shore, 0);
        const band = this.foamWidth;
        const inBand = float(1).sub(smoothstep(0, max(band, footprint.mul(1.5)), shoreDistance));
        const surf = cos(shoreDistance.div(14).add(time.mul(0.8)))
          .mul(0.5)
          .add(0.5);
        const breakup = crest
          .div(Math.sqrt(this.waves.length / 2))
          .mul(0.5)
          .add(0.5);
        const pattern = smoothstep(0.35, 0.75, surf.mul(0.55).add(breakup.mul(0.45)));
        // Narrower than a few pixels: the pattern averages out, then the band thins.
        const detail = smoothstep(1, 4, band.div(footprint));
        const foam = inBand
          .mul(mix(float(0.3), pattern, detail))
          .mul(clamp(band.div(footprint), 0, 1))
          .mul(this.foamStrength)
          .mul(sea);
        const foamy = clamp(foam, 0, 1);
        const surface = mix(body, vec3(0.8, 0.82, 0.82), foamy) as V3;

        const bodyLight = L.shadeDiffuse(surface, i.up, i.relative, at).mul(float(1).sub(fresnel));
        const water = bodyLight.add(
          sky
            .add(glint.mul(clamp(nDotL.mul(20), 0, 1)))
            .mul(float(1).sub(foamy))
            .mul(reflectShare),
        );

        // Lakes freeze in the cold season (sea ice stays a static biome until weather exists).
        const frozen = smoothstep(-1.5, -4, i.temperature).mul(lake).mul(float(1).sub(sea));
        const ice = L.shadeDiffuse(vec3(0.75, 0.8, 0.86), i.up, i.relative, at);
        out.assign(mix(land, mix(water, ice, frozen), wet));
      });
      return out;
    })() as V3;
  }
}
