/**
 * The global pass (milestone 2): from a tectonic world to the eroded global
 * grid, drainage, rivers and biomes.
 *
 *   GPU (main thread, decision 22): detail noise → climate upsampling → erosion
 *   CPU (worker, via `finish`):      drainage → rivers → biomes → display maps
 *
 * The CPU part is injected as `finish`, so this module does not depend on the
 * worker plumbing (src/workers) and tests can run it in-process.
 */
import { LAPSE_RATE } from './climate';
import type { FinishInput, FinishResult } from './finishWorld';
import { runDetailStage } from './gpu/detailStage';
import { runErosion } from './gpu/erosion';
import { GlobalGrid } from './gpu/globalGrid';
import type { GpuContext } from './gpu/gpuContext';
import { upsampleMap } from './gpu/upsample';
import type { PlanetParams } from './params';
import type { World } from './pipeline';

export const GLOBAL_STAGES = ['detail', 'erosion', 'readback', 'drainage, rivers, biomes'] as const;

export interface GlobalWorld {
  n: number;
  /** The global grid, kept on the GPU for tile synthesis: maps "height" and "uplift". */
  grid: GlobalGrid;
  /** Eroded physical height (m), CPU copy. */
  height: Float32Array;
  /** Boundary uplift (reference m), CPU copy. */
  uplift: Float32Array;
  finish: FinishResult;
  timings: { stage: string; ms: number }[];
}

export interface GlobalOptions {
  n: number;
  finish: (input: FinishInput) => Promise<FinishResult>;
  onProgress?: (stage: string, fraction: number) => void;
  /** Checked between steps; return true to abandon the run. */
  cancelled?: () => boolean;
}

export class GlobalPassCancelled extends Error {
  constructor() {
    super('Global pass cancelled');
    this.name = 'GlobalPassCancelled';
  }
}

export async function buildGlobalWorld(
  gpu: GpuContext,
  params: PlanetParams,
  tectonic: World,
  opts: GlobalOptions,
): Promise<GlobalWorld> {
  const T = tectonic.info.resolution;
  const n = opts.n;
  const timings: { stage: string; ms: number }[] = [];
  const grid = new GlobalGrid(gpu, n);
  const check = () => {
    if (opts.cancelled?.()) {
      grid.dispose();
      throw new GlobalPassCancelled();
    }
  };
  let t0 = performance.now();
  const lap = (stage: string) => {
    const now = performance.now();
    timings.push({ stage, ms: now - t0 });
    t0 = now;
  };

  try {
    opts.onProgress?.('detail', 0);
    const m = tectonic.maps;
    runDetailStage(
      grid,
      { n: T, height: m.height, uplift: m.uplift },
      params.seed,
      params.reliefScale,
    );
    // Climate onto the global grid. Temperature goes up at sea level, so the
    // lapse rate can be reapplied to the finer, eroded heights.
    const seaLevel = new Float32Array(m.temperature.length);
    for (let c = 0; c < seaLevel.length; c++) {
      seaLevel[c] =
        m.temperature[c]! + (LAPSE_RATE * Math.max(0, m.height[c]!)) / params.reliefScale;
    }
    upsampleMap(grid, T, m.precipitation, 'precipitation');
    upsampleMap(grid, T, m.runoff, 'runoff');
    upsampleMap(grid, T, seaLevel, 'seaLevelTemperature');
    upsampleMap(grid, T, m.temperatureRange, 'temperatureRange');
    await gpu.finish();
    lap('detail + upsample');
    check();

    await runErosion(grid, {
      reliefScale: params.reliefScale,
      radius: params.radius,
      erosionStrength: params.erosionStrength,
      onProgress: (f) => {
        opts.onProgress?.('erosion', f);
        if (opts.cancelled?.()) throw new GlobalPassCancelled();
      },
    });
    lap('erosion');
    check();

    opts.onProgress?.('readback', 0);
    const height = await grid.readF32('height');
    const uplift = await grid.readF32('uplift');
    const input: FinishInput = {
      n,
      height: height.slice(),
      runoff: await grid.readF32('runoff'),
      precipitation: await grid.readF32('precipitation'),
      seaLevelTemperature: await grid.readF32('seaLevelTemperature'),
      temperatureRange: await grid.readF32('temperatureRange'),
      valleyFloor: grid.has('valleyFloor') ? await grid.readF32('valleyFloor') : undefined,
      reliefScale: params.reliefScale,
      radius: params.radius,
      displayN: T,
    };
    lap('readback');
    check();

    opts.onProgress?.('drainage, rivers, biomes', 0);
    const finish = await opts.finish(input);
    lap('drainage, rivers, biomes (worker)');
    check();
    opts.onProgress?.('done', 1);
    releaseUnused(grid);
    return { n, grid, height, uplift, finish, timings };
  } catch (err) {
    grid.dispose();
    throw err;
  }
}

/** Tile synthesis needs only height and uplift on the GPU; free the rest. */
function releaseUnused(grid: GlobalGrid): void {
  for (const name of [
    'precipitation',
    'runoff',
    'seaLevelTemperature',
    'temperatureRange',
    'valleyFloor',
    'glacier',
    'flow',
    'receiver',
  ]) {
    if (grid.has(name)) grid.release(name);
  }
}

/** Rebuilds a GlobalWorld from stored data (worldStore.ts): uploads height and uplift to the GPU. */
export function restoreGlobalWorld(
  gpu: GpuContext,
  stored: { n: number; height: Float32Array; uplift: Float32Array; finish: FinishResult },
): GlobalWorld {
  const grid = new GlobalGrid(gpu, stored.n);
  grid.upload('height', stored.height);
  grid.upload('uplift', stored.uplift);
  return {
    n: stored.n,
    grid,
    height: stored.height,
    uplift: stored.uplift,
    finish: stored.finish,
    timings: [],
  };
}
