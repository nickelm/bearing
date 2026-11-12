/**
 * Forest cover on the global grid (decision 44). World-generation data, not
 * just rendering: the line-of-sight system and the barrier map read it too.
 *
 * Per global cell:
 * - base density 0..1 from the biome (forest biomes high, savanna and
 *   shrubland sparse, grassland and colder biomes nearly bare);
 * - treeline: the physical height where the warmest month cools to 10 °C,
 *   the classic limit of tree growth. Reference height uses the lapse rate
 *   (decision 19).
 *
 * Tile synthesis turns these into per-sample density with the fine height,
 * slope, water and clumping noise (worldgen/gpu/tileSynth.ts).
 */
import { Biome } from './biomes';
import { heightAtEarthElevation, LAPSE_RATE } from './climate';
import type { FinishInput } from './finishWorld';

/** Warmest-month mean temperature at the treeline (°C). */
export const TREELINE_WARMEST_MONTH = 10;

/** Canopy fraction per biome before local variation. */
export const FOREST_BASE: Readonly<Partial<Record<Biome, number>>> = {
  [Biome.TemperateForest]: 0.85,
  [Biome.TemperateRainforest]: 0.95,
  [Biome.Taiga]: 0.75,
  [Biome.TropicalRainforest]: 0.95,
  [Biome.TropicalSeasonalForest]: 0.75,
  [Biome.Savanna]: 0.22,
  [Biome.Shrubland]: 0.18,
  [Biome.TemperateGrassland]: 0.1,
  [Biome.Tundra]: 0.03,
};

export interface ForestMaps {
  /** Base density per global cell, 0..255. */
  forest: Uint8Array;
  /** Treeline height per global cell (physical m; below 0 where trees cannot grow at all). */
  treeline: Float32Array;
}

export function forestMaps(input: FinishInput, biome: Uint8Array): ForestMaps {
  const { seaLevelTemperature, temperatureRange, reliefScale } = input;
  const forest = new Uint8Array(biome.length);
  const treeline = new Float32Array(biome.length);
  for (let c = 0; c < biome.length; c++) {
    forest[c] = Math.round(255 * (FOREST_BASE[biome[c] as Biome] ?? 0));
    const warmest = seaLevelTemperature[c]! + temperatureRange[c]!;
    // The physical height whose Earth-like elevation reaches the treeline (decision 122).
    const elevation = (warmest - TREELINE_WARMEST_MONTH) / LAPSE_RATE;
    const floor = input.valleyFloor?.[c];
    treeline[c] =
      floor === undefined
        ? elevation * reliefScale
        : heightAtEarthElevation(elevation, floor, reliefScale);
  }
  return { forest, treeline };
}
