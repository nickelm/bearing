/**
 * The generation pipeline: runs the stages in order on one CubeGrid.
 *
 * Every stage receives only its own stream, rng(seed, "<stage>"), so changing
 * one stage's code or parameters never shifts another stage's randomness.
 * The output is plain typed arrays and numbers, which a worker can transfer
 * without copying.
 */
import {
  continentDivergence,
  DISTINCT_JSD,
  drawCharacters,
  effectAt,
  labelContinents,
  largestTwo,
  MAX_REDRAWS,
  redrawCharacter,
} from './characters';
import type { Character } from './characters';
import { computeClimateModifiers } from './climateModifiers';
import { assignLithology } from './lithology';
import { assignProvinces } from './provinces';
import { CubeGrid } from '../core/cubeGrid';
import { rng } from '../core/rng';
import { computeBiomes } from './biomes';
import { computeClimate } from './climate';
import { classifyBoundaries } from './boundaries';
import { continentalCrust } from './crust';
import { computeElevation, computeUplift } from './elevation';
import type { PlanetParams } from './params';
import { labelLandmasses } from './landmasses';
import { assignPlateTypes, growPlates, seedPlates } from './plates';

/** Per-cell maps, indexed by CubeGrid cell. */
export interface WorldMaps {
  /** Signed continentalness: > 0 continental crust. */
  continentalness: Float32Array;
  plate: Uint8Array;
  /** BoundaryType per cell. */
  boundary: Uint8Array;
  /** Boundary uplift in reference meters. */
  uplift: Float32Array;
  /** Physical height above sea level (m). */
  height: Float32Array;
  /** Annual mean temperature (°C). */
  temperature: Float32Array;
  /** Seasonal half-range: (warmest month − coldest month) / 2 (K). */
  temperatureRange: Float32Array;
  /** Annual precipitation (mm/yr). */
  precipitation: Float32Array;
  /** Relative moisture 0..1 (0.5 × precipitation / potential evapotranspiration). */
  moisture: Float32Array;
  /** Runoff after evapotranspiration (mm/yr). */
  runoff: Float32Array;
  /**
   * Largest river discharge per cell (m³/s). Zero until the global pass
   * (globalPipeline.ts) has run and replaced the display maps.
   */
  discharge: Float32Array;
  /** Lake depth per cell (m); zero until the global pass. */
  lakeDepth: Float32Array;
  /** Prevailing surface wind, east and north components. */
  windEast: Float32Array;
  windNorth: Float32Array;
  /** Biome per cell. */
  biome: Uint8Array;
  /** Terrain province per cell (`Province`, decision 204). */
  province: Uint8Array;
  /** Rock per cell (`Rock`, with `LAYERED` on horizontal sedimentary rock; decision 204). */
  lithology: Uint8Array;
  /** Climate modifiers (decision 209): seasonality −1..1, cold-current fog 0..1, ecotone noise. */
  seasonality: Float32Array;
  fog: Float32Array;
  ecotone: Float32Array;
  /** Moisture offset from the continent's character (decision 210). */
  moistureBias: Float32Array;
}

export interface StageTiming {
  stage: string;
  ms: number;
}

export interface WorldInfo {
  resolution: number;
  plateCount: number;
  /** Number of continental plates (decision 46). */
  continentalPlateCount: number;
  /**
   * Most inland point of the largest landmass, as an [x, y, z] unit vector
   * (decision 46). Anchors the campaign calendar, previews and tests until the
   * strategic graph exists.
   */
  mainContinent: [number, number, number];
  /** Landmasses of at least LANDMASS_MIN_AREA. */
  landmassCount: number;
  /** Area of the largest landmass (m²). */
  largestLandmassArea: number;
  seaLevelReference: number;
  /** Multiplier from reference to physical elevation (decision 14). */
  reliefScale: number;
  minHeight: number;
  maxHeight: number;
  /** Area fraction above sea level. */
  landFraction: number;
  /** Continents of continental crust with their characters (decision 210), largest first. */
  continents?: { character: Character; area: number; latitude: number }[];
  /** Times the distinctness check redrew a character (decision 210). */
  characterRedraws?: number;
  timings: StageTiming[];
}

export interface World {
  maps: WorldMaps;
  info: WorldInfo;
}

export type ProgressCallback = (stage: string, fraction: number) => void;

export const PIPELINE_STAGES = [
  'grid',
  'plates',
  'crust',
  'boundaries',
  'continents',
  'provinces',
  'uplift',
  'elevation',
  'climate',
  'climate modifiers',
  'lithology',
  'biomes',
  'distinctness',
] as const;

/** Smallest landmass counted in `WorldInfo.landmassCount` (design, "Reading the World"). */
export const LANDMASS_MIN_AREA = 2000e6;

export interface GenerateOptions {
  /** Cells per cube-face edge. */
  resolution: number;
  onProgress?: ProgressCallback;
  /** Reuse a grid of the right resolution, e.g. in tests. */
  grid?: CubeGrid;
}

export function generateWorld(params: PlanetParams, options: GenerateOptions): World {
  const timings: StageTiming[] = [];
  let stageIndex = 0;
  const stage = <T>(name: (typeof PIPELINE_STAGES)[number], fn: () => T): T => {
    options.onProgress?.(name, stageIndex / PIPELINE_STAGES.length);
    const t0 = performance.now();
    const result = fn();
    timings.push({ stage: name, ms: performance.now() - t0 });
    stageIndex++;
    return result;
  };

  const seed = params.seed;
  const grid = stage('grid', () =>
    options.grid && options.grid.n === options.resolution
      ? options.grid
      : new CubeGrid(options.resolution),
  );
  const { plates, plate } = stage('plates', () => {
    const r = rng(seed, 'plates');
    const plates = seedPlates(params.plateCount, r.fork('seeds'));
    const plate = growPlates(grid, plates, r.fork('growth'));
    assignPlateTypes(grid, plates, plate, 1 - params.oceanFraction, r.fork('types'));
    return { plates, plate };
  });
  const continentalness = stage('crust', () =>
    continentalCrust(grid, params, plates, plate, rng(seed, 'crust')),
  );
  const boundaries = stage('boundaries', () =>
    classifyBoundaries(grid, plates, plate, continentalness, params.radius),
  );
  // Continents and their characters (decision 210): drawn before provinces, so
  // they can bias them; redrawn below when the two largest come out alike.
  const continents = stage('continents', () =>
    labelContinents(grid, params.radius, continentalness, boundaries, plate),
  );
  const characterRng = rng(seed, 'provinces').fork('characters');
  const character = drawCharacters(continents, characterRng);
  const run = (st: typeof stage) => {
    const characters = { label: continents.label, character };
    const provinces = st('provinces', () =>
      assignProvinces(
        grid,
        params.radius,
        plates,
        plate,
        continentalness,
        boundaries,
        rng(seed, 'provinces'),
        characters,
      ),
    );
    const uplift = st('uplift', () =>
      computeUplift(grid, params, boundaries, rng(seed, 'uplift'), provinces),
    );
    const elevation = st('elevation', () =>
      computeElevation(grid, params, continentalness, uplift, rng(seed, 'elevation')),
    );
    const climate = st('climate', () =>
      computeClimate(grid, params, elevation.height, rng(seed, 'climate')),
    );
    const modifiers = st('climate modifiers', () => {
      const m = computeClimateModifiers(
        grid,
        params.radius,
        elevation.height,
        rng(seed, 'climate-modifiers'),
      );
      m.moistureBias = new Float32Array(grid.cellCount);
      for (let c = 0; c < grid.cellCount; c++) m.moistureBias[c] = effectAt(characters, c).moisture;
      return m;
    });
    const { lithology } = st('lithology', () =>
      assignLithology(
        grid,
        provinces.province,
        elevation.height,
        climate.temperature,
        rng(seed, 'lithology'),
        characters,
      ),
    );
    const biome = st('biomes', () =>
      computeBiomes(grid, params, elevation.height, climate, {
        lithology,
        modifiers,
        province: provinces.province,
      }),
    );
    return { provinces, uplift, elevation, climate, modifiers, lithology, biome };
  };
  let built = run(stage);
  // Distinctness (decision 210): at most MAX_REDRAWS redraws of the smaller of the
  // two largest continents' characters, each from its own sub-stream.
  const redraws = stage('distinctness', () => {
    let count = 0;
    const plain = <T>(_: string, fn: () => T): T => fn();
    for (;;) {
      const two = largestTwo(continents);
      if (two.length < 2 || count >= MAX_REDRAWS) break;
      const [a, b] = [two[0]!, two[1]!];
      const d = continentDivergence(
        continents.label,
        a,
        b,
        built.provinces.province,
        built.biome,
        built.elevation.height,
      );
      if (d >= DISTINCT_JSD) break;
      count++;
      character[b] = redrawCharacter(
        continents,
        b,
        [character[a]!, character[b]!],
        characterRng.fork(`nudge-${count}`),
      );
      built = run(plain as typeof stage);
    }
    return count;
  });
  const { provinces, uplift, elevation, climate, modifiers, lithology, biome } = built;
  options.onProgress?.('done', 1);

  const { landmasses } = labelLandmasses(grid, elevation.height, params.radius);
  const main = landmasses[0];
  const anchor = grid.center(main ? main.interiorCell : 0);

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let landArea = 0;
  let totalArea = 0;
  const h = elevation.height;
  for (let c = 0; c < grid.cellCount; c++) {
    minHeight = Math.min(minHeight, h[c]);
    maxHeight = Math.max(maxHeight, h[c]);
    totalArea += grid.areas[c];
    if (h[c] > 0) landArea += grid.areas[c];
  }

  return {
    maps: {
      continentalness,
      plate,
      boundary: boundaries.type,
      uplift,
      height: h,
      temperature: climate.temperature,
      temperatureRange: climate.temperatureRange,
      precipitation: climate.precipitation,
      moisture: climate.moisture,
      runoff: climate.runoff,
      discharge: new Float32Array(grid.cellCount),
      lakeDepth: new Float32Array(grid.cellCount),
      windEast: climate.windEast,
      windNorth: climate.windNorth,
      biome,
      province: provinces.province,
      lithology,
      seasonality: modifiers.seasonality,
      fog: modifiers.fog,
      ecotone: modifiers.ecotone,
      moistureBias: modifiers.moistureBias!,
    },
    info: {
      resolution: grid.n,
      plateCount: plates.length,
      continentalPlateCount: plates.filter((p) => p.continental).length,
      mainContinent: [anchor.x, anchor.y, anchor.z],
      landmassCount: landmasses.filter((m) => m.area >= LANDMASS_MIN_AREA).length,
      largestLandmassArea: main ? main.area : 0,
      seaLevelReference: elevation.seaLevelReference,
      reliefScale: params.reliefScale,
      minHeight,
      maxHeight,
      landFraction: landArea / totalArea,
      continents: continents.area
        .map((area, k) => ({ character: character[k]!, area, latitude: continents.latitude[k]! }))
        .sort((x, y) => y.area - x.area),
      characterRedraws: redraws,
      timings,
    },
  };
}

/** All typed arrays of a world, e.g. for a worker transfer list. */
export function worldBuffers(maps: WorldMaps): ArrayBuffer[] {
  return Object.values(maps).map((a: ArrayBufferView) => a.buffer as ArrayBuffer);
}
