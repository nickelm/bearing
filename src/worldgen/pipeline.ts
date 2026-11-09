/**
 * The generation pipeline: runs the stages in order on one CubeGrid.
 *
 * Every stage receives only its own stream, rng(seed, "<stage>"), so changing
 * one stage's code or parameters never shifts another stage's randomness.
 * The output is plain typed arrays and numbers, which a worker can transfer
 * without copying.
 */
import { CubeGrid } from '../core/cubeGrid';
import { rng } from '../core/rng';
import { computeBiomes, computeClimate } from './biomes';
import { classifyBoundaries } from './boundaries';
import { continentalCrust, layoutContinents } from './continents';
import { computeElevation, computeUplift } from './elevation';
import type { PlanetParams } from './params';
import { growPlates, seedPlates } from './plates';

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
  /** Relative moisture 0..1. */
  moisture: Float32Array;
  /** Biome per cell. */
  biome: Uint8Array;
}

export interface StageTiming {
  stage: string;
  ms: number;
}

export interface WorldInfo {
  resolution: number;
  plateCount: number;
  /** Continent centers as [x, y, z] unit vectors. */
  mainContinent: [number, number, number];
  secondContinent: [number, number, number];
  continentSeparation: number;
  seaLevelReference: number;
  minHeight: number;
  maxHeight: number;
  /** Area fraction above sea level. */
  landFraction: number;
  timings: StageTiming[];
}

export interface World {
  maps: WorldMaps;
  info: WorldInfo;
}

export type ProgressCallback = (stage: string, fraction: number) => void;

export const PIPELINE_STAGES = [
  'grid',
  'continents',
  'plates',
  'boundaries',
  'uplift',
  'elevation',
  'climate',
  'biomes',
] as const;

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
  const { layout, continentalness } = stage('continents', () => {
    const r = rng(seed, 'continents');
    const layout = layoutContinents(params, r.fork('layout'));
    return { layout, continentalness: continentalCrust(grid, params, layout, r.fork('crust')) };
  });
  const { plates, plate } = stage('plates', () => {
    const r = rng(seed, 'plates');
    const plates = seedPlates(params.plateCount, layout, r.fork('seeds'));
    return { plates, plate: growPlates(grid, plates, r.fork('growth')) };
  });
  const boundaries = stage('boundaries', () =>
    classifyBoundaries(grid, plates, plate, continentalness, params.radius),
  );
  const uplift = stage('uplift', () =>
    computeUplift(grid, params, boundaries, rng(seed, 'uplift')),
  );
  const elevation = stage('elevation', () =>
    computeElevation(grid, params, continentalness, uplift, rng(seed, 'elevation')),
  );
  const climate = stage('climate', () =>
    computeClimate(grid, params, elevation.height, rng(seed, 'climate')),
  );
  const biome = stage('biomes', () => computeBiomes(grid, params, elevation.height, climate));
  options.onProgress?.('done', 1);

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
      moisture: climate.moisture,
      biome,
    },
    info: {
      resolution: grid.n,
      plateCount: plates.length,
      mainContinent: [layout.main.x, layout.main.y, layout.main.z],
      secondContinent: [layout.second.x, layout.second.y, layout.second.z],
      continentSeparation: layout.separation,
      seaLevelReference: elevation.seaLevelReference,
      minHeight,
      maxHeight,
      landFraction: landArea / totalArea,
      timings,
    },
  };
}

/** All typed arrays of a world, e.g. for a worker transfer list. */
export function worldBuffers(maps: WorldMaps): ArrayBuffer[] {
  return Object.values(maps).map((a: ArrayBufferView) => a.buffer as ArrayBuffer);
}
