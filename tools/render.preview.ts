/**
 * Offline renders of the real scene (milestone 3): the app's GlobeScene drawn
 * by three's WebGPURenderer on Dawn (tests/gpu/renderer.ts), from fixed
 * camera views, written as PNGs. This is how shading and atmosphere changes
 * are judged without a browser.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/render.preview.ts
 *   env: SEED (1983), TRES tectonic resolution (256), GRES global resolution (1024),
 *        VIEWS comma list of view names (all), W × H image size (1024 × 576),
 *        EX exaggeration (10)
 *
 * Output: tools/out/render-<seed>-<view>.png (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { defaultCampaignStart, sunDirection, withLocalTime } from '../src/core/calendar';
import { CubeGrid } from '../src/core/cubeGrid';
import { DEG, HOUR, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { GlobeScene } from '../src/render/globeScene';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { encodePng } from './png';
import { previewWorld } from './previewWorld';

export interface PreviewView {
  name: string;
  /** Offsets from the main continent's center, radians. */
  dLat: number;
  dLon: number;
  altitude: number;
  tilt: number;
  heading: number;
  /** Local solar time at the camera, hours, on the campaign's first day (default 11:00). */
  localTime?: number;
}

export const PREVIEW_VIEWS: PreviewView[] = [
  { name: 'orbit', dLat: 0, dLon: 0, altitude: 3000 * KM, tilt: 0, heading: 0, localTime: 11 },
  {
    name: 'limb',
    dLat: -20 * DEG,
    dLon: 0,
    altitude: 900 * KM,
    tilt: 36 * DEG,
    heading: 0,
    localTime: 10,
  },
  {
    name: 'terminator',
    dLat: 0,
    dLon: 0,
    altitude: 2500 * KM,
    tilt: 0,
    heading: 0,
    localTime: 18,
  },
  {
    name: 'oblique',
    dLat: 0,
    dLon: 0,
    altitude: 20 * KM,
    tilt: 78 * DEG,
    heading: 30 * DEG,
    localTime: 15,
  },
  {
    name: 'low',
    dLat: 0,
    dLon: 0,
    altitude: 2 * KM,
    tilt: 82 * DEG,
    heading: 200 * DEG,
    localTime: 9,
  },
  {
    name: 'sunset',
    dLat: 0,
    dLon: 0,
    altitude: 3 * KM,
    tilt: 84 * DEG,
    heading: 275 * DEG,
    localTime: 18.95,
  },
];

const env = (k: string, d: string) => process.env[k] ?? d;

it('renders preview views', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const seed = Number(env('SEED', '1983'));
  const tres = Number(env('TRES', '256'));
  const gres = Number(env('GRES', '1024'));
  const width = Number(env('W', '1024'));
  const height = Number(env('H', '576'));
  const exaggeration = Number(env('EX', '10'));
  const wanted = env('VIEWS', '');
  const views = PREVIEW_VIEWS.filter((v) => !wanted || wanted.split(',').includes(v.name));

  const params = { ...DEFAULT_PLANET_PARAMS, seed };
  const { world, global } = await previewWorld(gpu, params, tres, gres);

  const head = await headlessRenderer(gpu.device, width, height);
  const scene = new GlobeScene(head.renderer, {
    radius: params.radius,
    grid: new CubeGrid(tres),
    input: false,
  });
  scene.resize(width, height);
  scene.globe.setWorld(world);
  scene.globe.setExaggeration(exaggeration);
  scene.terrain.setExaggeration(exaggeration);
  scene.terrain.buildBudgetMs = 10_000;
  const synth = new TileSynthesizer(global.grid, {
    seed: params.seed,
    reliefScale: params.reliefScale,
    radius: params.radius,
    biome: global.finish.biome,
    lakeDepth: global.finish.drainage.lakeDepth,
    index: new RiverIndex(global.finish.rivers),
  });
  scene.terrain.setWorld({
    synth,
    seed: params.seed,
    radius: params.radius,
    reliefScale: params.reliefScale,
  });
  scene.terrainReady = true;

  const main = new Vec3d(...world.info.mainContinent);
  const lat0 = Math.asin(main.y);
  const lon0 = Math.atan2(main.x, main.z);
  const calendar = defaultCampaignStart(main, params);
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });

  for (const v of views) {
    const o = scene.orbit;
    o.lat = lat0 + v.dLat;
    o.lon = lon0 + v.dLon;
    o.altitude = o.targetAltitude = v.altitude;
    o.tilt = v.tilt;
    o.heading = v.heading;
    const t = withLocalTime(0, o.lon, (v.localTime ?? 11) * HOUR, params, calendar);
    sunDirection(t, params, calendar, scene.sun);
    // Render until the terrain has loaded everything this view wants.
    let stable = 0;
    let last = '';
    const t0 = performance.now();
    for (let f = 0; f < 400 && stable < 3; f++) {
      scene.render(0);
      await gpu.finish();
      await new Promise((r) => setTimeout(r, 2));
      const s = scene.terrain.stats;
      const sig = `${s.drawn}/${s.deepest}/${s.meshes}`;
      if (process.env.DEBUG) console.log(v.name, f, JSON.stringify(s), o.tilt, o.altitude);
      stable = s.pending === 0 && sig === last ? stable + 1 : 0;
      last = sig;
    }
    scene.render(0);
    const rgb = await head.readRgb();
    const file = join(outDir, `render-${seed}-${v.name}.png`);
    writeFileSync(file, encodePng(width, height, rgb));
    const s = scene.terrain.stats;
    console.log(
      `${v.name}: ${s.drawn} tiles, deepest ${s.deepest}, ${((performance.now() - t0) / 1000).toFixed(1)} s → ${file}`,
    );
  }
  if (gpu.errors.length) throw new Error(`GPU errors: ${gpu.errors.join(' | ')}`);
  scene.dispose();
  synth.dispose();
  global.grid.dispose();
  head.dispose();
});
