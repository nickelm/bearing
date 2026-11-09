import { describe, expect, it } from 'vitest';
import { Biome } from '../../src/worldgen/biomes';
import { finishWorld } from '../../src/worldgen/finishWorld';
import { buildGlobalWorld, GlobalPassCancelled } from '../../src/worldgen/globalPipeline';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { testGpu } from './device';

const gpu = await testGpu();

describe.skipIf(!gpu)('global pass (GPU + in-process CPU)', () => {
  const params = { ...DEFAULT_PLANET_PARAMS, erosionStrength: 0.15 };
  const T = 32;
  const N = 128;
  const world = generateWorld(params, { resolution: T });

  it('produces an eroded world with rivers, lakes, biomes and display maps', async () => {
    const g = await buildGlobalWorld(gpu!, params, world, {
      n: N,
      finish: async (input) => finishWorld(input),
    });
    expect(gpu!.errors).toEqual([]);
    const f = g.finish;
    expect(f.rivers.count).toBeGreaterThan(0);
    expect(f.display.height.length).toBe(6 * T * T);
    expect(f.biome.length).toBe(6 * N * N);
    // Land biomes on land, sea biomes at sea.
    for (let c = 0; c < g.height.length; c++) {
      const sea = f.biome[c]! <= Biome.SeaIce;
      if (g.height[c]! <= 0) expect(sea).toBe(true);
    }
    // The land fraction survives the global pass.
    let land = 0;
    for (const h of g.height) if (h > 0) land++;
    expect(Math.abs(land / g.height.length - world.info.landFraction)).toBeLessThan(0.05);
    g.grid.dispose();
  });

  it('can be cancelled between steps', async () => {
    let calls = 0;
    await expect(
      buildGlobalWorld(gpu!, params, world, {
        n: N,
        finish: async (input) => finishWorld(input),
        cancelled: () => ++calls > 1,
      }),
    ).rejects.toBeInstanceOf(GlobalPassCancelled);
  });
});
