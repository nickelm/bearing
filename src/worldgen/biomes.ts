/**
 * Stage: biomes. A Whittaker-style lookup on annual mean temperature and
 * relative moisture (0.5 × precipitation / potential evapotranspiration),
 * with the coldest month separating boreal forest from temperate forest in
 * strongly continental climates. The climate itself lives in climate.ts.
 */
import type { CubeGrid } from '../core/cubeGrid';
import type { Climate } from './climate';
import type { ClimateModifiers } from './climateModifiers';
import { neighbors8 } from './drainage';
import { isLayered, rockOf } from './lithology';
import { Province } from './provinces';
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
  /** Proposal 0007's additions (decision 211); the codes above keep their meaning. */
  CloudForest: 17,
  Mangrove: 18,
  RockyDesert: 19,
  RedRockDesert: 20,
  FogDesert: 21,
  Moorland: 22,
  Wetland: 23,
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];
export const BIOME_COUNT = 24;

/**
 * Proposal 0007's twenty land biomes (decision 211) map onto the codes: ice
 * sheet = ice, taiga = boreal forest, temperate forest = temperate deciduous
 * forest, cold desert = cold desert and steppe, hot desert = sand sea,
 * shrubland = Mediterranean scrub, tropical seasonal forest = monsoon forest,
 * alpine = alpine meadow (rock and ice above it are the shader's).
 */
export const LAND_BIOMES: readonly Biome[] = [
  Biome.IceSheet,
  Biome.Tundra,
  Biome.Taiga,
  Biome.TemperateGrassland,
  Biome.TemperateForest,
  Biome.TemperateRainforest,
  Biome.ColdDesert,
  Biome.HotDesert,
  Biome.Shrubland,
  Biome.Savanna,
  Biome.TropicalSeasonalForest,
  Biome.TropicalRainforest,
  Biome.Alpine,
  Biome.CloudForest,
  Biome.Mangrove,
  Biome.RockyDesert,
  Biome.RedRockDesert,
  Biome.FogDesert,
  Biome.Moorland,
  Biome.Wetland,
];

/** Deserts of every kind (decision 211). */
export const DESERT_BIOMES: ReadonlySet<number> = new Set([
  Biome.ColdDesert,
  Biome.HotDesert,
  Biome.RockyDesert,
  Biome.RedRockDesert,
  Biome.FogDesert,
]);

/**
 * Ground covers that only detail tiles produce (decision 146), in the biome byte of
 * the tile material above the global biomes: the global grid never classifies them.
 * Both read as land (above Biome.SeaIce).
 */
export const TileCover = {
  /** Sand on low, gentle coasts: beaches in coves and bays. */
  Beach: 32,
  /** Reeds, sedge and pools at the water table: floodplains, lake shores, low coasts. */
  Marsh: 33,
  /** Gravel and cobbles on the banks of steep or glacial rivers. */
  Gravel: 34,
} as const;

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
  'alpine meadow',
  'cloud forest',
  'mangrove',
  'rocky desert',
  'red rock desert',
  'fog desert',
  'moorland and heath',
  'wetland',
];

/** Reference-elevation threshold for bare alpine terrain (m). */
const ALPINE_REFERENCE = 2600;

/** Coldest-month temperature (°C) below which forests are boreal even with a mild annual mean. */
const BOREAL_COLDEST_MONTH = -15;

/**
 * What the expanded table reads besides temperature and moisture (decision 211):
 * the rock under the cell, the climate modifiers, and the ground's shape.
 */
export interface BiomeContext {
  /** `Rock` (lithology.ts, without the layered bit) and whether it is layered. */
  rock: number;
  layered: boolean;
  /** Precipitation seasonality: −1 winter-wet, +1 summer-wet. */
  seasonality: number;
  /** Fog tendency from a cold current, 0..1. */
  fog: number;
  /** Land next to the sea. */
  coastal: boolean;
  /** Nearly level ground. */
  flat: boolean;
  /** Ecotone noise, about −1..1: boundaries interfinger instead of following isolines. */
  ecotone: number;
  /** On a high plateau: flat high steppe, not alpine meadow or ice (decision 211). */
  plateau: boolean;
  /** Moisture offset from the continent's character (decision 212). */
  moistureBias: number;
}

/** Acidic, sandy or thin soils where heather grows (granite, sandstone, till). */
const ACIDIC: ReadonlySet<number> = new Set([1, 3, 9]);
/** Chalk and limestone: grassland where forest would grow on loam. */
const LIMESTONE = 5;
/** Crystalline and volcanic rock: stony deserts. */
const ROCKY: ReadonlySet<number> = new Set([1, 2, 5, 6, 7]);
const SANDSTONE = 3;
const SHALE = 4;

export function classifyBiome(
  heightM: number,
  referenceHeightM: number,
  temperatureIn: number,
  moistureIn: number,
  coldestMonth = temperatureIn,
  ctx?: BiomeContext,
): Biome {
  const temperature = temperatureIn + (ctx ? 0.8 * ctx.ecotone : 0);
  // A cold current dries the air it cools (fog deserts).
  const moisture = ctx
    ? moistureIn * (1 - 0.6 * ctx.fog) + 0.04 * ctx.ecotone + ctx.moistureBias
    : moistureIn;
  if (heightM <= 0) {
    if (temperature < -10) return Biome.SeaIce;
    if (referenceHeightM > -200) return Biome.Shelf;
    if (referenceHeightM > -2500) return Biome.Ocean;
    return Biome.DeepOcean;
  }
  // Ice sheets need deep cold: Siberia-like land at −10..−15 °C is tundra, not glacier.
  // High plateaus are cold, dry steppe (Tibet, the Altiplano): no ice sheet, no meadow unless wet.
  if (ctx?.plateau && temperature < 4) {
    if (moistureIn < 0.5) return temperature < -12 ? Biome.Tundra : Biome.ColdDesert;
    return temperature < -12 ? Biome.Tundra : Biome.Alpine;
  }
  if (temperature < -20) return Biome.IceSheet;
  if (referenceHeightM > ALPINE_REFERENCE && temperature < 4) return Biome.Alpine;
  if (!ctx) {
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
  // The expanded table (decision 211).
  const winterWet = ctx.seasonality <= -0.3;
  const layeredSand = ctx.layered && (ctx.rock === SANDSTONE || ctx.rock === SHALE);
  const desert = (hot: boolean): Biome => {
    if (ctx.fog > 0.35) return Biome.FogDesert;
    // Red rock on raised layered sandstone (plateaus, mesas); sand seas fill the low basins.
    if (layeredSand && temperature > 4 && referenceHeightM > 500) return Biome.RedRockDesert;
    if (!hot) return Biome.ColdDesert;
    if (ROCKY.has(ctx.rock) || referenceHeightM > 1100) return Biome.RockyDesert;
    return Biome.HotDesert;
  };
  // Tropical mountains in cloud: frost-free, wet, high (altitude zonation).
  if (
    temperature >= 9 &&
    temperature < 20 &&
    coldestMonth > 6 &&
    moisture >= 0.7 &&
    referenceHeightM > 1000
  )
    return Biome.CloudForest;
  if (temperature < -6) return Biome.Tundra;
  const heath =
    ACIDIC.has(ctx.rock) &&
    moisture >= 0.6 &&
    temperature < 11 &&
    (referenceHeightM > 250 || ctx.coastal) &&
    referenceHeightM < 1600;
  if (temperature < 5) {
    if (moisture < 0.25) return Biome.Tundra;
    if (heath && temperature > 1) return Biome.Moorland;
    return Biome.Taiga;
  }
  if (ctx.flat && moisture >= 0.8 && referenceHeightM < 300) return Biome.Wetland;
  if (temperature < 18) {
    if (moisture < 0.18) return desert(false);
    if (heath) return Biome.Moorland;
    if (coldestMonth < BOREAL_COLDEST_MONTH && moisture >= 0.38) return Biome.Taiga;
    if (moisture < 0.38) return winterWet ? Biome.Shrubland : Biome.TemperateGrassland;
    // Chalk and limestone downs: grassland where loam would carry forest.
    if (ctx.rock === LIMESTONE && moisture < 0.55) return Biome.TemperateGrassland;
    if (moisture < 0.72) return winterWet ? Biome.Shrubland : Biome.TemperateForest;
    return Biome.TemperateRainforest;
  }
  if (moisture < 0.18) return desert(true);
  if (ctx.coastal && moisture >= 0.5 && heightM < 12) return Biome.Mangrove;
  if (moisture < 0.32) return winterWet ? Biome.Shrubland : Biome.Savanna;
  if (moisture < 0.5) return Biome.Savanna;
  if (moisture < 0.75) return Biome.TropicalSeasonalForest;
  return Biome.TropicalRainforest;
}

export function computeBiomes(
  grid: CubeGrid,
  params: PlanetParams,
  height: Float32Array,
  climate: Climate,
  extra?: { lithology: Uint8Array; modifiers: ClimateModifiers; province?: Uint8Array },
): Uint8Array {
  const out = new Uint8Array(grid.cellCount);
  const n = grid.n;
  const nb = new Int32Array(8);
  for (let c = 0; c < grid.cellCount; c++) {
    const ref = height[c] / params.reliefScale;
    out[c] = classifyBiome(
      height[c],
      ref,
      climate.temperature[c]!,
      climate.moisture[c]!,
      climate.temperature[c]! - climate.temperatureRange[c]!,
      extra && height[c]! > 0
        ? biomeContext(
            n,
            c,
            height,
            params.reliefScale,
            extra.lithology[c]!,
            extra.modifiers,
            nb,
            extra.province?.[c],
          )
        : undefined,
    );
  }
  return out;
}

/** Reference slope below which ground counts as level for wetlands. */
const FLAT_SLOPE = 0.004;
/**
 * The same flatness on finer grids: a cell-to-cell slope grows as cells shrink,
 * since the eroded grid resolves the relief the coarse cells average out
 * (about 0.004 at 6 km, 0.012 at 1.5 km; decision 215).
 */
function flatSlope(cellSize: number): number {
  return FLAT_SLOPE * Math.max(1, 6_000 / cellSize) ** 0.8;
}

/**
 * The context of land cell `c` on an n-per-face grid (decision 211): the rock,
 * the modifiers, whether the sea or level ground is next to it. `nb` is scratch.
 */
export function biomeContext(
  n: number,
  c: number,
  height: Float32Array,
  reliefScale: number,
  lith: number,
  m: ClimateModifiers,
  nb: Int32Array,
  province = 0,
): BiomeContext {
  neighbors8(n, c, nb);
  let coastal = false;
  let steepest = 0;
  const cellRef = ((Math.PI / 2) * m.radius) / n / reliefScale;
  for (let k = 0; k < 8; k++) {
    const x = nb[k]!;
    if (x < 0) continue;
    if (height[x]! <= 0) coastal = true;
    steepest = Math.max(steepest, Math.abs(height[c]! - height[x]!) / reliefScale / cellRef);
  }
  return {
    rock: rockOf(lith),
    layered: isLayered(lith),
    seasonality: m.seasonality[c]!,
    fog: m.fog[c]!,
    coastal,
    flat: steepest < flatSlope(cellRef * reliefScale),
    ecotone: m.ecotone[c]!,
    plateau: province === Province.HighPlateau,
    moistureBias: m.moistureBias?.[c] ?? 0,
  };
}
