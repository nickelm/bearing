/**
 * The tile kernel under relief exaggeration (decision 297): synthesized from the
 * exaggerated global data at 1.3 and 1.5, a tile is the unexaggerated tile
 * stretched above the sea, with the same materials (biomes, rivers, lakes, forest).
 * Rivers' stepped profiles are recomputed on the scaled heights, so samples in a
 * few steep channels may differ; everything else agrees to float precision.
 */
import { describe, expect, it } from 'vitest';
import { tileForDirection, neighborTile } from '../../src/core/tiles';
import { Vec3d } from '../../src/core/vec3d';
import { finishWorld } from '../../src/worldgen/finishWorld';
import type { FinishResult } from '../../src/worldgen/finishWorld';
import { buildGlobalWorld } from '../../src/worldgen/globalPipeline';
import { TileSynthesizer } from '../../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { exaggerateRelief } from '../../src/worldgen/reliefExaggeration';
import { RiverIndex } from '../../src/worldgen/riverIndex';
import { testGpu } from './device';

const gpu = await testGpu();

describe.skipIf(!gpu)('tile synthesis under relief exaggeration (GPU)', async () => {
  const params = { ...DEFAULT_PLANET_PARAMS, erosionStrength: 0.3, reliefExaggeration: 1 };
  const world = generateWorld(params, { resolution: 64 });
  const g = gpu
    ? await buildGlobalWorld(gpu, params, world, {
        n: 256,
        finish: async (input) => finishWorld(input),
      })
    : null;
  const synthAt = (e: number) => {
    const height = g!.height.slice();
    const finish = structuredClone(g!.finish) as FinishResult;
    exaggerateRelief(height, finish, e);
    const index = new RiverIndex(finish.rivers, {
      height,
      radius: params.radius,
      lakeDepth: finish.drainage.lakeDepth,
    });
    return new TileSynthesizer(g!.grid, {
      seed: params.seed,
      reliefScale: params.reliefScale,
      radius: params.radius,
      biome: finish.biome,
      lakeDepth: finish.drainage.lakeDepth,
      height,
      forest: finish.forest,
      treeline: finish.treeline,
      lithology: finish.lithology,
      basinCell: finish.drainage.basinCell,
      basinLevel: finish.drainage.basinLevel,
      index,
      reliefExaggeration: e,
    });
  };
  const main = new Vec3d(...world.info.mainContinent);
  const a = tileForDirection(main, 6);
  const keys = [a, neighborTile(a, 1, 0), neighborTile(a, 0, 1)];

  it('stretches the unexaggerated tile and keeps its materials', async () => {
    const base = await synthAt(1).generate(keys);
    for (const e of [1.3, 1.5]) {
      const tiles = await synthAt(e).generate(keys);
      expect(gpu!.errors).toEqual([]);
      let samples = 0;
      let sameMaterial = 0;
      let stretched = 0;
      let land = 0;
      for (let t = 0; t < keys.length; t++) {
        const b = base[t]!;
        const x = tiles[t]!;
        for (let i = 0; i < b.height.length; i++) {
          samples++;
          if (b.material[i] === x.material[i]) sameMaterial++;
          const h0 = b.height[i]!;
          if (h0 <= 0) continue;
          land++;
          if (Math.abs(x.height[i]! - h0 * e) <= 0.01 * h0 * e + 0.05) stretched++;
        }
      }
      expect(land).toBeGreaterThan(samples / 4);
      expect(sameMaterial / samples).toBeGreaterThan(0.999);
      expect(stretched / land).toBeGreaterThan(0.99);
      // Taller: the highest sample grows by the factor.
      const hi0 = Math.max(...base.map((b) => b.maxHeight));
      const hi = Math.max(...tiles.map((b) => b.maxHeight));
      expect(hi / hi0).toBeCloseTo(e, 1);
    }
  });
});
