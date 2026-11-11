/**
 * Offline renders of the real scene (milestone 3): the app's GlobeScene drawn
 * by three's WebGPURenderer on Dawn (tests/gpu/renderer.ts), from fixed
 * camera views, written as PNGs. This is how shading and atmosphere changes
 * are judged without a browser.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/render.preview.ts
 *   env: SEED (1983), TRES tectonic resolution (256), GRES global resolution (1024),
 *        VIEWS comma list of view names (all), W × H image size (1024 × 576),
 *        EX exaggeration (10),
 *        PERF=n times n more frames per view once loaded: ms per frame until the GPU is
 *          done, CPU in scene.render and its parts, terrain loop lengths, draw statistics
 *          (on a software adapter only the ratios mean anything),
 *        PROF=<file> also writes a V8 CPU profile of those frames (.cpuprofile)
 *
 * Output: tools/out/render-<seed>-<view>.png (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import {
  defaultCampaignStart,
  seasonPhase,
  sunDirection,
  withLocalTime,
} from '../src/core/calendar';
import { cubeFaceUvToDirection } from '../src/core/coords';
import type { CubeFace } from '../src/core/coords';
import { CubeGrid } from '../src/core/cubeGrid';
import { DAY, DEG, HOUR, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { GlobeScene } from '../src/render/globeScene';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { headlessRenderer } from '../tests/gpu/renderer';
import { encodePng } from './png';
import { previewWorld } from './previewWorld';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { settlementPoint } from '../src/worldgen/strategic/graph';
import { InfraScene } from '../src/render/infra/infraScene';
import { buildWeatherClimate } from '../src/sim/weather/climate';
import { WeatherGrid } from '../src/sim/weather/grid';
import { createSimWorld } from '../src/sim/world';

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
  /** Days after the campaign start (default 0, mid-August local to the main continent). */
  day?: number;
  /**
   * Center on a feature instead of dLat/dLon: the deepest lake below 55°
   * latitude, the densely forested cell nearest the main continent, the
   * largest city, or the first main airbase (milestone 5).
   */
  target?: 'lake' | 'forest' | 'city' | 'airbase';
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
    name: 'coast',
    dLat: -30 * DEG,
    dLon: 0,
    altitude: 80 * KM,
    tilt: 45 * DEG,
    heading: 180 * DEG,
    localTime: 10.5,
  },
  {
    name: 'glint',
    dLat: -38 * DEG,
    dLon: 0,
    altitude: 40 * KM,
    tilt: 62 * DEG,
    heading: 250 * DEG,
    localTime: 16.5,
  },
  {
    name: 'sea',
    dLat: -32 * DEG,
    dLon: 1 * DEG,
    altitude: 600,
    tilt: 84 * DEG,
    heading: 250 * DEG,
    localTime: 16.8,
  },
  {
    name: 'shore',
    dLat: -32.6 * DEG,
    dLon: -1.5 * DEG,
    altitude: 900,
    tilt: 60 * DEG,
    heading: 250 * DEG,
    localTime: 14,
  },
  {
    name: 'lake',
    dLat: 0,
    dLon: 0,
    altitude: 30 * KM,
    tilt: 30 * DEG,
    heading: 0,
    localTime: 13,
    target: 'lake',
  },
  {
    name: 'trees',
    dLat: 0,
    dLon: 0,
    altitude: 700,
    tilt: 80 * DEG,
    heading: 0,
    localTime: 15,
    target: 'forest',
  },
  {
    name: 'winter',
    dLat: 0,
    dLon: 0,
    altitude: 1500 * KM,
    tilt: 0,
    heading: 0,
    localTime: 12,
    day: 150,
  },
  {
    name: 'mountains',
    dLat: 12 * DEG,
    dLon: 0,
    altitude: 25 * KM,
    tilt: 65 * DEG,
    heading: 0,
    localTime: 14,
    day: 0,
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
  {
    name: 'town',
    dLat: 0,
    dLon: 0,
    altitude: 3 * KM,
    tilt: 60 * DEG,
    heading: 0,
    localTime: 10,
    target: 'city',
  },
  {
    name: 'airbase',
    dLat: 0,
    dLon: 0,
    altitude: 2 * KM,
    tilt: 55 * DEG,
    heading: 0,
    localTime: 10,
    target: 'airbase',
  },
  {
    name: 'roads',
    dLat: 0,
    dLon: 0,
    altitude: 60 * KM,
    tilt: 0,
    heading: 0,
    localTime: 10,
    target: 'city',
  },
  {
    name: 'night',
    dLat: 0,
    dLon: 0,
    altitude: 1500 * KM,
    tilt: 0,
    heading: 0,
    localTime: 0,
  },
];

/** Draw statistics for PERF lines: visible meshes and triangles per scene group, and layer counts. */
function drawStats(scene: GlobeScene): string {
  const names = new Map<unknown, string>([
    [scene.terrain.group, 'terrain'],
    [scene.forest.group, 'trees'],
    [scene.structures.group, 'buildings'],
    [scene.clouds.group, 'clouds'],
    [scene.strategic.group, 'overlay'],
    [scene.globe.group, 'grid'],
  ]);
  const groups = scene.scene.children
    .map((g) => {
      let n = 0;
      let tris = 0;
      g.traverseVisible((o) => {
        const m = o as unknown as {
          isMesh?: boolean;
          geometry?: { index?: { count: number }; instanceCount?: number };
        };
        if (!m.isMesh) return;
        n++;
        const instances = m.geometry?.instanceCount;
        tris +=
          ((m.geometry?.index?.count ?? 0) / 3) * (Number.isFinite(instances) ? instances! : 1);
      });
      return n ? `${names.get(g) ?? g.type} ${n} draws ${(tris / 1e6).toFixed(2)} M tris` : '';
    })
    .filter(Boolean)
    .join(', ');
  return `${groups}; deepest L${scene.terrain.stats.deepest}, ${scene.forest.stats.instances} tree clumps, ${scene.structures.stats.instances} buildings`;
}

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

  // The campaign world first: the global pass uses the seed that passed the validity check.
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed });
  const params = { ...DEFAULT_PLANET_PARAMS, seed: campaign.seed };
  const { world, global } = await previewWorld(gpu, params, tres, gres);
  const infra = new InfraScene(campaign.graph, campaign.infrastructure, params.radius);

  const head = await headlessRenderer(gpu.device, width, height);
  const scene = new GlobeScene(head.renderer, {
    radius: params.radius,
    grid: new CubeGrid(tres),
    input: false,
  });
  scene.resize(width, height);
  scene.globe.setWorld(world);
  scene.climate.setWorld(world);
  scene.globe.setExaggeration(exaggeration);
  scene.terrain.setExaggeration(exaggeration);
  scene.terrain.buildBudgetMs = 10_000;
  scene.terrain.budgetMiB = 600; // the app's default (GUI → Tile memory)
  const riverIndex = new RiverIndex(global.finish.rivers);
  const synth = new TileSynthesizer(global.grid, {
    seed: params.seed,
    reliefScale: params.reliefScale,
    radius: params.radius,
    biome: global.finish.biome,
    lakeDepth: global.finish.drainage.lakeDepth,
    height: global.height,
    forest: global.finish.forest,
    treeline: global.finish.treeline,
    index: riverIndex,
  });
  scene.terrain.setWorld({
    synth,
    seed: params.seed,
    radius: params.radius,
    reliefScale: params.reliefScale,
    rivers: riverIndex,
    infra,
  });
  scene.setInfrastructure(infra);
  scene.terrainReady = true;

  const main = new Vec3d(...world.info.mainContinent);
  const lat0 = Math.asin(main.y);
  const lon0 = Math.atan2(main.x, main.z);
  const calendar = defaultCampaignStart(main, params);
  // Live weather from the sim (decision 68), replayed to each view's time.
  const climate = buildWeatherClimate(
    { ...world.maps, resolution: world.info.resolution, reliefScale: world.info.reliefScale },
    new WeatherGrid(),
    params.radius,
  );
  const weatherConfig = {
    seed: params.seed,
    radius: params.radius,
    orbit: params,
    calendar,
    climate,
  };
  let simWorld = createSimWorld(weatherConfig);
  const weatherAt = (t: number) => {
    if (t < simWorld.sim.time) simWorld = createSimWorld(weatherConfig);
    simWorld.sim.advanceTo(t);
    const view = simWorld.weather.view();
    scene.weather.setFrames(view);
    scene.weather.update(view, t);
  };

  // Targets: the deepest lake away from the ice caps, and dense forest near the main continent.
  const n = global.n;
  const lakeDepth = global.finish.drainage.lakeDepth;
  const forestMap = global.finish.forest;
  const cellDir = new Vec3d();
  const sp = campaign.graph.settlements;
  let biggest = 0;
  for (let i = 1; i < sp.cells.length; i++)
    if (sp.population[i]! > sp.population[biggest]!) biggest = i;
  const base = campaign.infrastructure.airbases.find((a) => a.kind === 'main');
  const targets: Record<NonNullable<PreviewView['target']>, Vec3d | null> = {
    lake: null,
    forest: null,
    city: sp.cells.length ? new Vec3d(...settlementPoint(sp, biggest)) : null,
    airbase: base ? new Vec3d(...base.point) : null,
  };
  let deepest = 0;
  let nearest = -2;
  for (let c = 0; c < lakeDepth.length; c++) {
    const lakeCandidate = lakeDepth[c]! > deepest;
    const forestCandidate = forestMap[c]! > 220 && global.height[c]! > 30;
    if (!lakeCandidate && !forestCandidate) continue;
    const face = Math.floor(c / (n * n)) as CubeFace;
    cubeFaceUvToDirection(face, ((c % n) + 0.5) / n, ((Math.floor(c / n) % n) + 0.5) / n, cellDir);
    if (lakeCandidate && Math.abs(cellDir.y) < Math.sin(55 * DEG)) {
      deepest = lakeDepth[c]!;
      targets.lake = cellDir.clone();
    }
    if (forestCandidate && cellDir.dot(main) > nearest) {
      nearest = cellDir.dot(main);
      targets.forest = cellDir.clone();
    }
  }
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });

  for (const v of views) {
    const o = scene.orbit;
    const target = v.target ? targets[v.target] : null;
    if (target) {
      // Stand back from the target, south of it, looking north.
      o.lat =
        Math.asin(target.y) - (v.altitude * Math.tan(Math.min(v.tilt, 70 * DEG))) / params.radius;
      o.lon = Math.atan2(target.x, target.z);
    } else {
      o.lat = lat0 + v.dLat;
      o.lon = lon0 + v.dLon;
    }
    o.altitude = o.targetAltitude = v.altitude;
    o.tilt = v.tilt;
    o.heading = v.heading;
    const localAt = (day: number) =>
      withLocalTime(day * DAY, o.lon, (v.localTime ?? 11) * HOUR, params, calendar);
    // The sim starts at campaign start: an early local time on day 0 can fall before it.
    let t = localAt(v.day ?? 0);
    if (t < 0) t = localAt((v.day ?? 0) + 1);
    sunDirection(t, params, calendar, scene.sun);
    scene.terrain.land.seasonPhase.value = seasonPhase(t, params, calendar);
    // HOURS shifts only the clouds' clock (to see them move with the sun held fixed).
    const cloudTime = t + Number(process.env.HOURS ?? 0) * HOUR;
    scene.clouds.time.value = cloudTime;
    weatherAt(cloudTime);
    scene.clouds.enabled.value = process.env.CLOUDS === '0' ? 0 : 1;
    // DETAIL=1 adds the instanced trees and buildings (off in the strategic view, decision 71).
    scene.forest.enabled = scene.structures.enabled = process.env.DETAIL === '1';
    // Render until the terrain has loaded everything this view wants.
    let stable = 0;
    let last = '';
    const t0 = performance.now();
    for (let f = 0; f < 400 && stable < 3; f++) {
      // The camera clamps to 2 km above the highest terrain until the ground under it
      // has loaded; ask for the view's altitude again every frame.
      o.altitude = o.targetAltitude = v.altitude;
      scene.render(0);
      await gpu.finish();
      await new Promise((r) => setTimeout(r, 2));
      const s = scene.terrain.stats;
      const sig = `${s.drawn}/${s.deepest}/${s.meshes}`;
      if (process.env.DEBUG) console.log(v.name, f, JSON.stringify(s), o.tilt, o.altitude);
      const treesPending =
        (scene.forest.group.visible ? scene.forest.stats.pending : 0) +
        (scene.structures.group.visible ? scene.structures.stats.pending : 0);
      stable = s.pending === 0 && treesPending === 0 && sig === last ? stable + 1 : 0;
      last = sig;
    }
    scene.render(0);
    // PERF=n: time n more frames of the loaded view (CPU in scene.render, and until the GPU is done).
    const perfFrames = Number(process.env.PERF ?? 0);
    if (perfFrames > 0) {
      await gpu.finish();
      let cpu = 0;
      const p0 = performance.now();
      const parts: Record<string, number> = {};
      const wrap = (obj: Record<string, unknown>, name: string, label: string) => {
        const fn = obj[name] as (...a: unknown[]) => unknown;
        obj[name] = (...a: unknown[]) => {
          const q0 = performance.now();
          const r = fn.apply(obj, a);
          parts[label] = (parts[label] ?? 0) + performance.now() - q0;
          return r;
        };
        return () => (obj[name] = fn);
      };
      const unwrap = [
        wrap(scene.terrain as unknown as Record<string, unknown>, 'update', 'terrain'),
        wrap(scene.forest as unknown as Record<string, unknown>, 'update', 'forest'),
        wrap(scene.structures as unknown as Record<string, unknown>, 'update', 'buildings'),
        wrap(scene.strategic as unknown as Record<string, unknown>, 'update', 'strategic'),
        wrap(head.renderer as unknown as Record<string, unknown>, 'render', 'three'),
      ];
      const { Session } = await import('node:inspector/promises');
      const session = process.env.PROF ? new Session() : null;
      if (session) {
        session.connect();
        await session.post('Profiler.enable');
        await session.post('Profiler.start');
      }
      for (let f = 0; f < perfFrames; f++) {
        const c0 = performance.now();
        scene.render(0);
        cpu += performance.now() - c0;
        await gpu.finish();
      }
      const wall = (performance.now() - p0) / perfFrames;
      if (session) {
        const { profile } = await session.post('Profiler.stop');
        writeFileSync(process.env.PROF!, JSON.stringify(profile));
        session.disconnect();
      }
      for (const u of unwrap) u();
      const counts: Record<string, number[]> = { river: [], road: [], light: [] };
      scene.terrain.group.traverseVisible((m) => {
        if (!(m as { isMesh?: boolean }).isMesh) return;
        for (const k of ['river', 'road', 'light'])
          counts[k]!.push(m.userData[`${k}Count`] as number);
      });
      console.log(
        '  loops per mesh (mean/max): ' +
          Object.entries(counts)
            .map(
              ([k, c]) =>
                `${k} ${(c.reduce((a, b) => a + b, 0) / Math.max(1, c.length)).toFixed(0)}/${Math.max(0, ...c)}`,
            )
            .join(', '),
      );
      console.log(
        '  CPU parts: ' +
          Object.entries(parts)
            .map(([k, ms]) => `${k} ${(ms / perfFrames).toFixed(1)}`)
            .join(', '),
      );
      console.log(
        `  perf ${v.name}: ${wall.toFixed(1)} ms/frame, CPU ${(cpu / perfFrames).toFixed(1)} ms, ` +
          drawStats(scene),
      );
    }
    const rgb = await head.readRgb();
    const file = join(outDir, `render-${seed}-${v.name}.png`);
    writeFileSync(file, encodePng(width, height, rgb));
    const s = scene.terrain.stats;
    if (process.env.DEBUG) {
      let withRivers = 0;
      let total = 0;
      scene.terrain.group.traverse((m) => {
        if (!m.visible || !(m as { isMesh?: boolean }).isMesh) return;
        total++;
        if ((m.userData.riverCount as number) > 0) withRivers++;
      });
      console.log(`  meshes ${total}, with rivers ${withRivers}`);
    }
    if (scene.structures.stats.instances) {
      console.log(`  buildings: ${scene.structures.stats.instances}`);
    }
    if (scene.forest.stats.instances) {
      console.log(
        `  trees: ${scene.forest.stats.tiles} tiles, ${scene.forest.stats.instances} clumps`,
      );
    }
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
