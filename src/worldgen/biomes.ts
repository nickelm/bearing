/**
 * Stages: provisional climate and biomes (milestone 1).
 *
 * Temperature: an annual mean from latitude, with a lapse rate applied to
 * the *reference* elevation (decision 19). Seasons arrive with the climate
 * stage proper in milestone 2.
 *
 * Moisture: latitude bands (wet equator, dry subtropics, wet mid-latitudes,
 * dry poles), reduced with distance from the ocean, plus noise. There are no
 * winds or rain shadows yet.
 *
 * Biomes: a Whittaker-style lookup on temperature and moisture.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Noise3 } from '../core/noise';
import type { Rng } from '../core/rng';
import { KM } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { clamp, distanceFromSources } from './fields';
import type { PlanetParams } from './params';

export const Biome = {
  DeepOcean: 0,
  Ocean: 1,
  Shelf: 2,
  SeaIce: 3,
  IceSheet: 4,
  Tundra: 5,
  Taiga: 6,
  TemperateGrassland: 7,
  TemperateForest: 8,
  TemperateRainforest: 9,
  ColdDesert: 10,
  HotDesert: 11,
  Shrubland: 12,
  Savanna: 13,
  TropicalSeasonalForest: 14,
  TropicalRainforest: 15,
  Alpine: 16,
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];
export const BIOME_COUNT = 17;

export const BIOME_NAMES: readonly string[] = [
  'deep ocean',
  'ocean',
  'shelf',
  'sea ice',
  'ice sheet',
  'tundra',
  'taiga',
  'temperate grassland',
  'temperate forest',
  'temperate rainforest',
  'cold desert',
  'hot desert',
  'shrubland',
  'savanna',
  'tropical seasonal forest',
  'tropical rainforest',
  'alpine',
];

export interface Climate {
  /** Annual mean temperature (°C). */
  temperature: Float32Array;
  /** Relative moisture 0..1. */
  moisture: Float32Array;
}

/** Lapse rate in K per reference meter. */
const LAPSE_RATE = 6.5 / 1000;
/** Amplitude (radians) of the noise that bends latitude for temperature and moisture. */
// fBm rarely exceeds ±0.5, so the typical bend is about a third of these values.
const TEMPERATURE_LATITUDE_WARP = 0.38; // ≈ 22°
const MOISTURE_LATITUDE_WARP = 0.4; // ≈ 23°

/** Sea-level annual mean temperature at a latitude (°C). */
export function seaLevelTemperature(lat: number): number {
  return 27 - 58 * (1 - Math.cos(lat));
}

export function computeClimate(
  grid: CubeGrid,
  params: PlanetParams,
  height: Float32Array,
  r: Rng,
): Climate {
  const n = grid.cellCount;
  const temperature = new Float32Array(n);
  const moisture = new Float32Array(n);
  const noise = new Noise3(r.fork('moisture-noise'));
  const tNoise = new Noise3(r.fork('temperature-noise'));
  const ocean = new Uint8Array(n);
  for (let c = 0; c < n; c++) ocean[c] = height[c] <= 0 ? 1 : 0;
  // Distance inland from the coast, out to 2,500 km.
  const inland = distanceFromSources(grid, ocean, (2500 * KM) / params.radius);
  // Distance offshore from land, out to 2,500 km.
  const land = new Uint8Array(n);
  for (let c = 0; c < n; c++) land[c] = 1 - ocean[c];
  const offshore = distanceFromSources(grid, land, (2500 * KM) / params.radius);
  const x = new Vec3d();
  for (let c = 0; c < n; c++) {
    grid.center(c, x);
    const lat = Math.asin(clamp(x.y, -1, 1));
    const d = inland.angle[c] === Infinity ? 2500 * KM : inland.angle[c] * params.radius;

    // Temperature: latitude bent by large-scale noise (stand-in for ocean currents and
    // planetary waves) so isotherms, ice edges and biome belts are not circles.
    const latWarpT =
      TEMPERATURE_LATITUDE_WARP * tNoise.fbm(x.x * 1.1, x.y * 1.1, x.z * 1.1, 3) +
      0.35 * TEMPERATURE_LATITUDE_WARP * tNoise.fbm(x.x * 3.5 + 7.3, x.y * 3.5, x.z * 3.5, 3);
    const latT = clamp(Math.abs(lat) + latWarpT, 0, Math.PI / 2);
    const refAlt = Math.max(0, height[c]) / params.reliefScale;
    // Continental interiors run colder toward the poles; coasts are moderated by the sea.
    const interiorChill =
      ocean[c] === 1 ? 0 : 7 * Math.sin(Math.abs(lat)) * (1 - Math.exp(-d / (600 * KM)));
    // Open ocean far from land carries heat poleward (stand-in for currents), so sea ice
    // clings to coasts and enclosed seas instead of forming a disc around the pole.
    const dOff = offshore.angle[c] === Infinity ? 2500 * KM : offshore.angle[c] * params.radius;
    const oceanWarmth =
      ocean[c] === 1 ? 9 * Math.sin(Math.abs(lat)) * (1 - Math.exp(-dOff / (500 * KM))) : 0;
    temperature[c] =
      seaLevelTemperature(latT) +
      2.5 * tNoise.fbm(x.x * 6 + 3.1, x.y * 6, x.z * 6, 3) -
      interiorChill +
      oceanWarmth +
      params.temperatureOffset -
      LAPSE_RATE * refAlt;

    // Moisture: latitude bands bent by their own warp, damped inland, plus noise.
    const latM = lat + MOISTURE_LATITUDE_WARP * noise.fbm(x.x * 1.4 + 5.7, x.y * 1.4, x.z * 1.4, 3);
    const band = 0.55 + 0.3 * Math.cos(6 * latM) - 0.15 * Math.abs(Math.sin(latM));
    const continentality = 0.35 + 0.65 * Math.exp(-d / (700 * KM));
    const jitter =
      0.2 * noise.fbm(x.x * 3, x.y * 3, x.z * 3, 4) +
      0.08 * noise.fbm(x.x * 10, x.y * 10, x.z * 10, 3);
    moisture[c] = clamp((band * continentality + jitter) * params.moistureScale, 0, 1);
  }
  return { temperature, moisture };
}

/** Reference-elevation threshold for bare alpine terrain (m). */
const ALPINE_REFERENCE = 2600;

export function classifyBiome(
  heightM: number,
  referenceHeightM: number,
  temperature: number,
  moisture: number,
): Biome {
  if (heightM <= 0) {
    if (temperature < -10) return Biome.SeaIce;
    if (referenceHeightM > -200) return Biome.Shelf;
    if (referenceHeightM > -2500) return Biome.Ocean;
    return Biome.DeepOcean;
  }
  // Ice sheets need deep cold: Siberia-like land at −10..−15 °C is tundra, not glacier.
  if (temperature < -20) return Biome.IceSheet;
  if (referenceHeightM > ALPINE_REFERENCE && temperature < 4) return Biome.Alpine;
  if (temperature < -6) return Biome.Tundra;
  if (temperature < 5) return moisture < 0.25 ? Biome.Tundra : Biome.Taiga;
  if (temperature < 18) {
    if (moisture < 0.18) return Biome.ColdDesert;
    if (moisture < 0.38) return Biome.TemperateGrassland;
    if (moisture < 0.72) return Biome.TemperateForest;
    return Biome.TemperateRainforest;
  }
  if (moisture < 0.18) return Biome.HotDesert;
  if (moisture < 0.32) return Biome.Shrubland;
  if (moisture < 0.5) return Biome.Savanna;
  if (moisture < 0.75) return Biome.TropicalSeasonalForest;
  return Biome.TropicalRainforest;
}

export function computeBiomes(
  grid: CubeGrid,
  params: PlanetParams,
  height: Float32Array,
  climate: Climate,
): Uint8Array {
  const out = new Uint8Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    out[c] = classifyBiome(
      height[c],
      height[c] / params.reliefScale,
      climate.temperature[c],
      climate.moisture[c],
    );
  }
  return out;
}
