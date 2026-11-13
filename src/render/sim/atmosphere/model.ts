/**
 * Atmosphere model (decisions 35, 140): Earth-like air on the planet (decision
 * 14 keeps the atmosphere real), in pure TypeScript so Vitest can check it.
 *
 * Coefficients follow Hillaire (2020), "A Scalable and Production Ready Sky
 * and Atmosphere Rendering Technique": Rayleigh and Mie scattering with
 * exponential density profiles, plus ozone absorption in a tent profile
 * around 25 km. Distances in meters, coefficients per meter (RGB at roughly
 * 680, 550 and 440 nm).
 *
 * Three tables, all computed here and uploaded by atmosphere.ts:
 *
 * - The transmittance LUT stores transmittance from a point at radius r along
 *   direction cosine μ to the top of the atmosphere, in Bruneton's
 *   parameterization ("Precomputed Atmospheric Scattering", 2017 revision).
 * - The multiple-scattering LUT stores Hillaire's Ψ over (sun-zenith cosine,
 *   altitude): the light a point receives from every order of scattering
 *   above the first, per unit sun illuminance, treated as isotropic. Adding
 *   Ψ times the scattering coefficient to the single-scattering source gives
 *   the sky its twilight, its lit shadow side and its pale horizon.
 * - The sky-irradiance LUT stores the sky's light on level ground over the
 *   sun-zenith cosine.
 *
 * `skyScattering` is the reference for the sky: the GPU's sky-view LUT
 * (skyView.ts) and its march (atmosphere.ts) compute the same integral and
 * are tested against it. The same mappings are written in TSL there.
 */

import { EARTH_RADIUS } from '../../../core/units';

export type Rgb = [number, number, number];

export interface AtmosphereParams {
  /** Planet (sea-level) radius. */
  groundRadius: number;
  /** Top of the atmosphere, as a radius. */
  topRadius: number;
  rayleighScattering: Rgb;
  rayleighScaleHeight: number;
  mieScattering: number;
  mieExtinction: number;
  mieScaleHeight: number;
  /** Henyey–Greenstein asymmetry for Mie scattering. */
  mieG: number;
  ozoneAbsorption: Rgb;
  ozoneCenter: number;
  ozoneHalfWidth: number;
  /** Mean diffuse reflectance of the ground and the cloud below, for the light it sends back into the air. */
  groundAlbedo: number;
  /** Multiplies every coefficient (GUI tuning; 1 = Earth's air). */
  density: number;
}

/**
 * Earth's air on a planet of the given radius. One coefficient is not
 * Earth's: the ozone's absorption is multiplied by √(R_Earth / R), 2.52 on
 * the 1,000 km planet. Twilight's colors (the blue hour, the pink band and
 * the planet's blue shadow opposite the sun) come from sunlight that crosses
 * the ozone layer at grazing incidence, and a grazing path through a shell
 * is shorter on a smaller planet by √(R / R_Earth). The factor gives that
 * path Earth's optical depth; without it twilight is gray and olive. By day
 * it costs about 4% of the green in sunlight from overhead.
 */
export function earthLikeAtmosphere(groundRadius: number): AtmosphereParams {
  const ozone = Math.sqrt(EARTH_RADIUS / groundRadius);
  return {
    groundRadius,
    topRadius: groundRadius + 100_000,
    rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
    rayleighScaleHeight: 8000,
    mieScattering: 3.996e-6,
    mieExtinction: 4.4e-6,
    mieScaleHeight: 1200,
    mieG: 0.8,
    ozoneAbsorption: [0.65e-6 * ozone, 1.881e-6 * ozone, 0.085e-6 * ozone],
    ozoneCenter: 25_000,
    ozoneHalfWidth: 15_000,
    groundAlbedo: 0.3,
    density: 1,
  };
}

/** Extinction coefficient per meter at an altitude above sea level. */
export function extinctionAt(a: AtmosphereParams, altitude: number, out: Rgb): Rgb {
  const h = Math.max(0, altitude);
  const r = Math.exp(-h / a.rayleighScaleHeight);
  const m = Math.exp(-h / a.mieScaleHeight);
  const o = Math.max(0, 1 - Math.abs(h - a.ozoneCenter) / a.ozoneHalfWidth);
  for (let c = 0; c < 3; c++) {
    out[c] =
      a.density * (a.rayleighScattering[c]! * r + a.mieExtinction * m + a.ozoneAbsorption[c]! * o);
  }
  return out;
}

/** Distance from radius r along direction cosine μ to the top of the atmosphere. */
export function distanceToTop(a: AtmosphereParams, r: number, mu: number): number {
  const disc = r * r * (mu * mu - 1) + a.topRadius * a.topRadius;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
}

/** Whether a ray from radius r with direction cosine μ hits the ground. */
export function rayHitsGround(a: AtmosphereParams, r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + a.groundRadius * a.groundRadius >= 0;
}

/** Transmittance to the top of the atmosphere by numerical integration (the LUT's reference). */
export function transmittanceToTop(a: AtmosphereParams, r: number, mu: number, steps = 500): Rgb {
  const d = distanceToTop(a, r, mu);
  const dt = d / steps;
  const depth: Rgb = [0, 0, 0];
  const e: Rgb = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const ri = Math.sqrt(r * r + t * t + 2 * r * mu * t);
    extinctionAt(a, ri - a.groundRadius, e);
    depth[0] += e[0] * dt;
    depth[1] += e[1] * dt;
    depth[2] += e[2] * dt;
  }
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

export const TRANSMITTANCE_WIDTH = 256;
export const TRANSMITTANCE_HEIGHT = 64;

/** Maps [0, 1] onto texel centers of an n-texel axis. */
const toTexel = (x: number, n: number) => 0.5 / n + x * (1 - 1 / n);
const fromTexel = (u: number, n: number) => (u - 0.5 / n) / (1 - 1 / n);

/** LUT texture coordinates (u, v) for (r, μ). */
export function transmittanceUv(a: AtmosphereParams, r: number, mu: number): [number, number] {
  const H = Math.sqrt(a.topRadius ** 2 - a.groundRadius ** 2);
  const rho = Math.sqrt(Math.max(0, r * r - a.groundRadius ** 2));
  const d = distanceToTop(a, r, mu);
  const dMin = a.topRadius - r;
  const dMax = rho + H;
  const xMu = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0;
  return [toTexel(xMu, TRANSMITTANCE_WIDTH), toTexel(rho / H, TRANSMITTANCE_HEIGHT)];
}

/** (r, μ) for LUT texture coordinates (inverse of transmittanceUv). */
export function transmittanceRMu(a: AtmosphereParams, u: number, v: number): [number, number] {
  const H = Math.sqrt(a.topRadius ** 2 - a.groundRadius ** 2);
  const rho = H * fromTexel(v, TRANSMITTANCE_HEIGHT);
  const r = Math.sqrt(rho * rho + a.groundRadius ** 2);
  const dMin = a.topRadius - r;
  const dMax = rho + H;
  const d = dMin + fromTexel(u, TRANSMITTANCE_WIDTH) * (dMax - dMin);
  const mu = d === 0 ? 1 : (H * H - rho * rho - d * d) / (2 * r * d);
  return [r, Math.max(-1, Math.min(1, mu))];
}

/** The transmittance LUT, RGBA float32 (alpha 1), row-major from v = 0. */
export function computeTransmittanceLut(a: AtmosphereParams, steps = 64): Float32Array {
  const w = TRANSMITTANCE_WIDTH;
  const h = TRANSMITTANCE_HEIGHT;
  const out = new Float32Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [r, mu] = transmittanceRMu(a, (i + 0.5) / w, (j + 0.5) / h);
      const t = transmittanceToTop(a, r, mu, steps);
      const o = (j * w + i) * 4;
      out[o] = t[0];
      out[o + 1] = t[1];
      out[o + 2] = t[2];
      out[o + 3] = 1;
    }
  }
  return out;
}

/** Bilinear lookup in a LUT built by computeTransmittanceLut (CPU twin of the shader lookup). */
export function sampleTransmittanceLut(
  a: AtmosphereParams,
  lut: Float32Array,
  r: number,
  mu: number,
): Rgb {
  const [u, v] = transmittanceUv(a, r, mu);
  const w = TRANSMITTANCE_WIDTH;
  const h = TRANSMITTANCE_HEIGHT;
  const x = Math.max(0, Math.min(w - 1, u * w - 0.5));
  const y = Math.max(0, Math.min(h - 1, v * h - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const at = (i: number, j: number) => lut[(j * w + i) * 4 + c]!;
    out[c] =
      (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) +
      (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
  }
  return out;
}

/** Rayleigh phase function. */
export function rayleighPhase(cosTheta: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
}

/** Henyey–Greenstein phase function. */
export function hgPhase(cosTheta: number, g: number): number {
  return (1 - g * g) / (4 * Math.PI * Math.pow(1 + g * g - 2 * g * cosTheta, 1.5));
}

/** Smooth planet shadow on sunlight (CPU twin of the shader's penumbra). */
export function planetShadow(a: AtmosphereParams, r: number, muS: number): number {
  const muH = -Math.sqrt(Math.max(0, 1 - (a.groundRadius / r) ** 2));
  const x = Math.max(0, Math.min(1, (muS - (muH - 0.006)) / 0.012));
  return x * x * (3 - 2 * x);
}

/** The tables the sky integral reads. */
export interface AtmosphereLuts {
  transmittance: Float32Array;
  multiScattering: Float32Array;
}

/** Texels per axis of the multiple-scattering LUT. */
export const MULTI_SCATTERING_SIZE = 32;

/** LUT texture coordinates (u, v) for a radius and a sun-zenith cosine. */
export function multiScatteringUv(a: AtmosphereParams, r: number, muS: number): [number, number] {
  const h = (r - a.groundRadius) / (a.topRadius - a.groundRadius);
  return [
    toTexel(Math.max(0, Math.min(1, 0.5 + 0.5 * muS)), MULTI_SCATTERING_SIZE),
    toTexel(Math.max(0, Math.min(1, h)), MULTI_SCATTERING_SIZE),
  ];
}

/** Distance along a ray from radius r with direction cosine μ to the ground, or to the top of the air. */
function rayLength(a: AtmosphereParams, r: number, mu: number): number {
  return rayHitsGround(a, r, mu)
    ? -r * mu - Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + a.groundRadius ** 2))
    : distanceToTop(a, r, mu);
}

/**
 * The multiple-scattering LUT (Hillaire 2020, section 5.5), RGBA float32,
 * row-major from v = 0 (sea level). For each (sun-zenith cosine, altitude) it
 * integrates over `polarSteps` × `azimuthSteps` directions the second-order light L₂
 * reaching the point (single scattering with an isotropic phase function,
 * plus sunlight the ground reflects) and the fraction f of isotropic light
 * the air around scatters back to it, and stores Ψ = L₂ / (1 − f): the sum of
 * every higher order as a geometric series. The polar angle takes most of
 * the samples: in twilight the light comes from a thin band of directions
 * above the planet's shadow.
 */
export function computeMultiScatteringLut(
  a: AtmosphereParams,
  transmittance: Float32Array,
  polarSteps = 32,
  azimuthSteps = 3,
  steps = 12,
): Float32Array {
  const n = MULTI_SCATTERING_SIZE;
  const out = new Float32Array(n * n * 4);
  const e: Rgb = [0, 0, 0];
  const isotropic = 1 / (4 * Math.PI);
  const count = polarSteps * azimuthSteps;
  for (let j = 0; j < n; j++) {
    // Texel rows end a meter inside the shell, so no ray starts on a boundary.
    const r = a.groundRadius + 1 + fromTexel((j + 0.5) / n, n) * (a.topRadius - a.groundRadius - 2);
    for (let i = 0; i < n; i++) {
      const muS = Math.max(-1, Math.min(1, 2 * fromTexel((i + 0.5) / n, n) - 1));
      const sx = Math.sqrt(1 - muS * muS);
      const L: Rgb = [0, 0, 0];
      const f: Rgb = [0, 0, 0];
      for (let di = 0; di < polarSteps; di++) {
        const cz = 1 - (2 * (di + 0.5)) / polarSteps;
        const sz = Math.sqrt(1 - cz * cz);
        // The light is symmetric about the sun's vertical plane: half the azimuths stand for all.
        for (let dj = 0; dj < azimuthSteps; dj++) {
          const phi = (Math.PI * (dj + 0.5)) / azimuthSteps;
          const dx = sz * Math.cos(phi);
          const dz = sz * Math.sin(phi);
          const dist = rayLength(a, r, cz);
          const dt = dist / steps;
          const T: Rgb = [1, 1, 1];
          for (let k = 0; k < steps; k++) {
            const t = (k + 0.5) * dt;
            const px = dx * t;
            const py = r + cz * t;
            const pz = dz * t;
            const rp = Math.sqrt(px * px + py * py + pz * pz);
            const h = Math.max(0, rp - a.groundRadius);
            const mu = (px * sx + py * muS) / rp;
            const sunT = sampleTransmittanceLut(a, transmittance, rp, mu);
            const shadow = planetShadow(a, rp, mu);
            const rhoR = Math.exp(-h / a.rayleighScaleHeight);
            const rhoM = Math.exp(-h / a.mieScaleHeight);
            extinctionAt(a, h, e);
            for (let c = 0; c < 3; c++) {
              const scat = a.density * (a.rayleighScattering[c]! * rhoR + a.mieScattering * rhoM);
              const stepT = Math.exp(-e[c] * dt);
              const w = (T[c] * (1 - stepT)) / Math.max(e[c], 1e-12);
              L[c] += w * scat * sunT[c] * shadow * isotropic;
              f[c] += w * scat;
              T[c] *= stepT;
            }
          }
          if (rayHitsGround(a, r, cz)) {
            // Sunlight the ground sends back up the ray.
            const gx = dx * dist;
            const gy = r + cz * dist;
            const gz = dz * dist;
            const rg = Math.sqrt(gx * gx + gy * gy + gz * gz);
            const mu = (gx * sx + gy * muS) / rg;
            if (mu > 0) {
              const sunT = sampleTransmittanceLut(a, transmittance, a.groundRadius, mu);
              for (let c = 0; c < 3; c++) {
                L[c] += (T[c] * sunT[c] * mu * a.groundAlbedo) / Math.PI;
              }
            }
          }
        }
      }
      const o = (j * n + i) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = L[c] / count / (1 - f[c] / count);
      out[o + 3] = 1;
    }
  }
  return out;
}

/** Bilinear lookup of Ψ in a LUT built by computeMultiScatteringLut. */
export function sampleMultiScatteringLut(
  a: AtmosphereParams,
  lut: Float32Array,
  r: number,
  muS: number,
): Rgb {
  const [u, v] = multiScatteringUv(a, r, muS);
  const n = MULTI_SCATTERING_SIZE;
  const x = Math.max(0, Math.min(n - 1, u * n - 0.5));
  const y = Math.max(0, Math.min(n - 1, v * n - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const at = (i: number, j: number) => lut[(j * n + i) * 4 + c]!;
    out[c] =
      (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) +
      (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
  }
  return out;
}

/** Both tables for a set of parameters. */
export function computeAtmosphereLuts(a: AtmosphereParams): AtmosphereLuts {
  const transmittance = computeTransmittanceLut(a);
  return { transmittance, multiScattering: computeMultiScatteringLut(a, transmittance) };
}

/**
 * How the sky integral spaces its samples along a ray of length L: sample i
 * of n covers t from L·g(i/n) to L·g((i+1)/n) with g(x) = x·(SKY_STEP_LINEAR
 * + (1 − SKY_STEP_LINEAR)·x). Steps grow with distance, since the air a
 * camera inside the atmosphere looks through is densest near it; the linear
 * part keeps the far end, where a ray toward the ground ends in dense air
 * again, from getting too coarse.
 */
export const SKY_STEP_LINEAR = 0.3;

/** g(x) of SKY_STEP_LINEAR's comment. */
export function skyStepFraction(x: number): number {
  return x * (SKY_STEP_LINEAR + (1 - SKY_STEP_LINEAR) * x);
}

/** The sky along a ray, split so the sharp Mie phase function can be applied afterwards. */
export interface SkyScattering {
  /** Rayleigh single scattering with its phase function, plus multiple scattering. */
  base: Rgb;
  /** Mie single scattering without its phase function. */
  mie: Rgb;
  /** Transmittance along the ray. */
  transmittance: Rgb;
}

/**
 * The sky's in-scattered radiance per unit sun illuminance, seen from a point
 * at radius r (on the y axis) along unit direction `d`, with the sun along
 * `s`: single scattering, and every higher order through Ψ. The ray ends at
 * the ground or at the top of the air. `linear` 1 spaces the samples evenly
 * (as the shader's march does); the default spaces them as the sky-view LUT.
 */
export function skyScattering(
  a: AtmosphereParams,
  luts: AtmosphereLuts,
  r: number,
  d: readonly [number, number, number],
  s: readonly [number, number, number],
  steps = 48,
  linear = SKY_STEP_LINEAR,
): SkyScattering {
  const dist = rayLength(a, r, d[1]);
  const cosTheta = d[0] * s[0] + d[1] * s[1] + d[2] * s[2];
  const pR = rayleighPhase(cosTheta);
  const T: Rgb = [1, 1, 1];
  const base: Rgb = [0, 0, 0];
  const mie: Rgb = [0, 0, 0];
  const e: Rgb = [0, 0, 0];
  const g = (x: number) => x * (linear + (1 - linear) * x);
  for (let i = 0; i < steps; i++) {
    const ta = dist * g(i / steps);
    const tb = dist * g((i + 1) / steps);
    const dt = tb - ta;
    const t = 0.5 * (ta + tb);
    const px = d[0] * t;
    const py = r + d[1] * t;
    const pz = d[2] * t;
    const rp = Math.sqrt(px * px + py * py + pz * pz);
    const h = Math.max(0, rp - a.groundRadius);
    const muS = (px * s[0] + py * s[1] + pz * s[2]) / rp;
    const sunT = sampleTransmittanceLut(a, luts.transmittance, rp, muS);
    const psi = sampleMultiScatteringLut(a, luts.multiScattering, rp, muS);
    const shadow = planetShadow(a, rp, muS);
    const rhoR = Math.exp(-h / a.rayleighScaleHeight);
    const rhoM = Math.exp(-h / a.mieScaleHeight);
    extinctionAt(a, h, e);
    for (let c = 0; c < 3; c++) {
      const scatR = a.density * a.rayleighScattering[c]! * rhoR;
      const scatM = a.density * a.mieScattering * rhoM;
      const stepT = Math.exp(-e[c] * dt);
      // ∫ S·T over the step, energy-conserving (Hillaire 2020).
      const w = (T[c] * (1 - stepT)) / Math.max(e[c], 1e-12);
      base[c] += w * (scatR * pR * sunT[c] * shadow + (scatR + scatM) * psi[c]);
      mie[c] += w * scatM * sunT[c] * shadow;
      T[c] *= stepT;
    }
  }
  return { base, mie, transmittance: T };
}

/**
 * The share of the in-scattered light that aerial perspective shows in thin,
 * clear air (atmosphere.ts, `haze`): 1/π is the haze of the look from before
 * decision 140, which kept the ground's palette.
 */
export const CLEAR_AIR_HAZE = 0.32;
/**
 * Opacity (1 − transmittance in blue) of the air between the camera and a
 * surface up to which aerial perspective shows only `haze` of the
 * in-scattered light, and from which it shows all of it. In clear air at
 * flight altitudes these are about 15 km and 100 km of path.
 */
export const HAZE_OPACITY_FROM = 0.3;
export const HAZE_OPACITY_FULL = 0.9;

/**
 * The share of a path's in-scattered light that aerial perspective shows,
 * from the path's transmittance in blue: `haze` through thin air, 1 once the
 * air is nearly opaque (CPU twin of atmosphere.ts's `aerialGain`).
 */
export function aerialHazeGain(transmittanceBlue: number, haze = CLEAR_AIR_HAZE): number {
  const span = HAZE_OPACITY_FULL - HAZE_OPACITY_FROM;
  const t = Math.min(1, Math.max(0, (1 - transmittanceBlue - HAZE_OPACITY_FROM) / span));
  return haze + (1 - haze) * t * t * (3 - 2 * t);
}

/** Luminance weights of linear RGB (Rec. 709). */
export const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * A light saturated about its luminance by `vibrance` (1 leaves it alone),
 * clamped at zero: the grade the sky's light takes at low sun (atmosphere.ts,
 * `vibrance`).
 */
export function gradeSky(light: Readonly<Rgb>, vibrance: number): Rgb {
  const y = LUMA[0] * light[0] + LUMA[1] * light[1] + LUMA[2] * light[2];
  return [
    Math.max(0, y + (light[0] - y) * vibrance),
    Math.max(0, y + (light[1] - y) * vibrance),
    Math.max(0, y + (light[2] - y) * vibrance),
  ];
}

/** `skyScattering` with the Mie phase function applied: the sky's radiance per unit sun illuminance. */
export function skyRadiance(
  a: AtmosphereParams,
  luts: AtmosphereLuts,
  r: number,
  d: readonly [number, number, number],
  s: readonly [number, number, number],
  steps = 48,
  linear = SKY_STEP_LINEAR,
): Rgb {
  const sky = skyScattering(a, luts, r, d, s, steps, linear);
  const pM = hgPhase(d[0] * s[0] + d[1] * s[1] + d[2] * s[2], a.mieG);
  return [
    sky.base[0] + sky.mie[0] * pM,
    sky.base[1] + sky.mie[1] * pM,
    sky.base[2] + sky.mie[2] * pM,
  ];
}

/**
 * Sky-view LUT size: azimuth around the sun by zenith angle. Hillaire's is
 * 192 × 108; here the azimuth needs less, since the sharp Mie peak is not in
 * the LUT, and the zenith angle more, for the edge of the planet's shadow in
 * twilight.
 */
export const SKY_VIEW_WIDTH = 128;
export const SKY_VIEW_HEIGHT = 160;

/**
 * Angles of the sky-view LUT's vertical axis for a camera at radius r: the
 * zenith angle of the sea-level horizon, and the angle from there to the
 * nadir. The camera's radius is taken at least a meter above sea level.
 */
export function skyViewHorizon(a: AtmosphereParams, r: number): { horizon: number; below: number } {
  const rc = Math.max(r, a.groundRadius + 1);
  const below = Math.acos(Math.min(1, Math.sqrt(rc * rc - a.groundRadius ** 2) / rc));
  return { horizon: Math.PI - below, below };
}

/**
 * Sky-view LUT coordinates (Hillaire 2020, section 5.3) for a view direction
 * given by its zenith cosine and its azimuth from the sun's (−π..π). u wraps
 * around the azimuth. v runs from the zenith (0) through the horizon (0.5)
 * to the nadir (1), with the square root of the angle from the horizon on
 * either side, so the rows crowd where the sky changes fastest.
 */
export function skyViewUv(
  a: AtmosphereParams,
  r: number,
  cosZenith: number,
  azimuth: number,
): [number, number] {
  const { horizon, below } = skyViewHorizon(a, r);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
  const v =
    zenith < horizon
      ? 0.5 * (1 - Math.sqrt(1 - zenith / horizon))
      : 0.5 + 0.5 * Math.sqrt(Math.min(1, (zenith - horizon) / below));
  return [azimuth / (2 * Math.PI) + 0.5, toTexel(v, SKY_VIEW_HEIGHT)];
}

/** Zenith angle and azimuth for sky-view LUT coordinates (inverse of skyViewUv). */
export function skyViewAngles(
  a: AtmosphereParams,
  r: number,
  u: number,
  v: number,
): { zenith: number; azimuth: number } {
  const { horizon, below } = skyViewHorizon(a, r);
  const y = Math.max(0, Math.min(1, fromTexel(v, SKY_VIEW_HEIGHT)));
  const zenith = y < 0.5 ? horizon * (1 - (1 - 2 * y) ** 2) : horizon + below * (2 * y - 1) ** 2;
  return { zenith, azimuth: (u - 0.5) * 2 * Math.PI };
}

export const IRRADIANCE_SIZE = 64;
/** Sun-elevation cosine range covered by the sky-irradiance LUT. */
export const IRRADIANCE_MU_MIN = -0.3;

/**
 * Sky light on the ground: for each sun-elevation cosine μs in
 * [IRRADIANCE_MU_MIN, 1], the irradiance on a horizontal surface at sea level
 * from the sky (single and multiple scattering), divided by π (so a
 * Lambertian albedo times this, times the sun illuminance, is radiance).
 * RGBA float32.
 */
export function computeSkyIrradianceLut(
  a: AtmosphereParams,
  luts: AtmosphereLuts,
  zenithSteps = 8,
  azimuthSteps = 16,
): Float32Array {
  const out = new Float32Array(IRRADIANCE_SIZE * 4);
  const r = a.groundRadius + 1;
  for (let k = 0; k < IRRADIANCE_SIZE; k++) {
    const muS = IRRADIANCE_MU_MIN + ((k + 0.5) / IRRADIANCE_SIZE) * (1 - IRRADIANCE_MU_MIN);
    const s: [number, number, number] = [Math.sqrt(1 - muS * muS), muS, 0];
    const E: Rgb = [0, 0, 0];
    // Midpoint rule over the upper hemisphere in (cos θ, φ): dω = d(cos θ) dφ.
    const dMu = 1 / zenithSteps;
    const dPhi = (2 * Math.PI) / azimuthSteps;
    for (let zi = 0; zi < zenithSteps; zi++) {
      const cz = (zi + 0.5) * dMu;
      const sz = Math.sqrt(1 - cz * cz);
      for (let ai = 0; ai < azimuthSteps; ai++) {
        const phi = (ai + 0.5) * dPhi;
        const L = skyRadiance(a, luts, r, [sz * Math.cos(phi), cz, sz * Math.sin(phi)], s, 24);
        for (let c = 0; c < 3; c++) E[c] += L[c] * cz * dMu * dPhi;
      }
    }
    out[k * 4] = E[0] / Math.PI;
    out[k * 4 + 1] = E[1] / Math.PI;
    out[k * 4 + 2] = E[2] / Math.PI;
    out[k * 4 + 3] = 1;
  }
  return out;
}

/** LUT u coordinate (texel-centered) for a sun-elevation cosine. */
export function irradianceU(muS: number): number {
  const x = Math.max(0, Math.min(1, (muS - IRRADIANCE_MU_MIN) / (1 - IRRADIANCE_MU_MIN)));
  return toTexel(x, IRRADIANCE_SIZE);
}
