/**
 * Draws the strategic view's scene (decision 74) with three's WebGPURenderer on
 * Dawn: the shaders compile and run, and the globe covers the expected part of
 * the frame at the ceiling and at the zoom floor.
 */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../../src/core/cubeGrid';
import { Vec3d } from '../../src/core/vec3d';
import { STRATEGIC_CEILING, STRATEGIC_FLOOR } from '../../src/render/strategic/strategicCamera';
import { StrategicScene } from '../../src/render/strategic/strategicScene';
import { STRATEGIC_MAX_LEVEL } from '../../src/render/strategic/strategicRelief';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { finishWorld } from '../../src/worldgen/finishWorld';
import { buildGlobalWorld } from '../../src/worldgen/globalPipeline';
import { TileSynthesizer } from '../../src/worldgen/gpu/tileSynth';
import { RiverIndex } from '../../src/worldgen/riverIndex';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('StrategicScene on Dawn', () => {
  it('renders the map globe at the ceiling and the floor without GPU errors', async () => {
    const params = DEFAULT_PLANET_PARAMS;
    const world = generateWorld(params, { resolution: 64 });
    const head = await headlessRenderer(gpu!.device, 256, 128);
    const scene = new StrategicScene(head.renderer, {
      radius: params.radius,
      grid: new CubeGrid(64),
      input: false,
    });
    scene.resize(head.width, head.height);
    scene.render(0); // before a world exists, as in the app
    await gpu!.finish();
    scene.setWorld(world);
    const main = new Vec3d(...world.info.mainContinent);
    const o = scene.orbit;
    o.lat = Math.asin(main.y);
    o.lon = Math.atan2(main.x, main.z);

    /** Fraction of pixels that differ from the top-left corner (the background). */
    const covered = (rgb: Uint8Array) => {
      let n = 0;
      for (let i = 0; i < rgb.length; i += 3) {
        const d =
          Math.abs(rgb[i]! - rgb[0]!) +
          Math.abs(rgb[i + 1]! - rgb[1]!) +
          Math.abs(rgb[i + 2]! - rgb[2]!);
        if (d > 12) n++;
      }
      return n / (rgb.length / 3);
    };
    const frame = async (altitude: number) => {
      o.altitude = o.targetAltitude = altitude;
      scene.render(0);
      await gpu!.finish();
      return head.readRgb();
    };

    // At the ceiling the whole globe shows, with background around it.
    const ceiling = covered(await frame(STRATEGIC_CEILING));
    // At the floor, tilted 50°, ground still fills a landscape frame: the horizon is just out of view.
    const rgb = await frame(STRATEGIC_FLOOR);
    let lit = 0;
    for (let i = 0; i < rgb.length; i += 3) if (rgb[i]! + rgb[i + 1]! + rgb[i + 2]! > 30) lit++;

    expect(gpu!.errors).toEqual([]);
    expect(ceiling).toBeGreaterThan(0.1);
    expect(ceiling).toBeLessThan(0.9);
    expect(lit / (rgb.length / 3)).toBeGreaterThan(0.9);

    scene.dispose();
    head.dispose();
  }, 120_000);

  it('draws the relief mesh at the floor within the level cap', async () => {
    const params = { ...DEFAULT_PLANET_PARAMS, erosionStrength: 0.2 };
    const world = generateWorld(params, { resolution: 64 });
    const g = await buildGlobalWorld(gpu!, params, world, {
      n: 256,
      finish: async (input) => finishWorld(input),
    });
    const head = await headlessRenderer(gpu!.device, 256, 128);
    const scene = new StrategicScene(head.renderer, {
      radius: params.radius,
      grid: new CubeGrid(64),
      input: false,
    });
    scene.resize(head.width, head.height);
    scene.setWorld(world);
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
    scene.setTerrainWorld({
      synth,
      seed: params.seed,
      radius: params.radius,
      reliefScale: params.reliefScale,
      biome: g.finish.biome,
      biomeResolution: g.n,
      height: g.height,
    });
    scene.relief.buildBudgetMs = 10_000;
    const main = new Vec3d(...world.info.mainContinent);
    const o = scene.orbit;
    o.lat = Math.asin(main.y);
    o.lon = Math.atan2(main.x, main.z);
    o.altitude = o.targetAltitude = STRATEGIC_FLOOR;
    for (let f = 0; f < 60; f++) {
      scene.render(0);
      await gpu!.finish();
      await new Promise((r) => setTimeout(r, 2));
    }
    const rgb = await head.readRgb();
    let lit = 0;
    for (let i = 0; i < rgb.length; i += 3) if (rgb[i]! + rgb[i + 1]! + rgb[i + 2]! > 30) lit++;
    expect(gpu!.errors).toEqual([]);
    expect(scene.relief.stats.drawn).toBeGreaterThan(0);
    expect(scene.relief.stats.deepest).toBeLessThanOrEqual(STRATEGIC_MAX_LEVEL);
    expect(lit / (rgb.length / 3)).toBeGreaterThan(0.9);
    scene.dispose();
    synth.dispose();
    g.grid.dispose();
    head.dispose();
  }, 300_000);
});
