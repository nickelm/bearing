/**
 * Atmosphere model (decision 35): Earth-like air on the planet (decision 14
 * keeps the atmosphere real), in pure TypeScript so Vitest can check it.
 *
 * Coefficients follow Hillaire (2020), "A Scalable and Production Ready Sky
 * and Atmosphere Rendering Technique": Rayleigh and Mie scattering with
 * exponential density profiles, plus ozone absorption in a tent profile
 * around 25 km. Distances in meters, coefficients per meter (RGB at roughly
 * 680, 550 and 440 nm).
 *
 * The transmittance LUT stores transmittance from a point at radius r along
 * direction cosine μ to the top of the atmosphere. It uses Bruneton's
 * parameterization ("Precomputed Atmospheric Scattering", 2017 revision).
 * The same mapping is written in TSL in atmosphere.ts.
 */

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
  /** Multiplies every coefficient (GUI tuning; 1 = Earth's air). */
  density: number;
}

export function earthLikeAtmosphere(groundRadius: number): AtmosphereParams {
  return {
    groundRadius,
    topRadius: groundRadius + 100_000,
    rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
    rayleighScaleHeight: 8000,
    mieScattering: 3.996e-6,
    mieExtinction: 4.4e-6,
    mieScaleHeight: 1200,
    mieG: 0.8,
    ozoneAbsorption: [0.65e-6, 1.881e-6, 0.085e-6],
    ozoneCenter: 25_000,
    ozoneHalfWidth: 15_000,
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
function planetShadow(a: AtmosphereParams, r: number, muS: number): number {
  const muH = -Math.sqrt(Math.max(0, 1 - (a.groundRadius / r) ** 2));
  const x = Math.max(0, Math.min(1, (muS - (muH - 0.006)) / 0.012));
  return x * x * (3 - 2 * x);
}

/**
 * Single-scattered sky radiance per unit sun illuminance, seen from a point
 * at radius r (on the y axis) along unit direction `d`, with the sun along `s`.
 */
export function skyRadiance(
  a: AtmosphereParams,
  lut: Float32Array,
  r: number,
  d: readonly [number, number, number],
  s: readonly [number, number, number],
  steps = 24,
): Rgb {
  const mu = d[1];
  const dist = rayHitsGround(a, r, mu)
    ? -r * mu - Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + a.groundRadius ** 2))
    : distanceToTop(a, r, mu);
  const cosTheta = d[0] * s[0] + d[1] * s[1] + d[2] * s[2];
  const pR = rayleighPhase(cosTheta);
  const pM = hgPhase(cosTheta, a.mieG);
  const dt = dist / steps;
  const T: Rgb = [1, 1, 1];
  const L: Rgb = [0, 0, 0];
  const e: Rgb = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const px = d[0] * t;
    const py = r + d[1] * t;
    const pz = d[2] * t;
    const rp = Math.sqrt(px * px + py * py + pz * pz);
    const h = Math.max(0, rp - a.groundRadius);
    const muS = (px * s[0] + py * s[1] + pz * s[2]) / rp;
    const sunT = sampleTransmittanceLut(a, lut, rp, muS);
    const shadow = planetShadow(a, rp, muS);
    const rhoR = Math.exp(-h / a.rayleighScaleHeight);
    const rhoM = Math.exp(-h / a.mieScaleHeight);
    extinctionAt(a, h, e);
    for (let c = 0; c < 3; c++) {
      const scat = a.density * (a.rayleighScattering[c]! * rhoR * pR + a.mieScattering * rhoM * pM);
      const S = scat * sunT[c] * shadow;
      const stepT = Math.exp(-e[c] * dt);
      L[c] += (T[c] * (S - S * stepT)) / Math.max(e[c], 1e-12);
      T[c] *= stepT;
    }
  }
  return L;
}

export const IRRADIANCE_SIZE = 64;
/** Sun-elevation cosine range covered by the sky-irradiance LUT. */
export const IRRADIANCE_MU_MIN = -0.3;

/**
 * Sky light on the ground: for each sun-elevation cosine μs in
 * [IRRADIANCE_MU_MIN, 1], the irradiance on a horizontal surface at sea level
 * from the single-scattered sky, divided by π (so a Lambertian albedo times
 * this, times the sun illuminance, is radiance). RGBA float32.
 */
export function computeSkyIrradianceLut(
  a: AtmosphereParams,
  lut: Float32Array,
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
        const L = skyRadiance(a, lut, r, [sz * Math.cos(phi), cz, sz * Math.sin(phi)], s);
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
