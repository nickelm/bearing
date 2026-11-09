/**
 * Stage: biomes. A Whittaker-style lookup on annual mean temperature and
 * relative moisture (0.5 × precipitation / potential evapotranspiration),
 * with the coldest month separating boreal forest from temperate forest in
 * strongly continental climates. The climate itself lives in climate.ts.
 */
import type { CubeGrid } from '../core/cubeGrid';
import type { Climate } from './climate';
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

/** Reference-elevation threshold for bare alpine terrain (m). */
const ALPINE_REFERENCE = 2600;

/** Coldest-month temperature (°C) below which forests are boreal even with a mild annual mean. */
const BOREAL_COLDEST_MONTH = -15;

export function classifyBiome(
  heightM: number,
  referenceHeightM: number,
  temperature: number,
  moisture: number,
  coldestMonth = temperature,
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
    if (coldestMonth < BOREAL_COLDEST_MONTH && moisture >= 0.38) return Biome.Taiga;
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
      climate.temperature[c]!,
      climate.moisture[c]!,
      climate.temperature[c]! - climate.temperatureRange[c]!,
    );
  }
  return out;
}
