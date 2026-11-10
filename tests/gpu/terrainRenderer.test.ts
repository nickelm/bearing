import { describe, expect, it } from 'vitest';
import { DEG, KM } from '../../src/core/units';
import { OrbitCamera } from '../../src/render/orbitCamera';
import { TerrainRenderer } from '../../src/render/terrain/terrainRenderer';
import { finishWorld } from '../../src/worldgen/finishWorld';
import { buildGlobalWorld } from '../../src/worldgen/globalPipeline';
import { TileSynthesizer } from '../../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { RiverIndex } from '../../src/worldgen/riverIndex';
import { Vec3d } from '../../src/core/vec3d';
import { testGpu } from './device';

const gpu = await testGpu();

describe.skipIf(!gpu)('TerrainRenderer (Dawn synthesis, no drawing)', () => {
  it('loads tiles and refines toward the ground as the camera descends', async () => {
    const params = { ...DEFAULT_PLANET_PARAMS, erosionStrength: 0.2 };
    const world = generateWorld(params, { resolution: 64 });
    const g = await buildGlobalWorld(gpu!, params, world, {
      n: 256,
      finish: async (input) => finishWorld(input),
    });
    const synth = new TileSynthesizer(g.grid, {
      seed: params.seed,
      reliefScale: params.reliefScale,
      radius: params.radius,
      biome: g.finish.biome,
      lakeDepth: g.finish.drainage.lakeDepth,
      height: g.height,
      forest: g.finish.forest,
      treeline: g.finish.treeline,
      index: new RiverIndex(g.finish.rivers),
    });
    const terrain = new TerrainRenderer();
    terrain.setExaggeration(10);
    terrain.buildBudgetMs = 1000;
    terrain.setWorld({
      synth,
      seed: params.seed,
      radius: params.radius,
      reliefScale: params.reliefScale,
    });

    const main = new Vec3d(...world.info.mainContinent);
    const cam = new OrbitCamera(params.radius, {
      minAltitude: 500,
      maxAltitude: 10_000 * KM,
      maxTilt: 80 * DEG,
      maxLatitude: 89 * DEG,
    });
    cam.lat = Math.asin(main.y);
    cam.lon = Math.atan2(main.x, main.z);

    const frame = async () => {
      cam.update(0);
      terrain.update({
        eye: cam.eye,
        forward: cam.forward,
        up: cam.up,
        fovY: 45 * DEG,
        aspect: 16 / 9,
        viewportHeight: 1080,
        radius: params.radius,
        maxHeight: 1500 * 10,
      });
      // Let a pending tile batch finish.
      await new Promise((r) => setTimeout(r, 5));
      await gpu!.finish();
      await new Promise((r) => setTimeout(r, 5));
    };

    const deepestAt = async (altitude: number, frames: number) => {
      cam.altitude = cam.targetAltitude = altitude;
      for (let f = 0; f < frames; f++) await frame();
      return terrain.stats.deepest;
    };

    const orbit = await deepestAt(5000 * KM, 6);
    expect(terrain.stats.drawn).toBeGreaterThan(0);
    const mid = await deepestAt(100 * KM, 30);
    const low = await deepestAt(3 * KM, 60);
    expect(gpu!.errors).toEqual([]);
    expect(orbit).toBeLessThanOrEqual(3);
    expect(mid).toBeGreaterThan(orbit);
    expect(low).toBeGreaterThanOrEqual(9);
    expect(terrain.stats.drawn).toBeLessThan(600);

    // Ground height under the camera comes from cached tile data.
    const h = terrain.heightAt(cam.eye.clone().normalize());
    expect(h).not.toBeNull();
    expect(Number.isFinite(h!)).toBe(true);

    terrain.dispose();
    synth.dispose();
    g.grid.dispose();
  }, 300_000);
});
