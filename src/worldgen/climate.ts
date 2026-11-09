/**
 * Stage: climate (design doc, pipeline step 5; decision 15). Replaces the
 * provisional milestone-1 climate.
 *
 * Temperature
 *  - Annual mean: the milestone-1 latitude curve (tuned with the owner),
 *    shifted by how the axial tilt changes the annual mean insolation at that
 *    latitude, so tilt 0 gives colder poles and a larger tilt warmer ones.
 *    Noise bends the isotherms, interiors run colder, open ocean carries heat
 *    poleward, and the lapse rate uses reference elevation (decision 19).
 *  - Seasonal range: half the warmest-to-coldest-month difference, from the
 *    yearly swing of daily mean insolation at that latitude, damped over the
 *    ocean and near coasts (thermal inertia). Tilt 0 gives no seasons.
 *
 * Wind and moisture
 *  - A three-cell prevailing wind: trade winds, westerlies, polar easterlies,
 *    with latitudes bent by noise.
 *  - Moisture is advected semi-Lagrangian along the wind on a coarse climate
 *    grid (at most 128 per face, about 12 km cells). The ocean evaporates
 *    toward saturation, and air rains out by a latitude-band rate
 *    (convergence at the ITCZ and polar front, subsidence near 30°), by
 *    orographic lift where terrain rises along the wind, and by
 *    supersaturation where air cools over high ground. Rain shadows follow.
 *  - Precipitation is normalized to an Earth-like global mean of 1,000 mm/yr,
 *    then multiplied by moistureScale.
 *  - Moisture (0..1, for biomes and the debug view) is 0.5 × P / PET with a
 *    temperature-driven potential evapotranspiration.
 */
import { CubeGrid } from '../core/cubeGrid';
import { directionToCubeFace } from '../core/coords';
import type { CubeFaceUv } from '../core/coords';
import { Noise3 } from '../core/noise';
import type { Rng } from '../core/rng';
import { DEG, KM } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { clamp, distanceFromSources } from './fields';
import type { PlanetParams } from './params';

export interface Climate {
  /** Annual mean temperature at the cell's height (°C). */
  temperature: Float32Array;
  /** Half the difference between the warmest and coldest month (K). */
  temperatureRange: Float32Array;
  /** Annual precipitation (mm/yr). */
  precipitation: Float32Array;
  /** Relative moisture 0..1: 0.5 × precipitation / potential evapotranspiration. */
  moisture: Float32Array;
  /** Runoff: precipitation minus actual evapotranspiration (Turc–Pike), mm/yr. */
  runoff: Float32Array;
  /** Prevailing surface wind, east and north components (relative speed, about 0..1). */
  windEast: Float32Array;
  windNorth: Float32Array;
}

/** Lapse rate in K per reference meter. */
export const LAPSE_RATE = 6.5 / 1000;
/** Solar constant used for the insolation shape (W/m²). */
const SOLAR_CONSTANT = 1361;
const EARTH_TILT = 23.44 * DEG;
/** Annual-mean temperature change per W/m² of annual-mean insolation (fit to the M1 curve). */
const K_PER_WATT_MEAN = 58 / (418 - 173);
/** Seasonal half-range per W/m² of insolation half-swing, deep in a continent. */
const K_PER_WATT_SEASON = 0.094;
const TEMPERATURE_LATITUDE_WARP = 0.38; // ≈ 22°
const WIND_LATITUDE_WARP = 0.12; // ≈ 7°
/** Earth-like global mean precipitation (mm/yr). */
const GLOBAL_MEAN_PRECIPITATION = 1000;
/** Largest climate grid (cells per face edge). */
const MAX_CLIMATE_RES = 128;

/** Sea-level annual mean temperature at a latitude for Earth's tilt (°C). The milestone-1 curve. */
export function seaLevelTemperature(lat: number): number {
  return 27 - 58 * (1 - Math.cos(lat));
}

/** Daily mean top-of-atmosphere insolation (W/m²) at latitude `lat` and solar declination `decl`. */
export function dailyInsolation(lat: number, decl: number): number {
  const x = -Math.tan(lat) * Math.tan(decl);
  const h0 = x >= 1 ? 0 : x <= -1 ? Math.PI : Math.acos(x);
  return (
    (SOLAR_CONSTANT / Math.PI) *
    (h0 * Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.sin(h0))
  );
}

/** Annual mean and half-swing (max − min) / 2 of daily insolation at a latitude, for a circular orbit. */
export function insolationYear(lat: number, tilt: number): { mean: number; swing: number } {
  const steps = 72;
  let sum = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < steps; k++) {
    const decl = Math.asin(Math.sin(tilt) * Math.sin((2 * Math.PI * (k + 0.5)) / steps));
    const q = dailyInsolation(lat, decl);
    sum += q;
    lo = Math.min(lo, q);
    hi = Math.max(hi, q);
  }
  return { mean: sum / steps, swing: (hi - lo) / 2 };
}

/**
 * Prevailing wind (east, north components) at a latitude: easterly trades
 * blowing toward the equator, westerlies blowing poleward, polar easterlies.
 */
export function prevailingWind(lat: number): [number, number] {
  const a = Math.abs(lat) / DEG;
  const s = Math.sign(lat) || 1;
  if (a < 30) {
    return [-0.8 * Math.cos((Math.PI / 2) * (a / 30)), -s * 0.4 * Math.sin(Math.PI * (a / 30))];
  }
  if (a < 60) {
    const t = (a - 30) / 30;
    return [Math.sin(Math.PI * t), s * 0.3 * Math.sin(Math.PI * t)];
  }
  const t = (a - 60) / 30;
  return [-0.5 * Math.sin(Math.PI * t), -s * 0.2 * Math.sin(Math.PI * t)];
}

/** Rain-out rate by latitude: convergence at the ITCZ and polar front, subsidence near 30°. */
export function convergence(lat: number): number {
  const a = Math.abs(lat) / DEG;
  return (
    0.35 +
    1.3 * Math.exp(-((a / 9) ** 2)) +
    0.55 * Math.exp(-(((a - 55) / 11) ** 2)) -
    0.28 * Math.exp(-(((a - 27) / 7) ** 2))
  );
}

/** Saturation moisture relative to 25 °C air (Clausius–Clapeyron, about 6.5 %/K). */
function saturation(t: number): number {
  return Math.exp(0.065 * (t - 25));
}

/** Potential evapotranspiration (mm/yr) from annual mean temperature. */
export function potentialEvapotranspiration(t: number): number {
  return Math.max(150, 150 + 55 * t);
}

/**
 * Runoff (mm/yr) by the Turc–Pike formula: actual evapotranspiration
 * ET = P / √(1 + (P/PET)²), runoff = P − ET. About 4 % of rain runs off in
 * deserts, 30 % where rain equals PET, and over half in very wet climates.
 */
export function runoffFrom(precipitation: number, pet: number): number {
  const r = precipitation / pet;
  return precipitation - precipitation / Math.sqrt(1 + r * r);
}

/** The largest power-of-two divisor of `n` that is at most MAX_CLIMATE_RES. */
export function climateResolution(n: number): number {
  let c = n;
  while (c > MAX_CLIMATE_RES && c % 2 === 0) c /= 2;
  return c;
}

export function computeClimate(
  grid: CubeGrid,
  params: PlanetParams,
  height: Float32Array,
  r: Rng,
): Climate {
  const n = grid.cellCount;
  const temperature = new Float32Array(n);
  const temperatureRange = new Float32Array(n);
  // Temperature without the continental-interior chill: condensation over land
  // should come from air rising and cooling, not from the annual-mean chill.
  const condensationTemp = new Float32Array(n);
  const tNoise = new Noise3(r.fork('temperature-noise'));
  const wNoise = new Noise3(r.fork('wind-noise'));
  const pNoise = new Noise3(r.fork('precipitation-noise'));

  const ocean = new Uint8Array(n);
  const land = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    ocean[c] = height[c]! <= 0 ? 1 : 0;
    land[c] = 1 - ocean[c]!;
  }
  const maxReach = (2500 * KM) / params.radius;
  const inland = distanceFromSources(grid, ocean, maxReach);
  const offshore = distanceFromSources(grid, land, maxReach);

  // Insolation per latitude band (cached; 0.25° bins are plenty).
  const bins = 721;
  const qMean = new Float64Array(bins);
  const qEarth = new Float64Array(bins);
  const qSwing = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    const lat = ((b / (bins - 1)) * 180 - 90) * DEG;
    const y = insolationYear(lat, params.axialTilt);
    qMean[b] = y.mean;
    qSwing[b] = y.swing;
    qEarth[b] = insolationYear(lat, EARTH_TILT).mean;
  }
  const bin = (lat: number) => Math.round(((lat / DEG + 90) / 180) * (bins - 1));

  // --- Temperature on the full grid ---
  const x = new Vec3d();
  for (let c = 0; c < n; c++) {
    grid.center(c, x);
    const lat = Math.asin(clamp(x.y, -1, 1));
    const b = bin(lat);
    const d = inland.angle[c] === Infinity ? 2500 * KM : inland.angle[c]! * params.radius;
    const dOff = offshore.angle[c] === Infinity ? 2500 * KM : offshore.angle[c]! * params.radius;
    const latWarp =
      TEMPERATURE_LATITUDE_WARP * tNoise.fbm(x.x * 1.1, x.y * 1.1, x.z * 1.1, 3) +
      0.35 * TEMPERATURE_LATITUDE_WARP * tNoise.fbm(x.x * 3.5 + 7.3, x.y * 3.5, x.z * 3.5, 3);
    const latT = clamp(Math.abs(lat) + latWarp, 0, Math.PI / 2);
    const refAlt = Math.max(0, height[c]!) / params.reliefScale;
    const interiorChill =
      ocean[c] === 1 ? 0 : 7 * Math.sin(Math.abs(lat)) * (1 - Math.exp(-d / (600 * KM)));
    const oceanWarmth =
      ocean[c] === 1 ? 9 * Math.sin(Math.abs(lat)) * (1 - Math.exp(-dOff / (500 * KM))) : 0;
    temperature[c] =
      seaLevelTemperature(latT) +
      K_PER_WATT_MEAN * (qMean[b]! - qEarth[b]!) +
      2.5 * tNoise.fbm(x.x * 6 + 3.1, x.y * 6, x.z * 6, 3) -
      interiorChill +
      oceanWarmth +
      params.temperatureOffset -
      LAPSE_RATE * refAlt;
    condensationTemp[c] = temperature[c]! + interiorChill;
    // Thermal inertia: the ocean swings about a quarter as much as a continental interior.
    const response = ocean[c] === 1 ? 0.25 : 0.35 + 0.65 * (1 - Math.exp(-d / (400 * KM)));
    temperatureRange[c] = K_PER_WATT_SEASON * qSwing[b]! * response;
  }

  // --- Wind and moisture on the coarse climate grid ---
  const cn = climateResolution(grid.n);
  const cg = cn === grid.n ? grid : new CubeGrid(cn);
  const k = grid.n / cn;
  const cc = cg.cellCount;
  const cHeight = new Float64Array(cc);
  const cTemp = new Float64Array(cc);
  const cOcean = new Float64Array(cc);
  const cInland = new Float64Array(cc);
  for (let c = 0; c < n; c++) {
    const face = grid.faceOf(c);
    const cc0 = cg.index(face, Math.floor(grid.iOf(c) / k), Math.floor(grid.jOf(c) / k));
    const w = 1 / (k * k);
    cHeight[cc0] += (Math.max(0, height[c]!) / params.reliefScale) * w;
    cTemp[cc0] += condensationTemp[c]! * w;
    cOcean[cc0] += ocean[c]! * w;
    const dIn = inland.angle[c] === Infinity ? 2500 * KM : inland.angle[c]! * params.radius;
    cInland[cc0] += dIn * w;
  }

  // Air rises over ranges, not over every hill: smooth the terrain the wind sees.
  const liftHeight = Float64Array.from(cHeight);
  {
    const tmp = new Float64Array(cc);
    for (let pass = 0; pass < 3; pass++) {
      for (let c = 0; c < cc; c++) {
        let sum = 2 * liftHeight[c]!;
        for (let t = 0; t < 4; t++) sum += liftHeight[cg.neighbors4[c * 4 + t]!]!;
        tmp[c] = sum / 6;
      }
      liftHeight.set(tmp);
    }
  }

  const cWindE = new Float32Array(cc);
  const cWindN = new Float32Array(cc);
  const cConv = new Float64Array(cc);
  const up = new Float64Array(cc * 4);
  const upW = new Float64Array(cc * 4);
  const lift = new Float64Array(cc);
  const east = new Vec3d();
  const north = new Vec3d();
  const p = new Vec3d();
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const yAxis = new Vec3d(0, 1, 0);
  const cellAngle = Math.PI / 2 / cn;
  for (let c = 0; c < cc; c++) {
    cg.center(c, x);
    const lat = Math.asin(clamp(x.y, -1, 1));
    const latW = lat + WIND_LATITUDE_WARP * wNoise.fbm(x.x * 1.6, x.y * 1.6, x.z * 1.6, 3);
    const [we, wn] = prevailingWind(clamp(latW, -Math.PI / 2, Math.PI / 2));
    cWindE[c] = we;
    cWindN[c] = wn;
    cConv[c] = convergence(latW);
    east.copy(yAxis).cross(x);
    if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
    east.normalize();
    north.copy(x).cross(east);
    // Upwind point one step back along the wind; bilinear taps around it.
    p.copy(x)
      .addScaled(east, -we * cellAngle)
      .addScaled(north, -wn * cellAngle)
      .normalize();
    directionToCubeFace(p, uv);
    const fi = uv.u * cn - 0.5;
    const fj = uv.v * cn - 0.5;
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const tx = fi - i0;
    const ty = fj - j0;
    const taps: [number, number, number][] = [
      [0, 0, (1 - tx) * (1 - ty)],
      [1, 0, tx * (1 - ty)],
      [0, 1, (1 - tx) * ty],
      [1, 1, tx * ty],
    ];
    let hUp = 0;
    for (let t = 0; t < 4; t++) {
      const [di, dj, w] = taps[t]!;
      const cell = cg.cellAtFaceCoords(uv.face, i0 + di + 0.5, j0 + dj + 0.5);
      up[c * 4 + t] = cell;
      upW[c * 4 + t] = w;
      hUp += w * liftHeight[cell]!;
    }
    // Rise along the wind per meter traveled (reference heights, so slopes are Earth-like).
    const speed = Math.hypot(we, wn);
    const dist = Math.max(1e-3, speed) * cellAngle * params.radius;
    // Gentle rises (below about 1:500) barely lift air; ranges do.
    lift[c] = Math.max(0, (liftHeight[c]! - hUp) / dist - 0.002);
  }

  // Semi-Lagrangian moisture transport toward a steady state.
  const EVAPORATION = 0.15;
  const BASE_RAIN = 0.012;
  const OROGRAPHIC = 6;
  /** Fraction of rain over land that evaporates again (Earth: roughly 40–60 %). */
  const RECYCLING = 0.5;
  const SUPERSATURATION = 0.15;
  /** Relative humidity the ocean evaporates toward (Earth's marine boundary layer: about 75–80 %). */
  const OCEAN_HUMIDITY = 0.75;
  /**
   * Transient eddies and monsoons carry moisture inland from every coast, not
   * only along the prevailing wind. Parameterized as a floor on moisture that
   * decays with distance from the sea.
   */
  const EDDY_FRACTION = 0.6;
  const EDDY_REACH = 1200 * KM;
  let q = new Float64Array(cc);
  let qNext = new Float64Array(cc);
  const rain = new Float64Array(cc);
  const qsat = new Float64Array(cc);
  const eddyFloor = new Float64Array(cc);
  for (let c = 0; c < cc; c++) {
    qsat[c] = saturation(cTemp[c]!);
    eddyFloor[c] = EDDY_FRACTION * OCEAN_HUMIDITY * qsat[c]! * Math.exp(-cInland[c]! / EDDY_REACH);
    q[c] = cOcean[c]! > 0.5 ? 0.75 * qsat[c]! : 0;
  }
  const iterations = Math.min(600, Math.max(60, 3 * cn));
  const average = Math.max(10, Math.floor(iterations / 4));
  for (let it = 0; it < iterations; it++) {
    const accumulate = it >= iterations - average;
    for (let c = 0; c < cc; c++) {
      let qi = 0;
      for (let t = 0; t < 4; t++) qi += upW[c * 4 + t]! * q[up[c * 4 + t]!]!;
      // A little isotropic mixing (eddies) so moisture spreads around obstacles.
      let qm = 0;
      for (let t = 0; t < 4; t++) qm += q[cg.neighbors4[c * 4 + t]!]!;
      qi = 0.88 * qi + 0.12 * (qm / 4);
      const sea = cOcean[c]!;
      qi += sea * Math.max(0, OCEAN_HUMIDITY * qsat[c]! - qi) * EVAPORATION;
      qi = Math.max(qi, eddyFloor[c]!);
      const rate = BASE_RAIN * cConv[c]! + OROGRAPHIC * lift[c]!;
      let pr = qi * Math.min(0.9, rate) + Math.max(0, qi - qsat[c]!) * SUPERSATURATION;
      pr = Math.min(pr, qi);
      qi -= pr;
      qi += (1 - sea) * RECYCLING * pr;
      qNext[c] = Math.max(0, qi);
      if (accumulate) rain[c] += pr / average;
    }
    [q, qNext] = [qNext, q];
  }

  // Normalize to the global mean, then add some multiplicative noise and apply moistureScale.
  let sum = 0;
  let area = 0;
  for (let c = 0; c < cc; c++) {
    sum += rain[c]! * cg.areas[c]!;
    area += cg.areas[c]!;
  }
  const scale = sum > 0 ? (GLOBAL_MEAN_PRECIPITATION * area) / sum : 0;

  // --- Back to the full grid (bilinear within the climate grid) ---
  const precipitation = new Float32Array(n);
  const moisture = new Float32Array(n);
  const windEast = new Float32Array(n);
  const windNorth = new Float32Array(n);
  const runoff = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const face = grid.faceOf(c);
    const fi = ((grid.iOf(c) + 0.5) / grid.n) * cn - 0.5;
    const fj = ((grid.jOf(c) + 0.5) / grid.n) * cn - 0.5;
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const tx = fi - i0;
    const ty = fj - j0;
    let pr = 0;
    let we = 0;
    let wn = 0;
    for (let t = 0; t < 4; t++) {
      const di = t & 1;
      const dj = t >> 1;
      const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
      const cell = cg.cellAtFaceCoords(face, i0 + di + 0.5, j0 + dj + 0.5);
      pr += w * rain[cell]!;
      we += w * cWindE[cell]!;
      wn += w * cWindN[cell]!;
    }
    grid.center(c, x);
    const jitter = Math.exp(0.35 * pNoise.fbm(x.x * 8, x.y * 8, x.z * 8, 4));
    precipitation[c] = pr * scale * jitter * params.moistureScale;
    moisture[c] = clamp(
      (0.5 * precipitation[c]!) / potentialEvapotranspiration(temperature[c]!),
      0,
      1,
    );
    runoff[c] = runoffFrom(precipitation[c]!, potentialEvapotranspiration(temperature[c]!));
    windEast[c] = we;
    windNorth[c] = wn;
  }
  return { temperature, temperatureRange, precipitation, moisture, runoff, windEast, windNorth };
}
