/**
 * A generated world for offline tools, cached on disk between runs.
 *
 * The cache lives in the OS temp directory (not tools/out, which is inside
 * Dropbox): a world at 1024² is about 150 MB. Keys come from `worldKey`, so a
 * GENERATOR_VERSION bump or a parameter change regenerates.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import type { GpuContext } from '../src/worldgen/gpu/gpuContext';
import { finishWorld } from '../src/worldgen/finishWorld';
import { buildGlobalWorld, restoreGlobalWorld } from '../src/worldgen/globalPipeline';
import type { GlobalWorld } from '../src/worldgen/globalPipeline';
import type { PlanetParams } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import type { World } from '../src/worldgen/pipeline';
import { GENERATOR_VERSION, worldKey } from '../src/worldgen/worldStore';
import type { StoredWorld } from '../src/worldgen/worldStore';

const CACHE_DIR = join(tmpdir(), 'bearing-tools-worlds');

export interface PreviewWorld {
  world: World;
  global: GlobalWorld;
}

export async function previewWorld(
  gpu: GpuContext,
  params: PlanetParams,
  tectonicN: number,
  globalN: number,
): Promise<PreviewWorld> {
  const key = worldKey(params, tectonicN, globalN);
  const file = join(CACHE_DIR, `${key}.v8`);
  if (existsSync(file)) {
    const stored = deserialize(readFileSync(file)) as StoredWorld;
    if (stored.version === GENERATOR_VERSION) {
      console.log(`world ${key}: from cache`);
      return { world: stored.tectonic, global: restoreGlobalWorld(gpu, stored.global) };
    }
  }
  const t0 = performance.now();
  const world = generateWorld(params, { resolution: tectonicN });
  const global = await buildGlobalWorld(gpu, params, world, {
    n: globalN,
    finish: async (input) => finishWorld(input),
  });
  console.log(`world ${key}: generated in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const stored: StoredWorld = {
    key,
    version: GENERATOR_VERSION,
    savedAt: Date.now(),
    tectonic: world,
    global: { n: global.n, height: global.height, uplift: global.uplift, finish: global.finish },
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, serialize(stored));
  return { world, global };
}
