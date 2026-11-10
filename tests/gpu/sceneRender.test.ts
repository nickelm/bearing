/**
 * Draws the app's GlobeScene with three's WebGPURenderer on Dawn, so every
 * material's shaders compile and run in Vitest (decision 32). Image content is
 * judged with tools/render.preview.ts; here we only check for GPU errors and a
 * plausible frame.
 */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../../src/core/cubeGrid';
import { DEG, KM } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { GlobeScene } from '../../src/render/globeScene';
import { finishWorld } from '../../src/worldgen/finishWorld';
import { buildGlobalWorld } from '../../src/worldgen/globalPipeline';
import { TileSynthesizer } from '../../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { RiverIndex } from '../../src/worldgen/riverIndex';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('GlobeScene on Dawn', () => {
  it('renders the globe and tiled terrain without GPU errors', async () => {
    const params = { ...DEFAULT_PLANET_PARAMS, erosionStrength: 0.2 };
    const world = generateWorld(params, { resolution: 64 });
    const g = await buildGlobalWorld(gpu!, params, world, {
      n: 256,
      finish: async (input) => finishWorld(input),
    });
    const head = await headlessRenderer(gpu!.device, 256, 128);
    const scene = new GlobeScene(head.renderer, {
      radius: params.radius,
      grid: new CubeGrid(64),
      input: false,
    });
    scene.resize(head.width, head.height);
    scene.globe.setWorld(world);
    scene.terrain.buildBudgetMs = 10_000;
    const synth = new TileSynthesizer(g.grid, {
      seed: params.seed,
      reliefScale: params.reliefScale,
      radius: params.radius,
      biome: g.finish.biome,
      lakeDepth: g.finish.drainage.lakeDepth,
      index: new RiverIndex(g.finish.rivers),
    });
    scene.terrain.setWorld({
      synth,
      seed: params.seed,
      radius: params.radius,
      reliefScale: params.reliefScale,
    });
    const main = new Vec3d(...world.info.mainContinent);
    const o = scene.orbit;
    o.lat = Math.asin(main.y);
    o.lon = Math.atan2(main.x, main.z);

    const frames = async (n: number) => {
      for (let f = 0; f < n; f++) {
        scene.render(0);
        await gpu!.finish();
        await new Promise((r) => setTimeout(r, 2));
      }
    };
    const litFraction = (rgb: Uint8Array) => {
      let lit = 0;
      for (let i = 0; i < rgb.length; i += 3) if (rgb[i]! + rgb[i + 1]! + rgb[i + 2]! > 30) lit++;
      return lit / (rgb.length / 3);
    };

    // The M1 grid mesh from orbit.
    o.altitude = o.targetAltitude = 3000 * KM;
    scene.terrainReady = false;
    await frames(2);
    const grid = litFraction(await head.readRgb());

    // Tiled terrain, from orbit and low over the ground.
    scene.terrainReady = true;
    await frames(10);
    const orbit = litFraction(await head.readRgb());
    o.altitude = o.targetAltitude = 3 * KM;
    o.tilt = 80 * DEG;
    await frames(40);
    const low = litFraction(await head.readRgb());

    expect(gpu!.errors).toEqual([]);
    expect(grid).toBeGreaterThan(0.1);
    expect(orbit).toBeGreaterThan(0.1);
    expect(low).toBeGreaterThan(0.3);

    scene.dispose();
    synth.dispose();
    g.grid.dispose();
    head.dispose();
  }, 300_000);
});
