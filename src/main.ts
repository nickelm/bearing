import './style.css';
import { WebGPURenderer } from 'three/webgpu';
import {
  daysPerYear,
  defaultCampaignStart,
  formatLocalDate,
  localDayOfYear,
  localSolarTime,
  seasonPhase,
  sunDirection,
  withLocalTime,
} from './core/calendar';
import type { CampaignCalendar, OrbitParams } from './core/calendar';
import { CubeGrid } from './core/cubeGrid';
import { rng } from './core/rng';
import { DEG, HOUR, KM } from './core/units';
import { Vec3d } from './core/vec3d';
import { DEFAULT_PLANET_PARAMS } from './worldgen/params';
import type { PlanetParams } from './worldgen/params';
import { GlobeScene } from './render/globeScene';
import { VIEW_MODES } from './render/globeMesh';
import type { ViewMode } from './render/globeMesh';
import { runComputeSmokeTest } from './render/computeSmokeTest';
import {
  isOnWebGpuBackend,
  probeWebGpu,
  rendererDevice,
  showFatalError,
  showWebGpuRequired,
} from './render/webgpuSupport';
import {
  DEFAULT_GLOBAL_RESOLUTION,
  DebugGui,
  GLOBAL_RESOLUTIONS,
  RESOLUTIONS,
} from './ui/debugGui';
import { GpuContext } from './worldgen/gpu/gpuContext';
import { TileSynthesizer } from './worldgen/gpu/tileSynth';
import { RiverIndex } from './worldgen/riverIndex';
import { DEFAULT_LOD } from './render/terrain/quadtree';
import type { TileViewMode } from './render/terrain/tileMesh';
import {
  buildGlobalWorld,
  GlobalPassCancelled,
  restoreGlobalWorld,
} from './worldgen/globalPipeline';
import { GENERATOR_VERSION, WorldStore, worldKey } from './worldgen/worldStore';
import type { World } from './worldgen/pipeline';
import type { GlobalWorld } from './worldgen/globalPipeline';
import { GPU_SELF_TESTS, runSelfTest } from './worldgen/gpu/selfTests';
import type {
  LightingGuiParams,
  TimeGuiParams,
  ViewGuiParams,
  WorldGuiParams,
} from './ui/debugGui';
import { FrameTimeOverlay } from './ui/frameTimeOverlay';
import { PING_STREAM } from './workers/protocol';
import type { FromSimWorker, ToSimWorker } from './workers/protocol';
import { GenerationCancelled, WorldgenClient } from './workers/worldgenClient';

async function main(): Promise<void> {
  const probe = await probeWebGpu();
  if ('problem' in probe) {
    showWebGpuRequired(probe.problem);
    return;
  }

  const container = document.getElementById('app')!;
  const renderer = new WebGPURenderer({ antialias: true, requiredLimits: probe.limits });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  await renderer.init();

  if (!isOnWebGpuBackend(renderer)) {
    // WebGPURenderer fell back to WebGL 2. Bearing does not support that.
    renderer.dispose();
    renderer.domElement.remove();
    showWebGpuRequired('The renderer could not start a WebGPU device and fell back to WebGL 2.');
    return;
  }

  // URL parameters: ?seed=<integer or text>&res=<tectonic cells per face edge>&gres=<global grid>
  const query = new URLSearchParams(location.search);
  const queryRes = Number(query.get('res'));
  const queryGres = Number(query.get('gres'));
  const worldParams: WorldGuiParams = {
    seed: query.get('seed') ?? String(DEFAULT_PLANET_PARAMS.seed),
    resolution: (RESOLUTIONS as readonly number[]).includes(queryRes) ? queryRes : 256,
    globalResolution: (GLOBAL_RESOLUTIONS as readonly number[]).includes(queryGres)
      ? queryGres
      : DEFAULT_GLOBAL_RESOLUTION,
    plateCount: DEFAULT_PLANET_PARAMS.plateCount,
    oceanFraction: DEFAULT_PLANET_PARAMS.oceanFraction,
    reliefScale: Number(DEFAULT_PLANET_PARAMS.reliefScale.toFixed(3)),
    temperatureOffset: DEFAULT_PLANET_PARAMS.temperatureOffset,
    moistureScale: DEFAULT_PLANET_PARAMS.moistureScale,
    erosionStrength: DEFAULT_PLANET_PARAMS.erosionStrength,
  };
  const viewParams: ViewGuiParams = {
    mode: 'biome',
    exaggeration: 10,
    wireframe: false,
    tiles: true,
    geomorph: true,
    sse: DEFAULT_LOD.sseThreshold,
    tileMemory: 600,
    trees: true,
    treeRange: 5,
  };

  // Preview clock until the sim's game clock exists (milestone 6): GameTime and
  // the campaign calendar, which a new world resets (decision 33).
  const orbitParams: OrbitParams = DEFAULT_PLANET_PARAMS;
  let calendar: CampaignCalendar = defaultCampaignStart(new Vec3d(0, 0.6, 0.8), orbitParams);
  let gameTime = 0;
  const timeParams: TimeGuiParams = { day: 0, hours: 0, rate: 0, date: '' };

  let grid = new CubeGrid(worldParams.resolution);
  const globe = new GlobeScene(renderer, { radius: DEFAULT_PLANET_PARAMS.radius, grid });
  globe.globe.setFaceSeed(worldParams.seed);
  globe.globe.setExaggeration(viewParams.exaggeration);
  globe.terrain.setExaggeration(viewParams.exaggeration);
  globe.terrain.budgetMiB = viewParams.tileMemory;

  const worldgen = new WorldgenClient();
  let generation = 0;
  /** The current world's global pass (eroded grid on the GPU, rivers...), once finished. */
  let globalWorld: GlobalWorld | null = null;
  let synth: TileSynthesizer | null = null;
  const store = new WorldStore();
  // Cached worlds are large (about 150 MB at 1024²); ask the browser not to evict them.
  void navigator.storage?.persist?.().catch(() => false);

  const regenerate = async () => {
    const token = ++generation;
    const params: PlanetParams = {
      ...DEFAULT_PLANET_PARAMS,
      seed: worldParams.seed,
      plateCount: worldParams.plateCount,
      oceanFraction: worldParams.oceanFraction,
      reliefScale: worldParams.reliefScale,
      temperatureOffset: worldParams.temperatureOffset,
      moistureScale: worldParams.moistureScale,
      erosionStrength: worldParams.erosionStrength,
    };
    const resolution = worldParams.resolution;
    const globalN = Math.max(worldParams.globalResolution, resolution);
    gui.status.generation = 'starting';
    pingWorker(worldParams.seed);
    const url = new URL(location.href);
    url.searchParams.set('seed', worldParams.seed);
    url.searchParams.set('res', String(resolution));
    url.searchParams.set('gres', String(globalN));
    history.replaceState(null, '', url);
    const t0 = performance.now();
    const status = (stage: string, f: number) => {
      if (token === generation) gui.status.generation = `${stage} (${Math.round(f * 100)}%)`;
    };
    const showTectonic = (world: World) => {
      if (grid.n !== resolution) {
        grid = new CubeGrid(resolution);
        globe.globe.setGrid(grid);
      }
      globe.globe.setFaceSeed(worldParams.seed);
      globe.globe.setWorld(world);
      globe.climate.setWorld(world);
      calendar = defaultCampaignStart(new Vec3d(...world.info.mainContinent), orbitParams);
      gameTime = 0;
    };
    const showGlobal = (world: World, global: GlobalWorld) => {
      // Switch the terrain to the new world first, then free the old one once any
      // tile batch still running on it has finished.
      const old = globalWorld;
      const oldSynth = synth;
      const riverIndex = new RiverIndex(global.finish.rivers);
      synth = new TileSynthesizer(global.grid, {
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
      globe.terrain.setWorld({
        synth,
        seed: params.seed,
        radius: params.radius,
        reliefScale: params.reliefScale,
        rivers: riverIndex,
      });
      globe.terrainReady = true;
      if (old || oldSynth) {
        setTimeout(() => {
          oldSynth?.dispose();
          old?.grid.dispose();
        }, 3000);
      }
      globalWorld = global;
      const d = global.finish.display;
      let maxHeight = -Infinity;
      for (const h of d.height) maxHeight = Math.max(maxHeight, h);
      globe.globe.setWorld({
        maps: {
          ...world.maps,
          height: d.height,
          biome: d.biome,
          discharge: d.discharge,
          lakeDepth: d.lakeDepth,
        },
        info: { ...world.info, maxHeight },
      });
    };
    const key = worldKey(params, resolution, globalN);
    try {
      // 0. A world generated before with the same parameters loads from IndexedDB.
      const stored = await store.load(key).catch((err: unknown) => {
        console.warn('World cache unavailable', err);
        return null;
      });
      if (token !== generation) return;
      if (stored) {
        showTectonic(stored.tectonic);
        showGlobal(stored.tectonic, restoreGlobalWorld(gpu, stored.global));
        gui.status.generation = `cached (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
        return;
      }

      // 1. Tectonic pass in the worker, shown at once as a preview.
      const world = await worldgen.generate(params, resolution, status);
      if (token !== generation) return;
      showTectonic(world);
      console.info(
        `World ${worldParams.seed} @ ${resolution}: land ${(world.info.landFraction * 100).toFixed(1)}%, ` +
          `heights ${world.info.minHeight.toFixed(0)}..${world.info.maxHeight.toFixed(0)} m, ` +
          `${world.info.landmassCount} landmasses, largest ${(world.info.largestLandmassArea / 1e6).toFixed(0)} km²`,
      );
      console.table(world.info.timings.map((t) => ({ stage: t.stage, ms: Math.round(t.ms) })));

      // 2. Global pass: GPU detail and erosion here, drainage and rivers in the worker.
      const global = await buildGlobalWorld(gpu, params, world, {
        n: globalN,
        finish: (input) => worldgen.finish(input),
        onProgress: (stage, f) => status(`global ${globalN}: ${stage}`, f),
        cancelled: () => token !== generation,
      });
      if (token !== generation) {
        global.grid.dispose();
        return;
      }
      showGlobal(world, global);
      const total = performance.now() - t0;
      gui.status.generation = `done in ${(total / 1000).toFixed(1)} s`;
      console.info(
        `Global ${globalN}: ${global.finish.rivers.count} river polylines, ` +
          `GPU maps ${(global.grid.peakBytes / 2 ** 20).toFixed(0)} MiB`,
      );
      console.table(
        [...global.timings, ...global.finish.timings].map((t) => ({
          stage: t.stage,
          ms: Math.round(t.ms),
        })),
      );

      // 3. Cache it, so this world loads instantly next time.
      store
        .save({
          key,
          version: GENERATOR_VERSION,
          savedAt: Date.now(),
          tectonic: world,
          global: {
            n: global.n,
            height: global.height,
            uplift: global.uplift,
            finish: global.finish,
          },
        })
        .catch((err: unknown) => console.warn('Could not cache the world', err));
    } catch (err) {
      if (token !== generation) return;
      if (err instanceof GenerationCancelled || err instanceof GlobalPassCancelled) {
        gui.status.generation = 'cancelled';
      } else {
        gui.status.generation = 'error (see console)';
        console.error(err);
      }
    }
  };

  /** "Color by" modes the tiles can show, and the tile coloring each maps to. */
  const TILE_MODE_FOR: Record<string, TileViewMode> = {
    biome: 'biome',
    rivers: 'biome',
    height: 'height',
    'tile level': 'level',
    'tile borders': 'borders',
    forest: 'forest',
  };
  const COLOR_MODES = [...VIEW_MODES, 'forest', 'tile level', 'tile borders'];
  let tilesBlocked = false;
  const gui = new DebugGui(worldParams, viewParams, COLOR_MODES, {
    regenerate: () => void regenerate(),
    clearCache: () => {
      store
        .clear()
        .then(() => (gui.status.generation = 'world cache cleared'))
        .catch((err: unknown) => console.warn('Could not clear the world cache', err));
    },
    cancel: () => {
      generation++;
      worldgen.cancel();
      gui.status.generation = 'cancelled';
    },
    viewChanged: (v) => {
      // One "Color by" list for both renderers: modes the tiles cannot show
      // (they need tectonic-grid maps) switch the display to the grid mesh.
      const tileMode = TILE_MODE_FOR[v.mode];
      tilesBlocked = tileMode === undefined;
      globe.globe.setViewMode(
        ((VIEW_MODES as readonly string[]).includes(v.mode) ? v.mode : 'biome') as ViewMode,
      );
      globe.globe.wireframe = v.wireframe;
      globe.useTiles = v.tiles && !tilesBlocked;
      if (tileMode) globe.terrain.setMode(tileMode);
      globe.terrain.geomorph = v.geomorph;
      globe.terrain.lod.sseThreshold = v.sse;
      globe.terrain.budgetMiB = v.tileMemory;
      globe.forest.enabled = v.trees;
      globe.forest.range.value = v.treeRange * KM;
    },
    shapeChanged: (v) => {
      globe.globe.setExaggeration(v.exaggeration);
      globe.terrain.setExaggeration(v.exaggeration);
    },
  });
  gui.status.backend = 'WebGPU';
  gui.addTimeControls(timeParams, daysPerYear(orbitParams), {
    dayChanged: (d) => {
      const lon = globe.orbit.lon;
      gameTime += (d - localDayOfYear(gameTime, lon, orbitParams, calendar)) * orbitParams.solarDay;
    },
    hoursChanged: (h) => {
      gameTime = withLocalTime(gameTime, globe.orbit.lon, h * HOUR, orbitParams, calendar);
    },
  });
  const lighting = globe.lighting;
  const lightParams: LightingGuiParams = {
    atmosphere: true,
    airDensity: lighting.atmosphere.params.density,
    exposure: renderer.toneMappingExposure,
    skyLight: lighting.skyLight.value,
    nightLight: lighting.nightLight.value,
    waves: globe.terrain.water.waveStrength.value,
    foam: globe.terrain.water.foamStrength.value,
    temperatureShift: 0,
    detail: globe.terrain.land.detail.value,
    riverLegibility: globe.terrain.riverStyle.legibility.value,
  };
  gui.addLightingControls(lightParams, (l) => {
    lighting.atmosphere.enabled.value = l.atmosphere ? 1 : 0;
    if (l.airDensity !== lighting.atmosphere.params.density) {
      lighting.atmosphere.setDensity(l.airDensity);
    }
    renderer.toneMappingExposure = l.exposure;
    lighting.skyLight.value = l.skyLight;
    lighting.nightLight.value = l.nightLight;
    globe.terrain.water.waveStrength.value = l.waves;
    globe.terrain.water.foamStrength.value = l.foam;
    globe.terrain.land.temperatureOffset.value = l.temperatureShift;
    globe.terrain.land.detail.value = l.detail;
    globe.terrain.riverStyle.legibility.value = l.riverLegibility;
  });

  // World-generation compute shares three's device (decision 22).
  const gpu = new GpuContext(rendererDevice(renderer));
  gui.addSelfTests(
    GPU_SELF_TESTS.map((t) => t.name),
    async (report) => {
      for (const t of GPU_SELF_TESTS) {
        report(t.name, 'running');
        const failure = await runSelfTest(gpu, t);
        report(t.name, failure ?? 'ok');
        if (failure) console.error(`GPU self-test "${t.name}" failed: ${failure}`);
      }
    },
  );

  const overlay = new FrameTimeOverlay();

  // Sim worker stub: confirms bundling and cross-context determinism.
  const simWorker = new Worker(new URL('./workers/sim.worker.ts', import.meta.url), {
    type: 'module',
  });
  let expected = 0;
  const pingWorker = (seed: string) => {
    expected = rng(seed, PING_STREAM).nextUint32();
    gui.status.worker = 'pending';
    simWorker.postMessage({ type: 'ping', seed } satisfies ToSimWorker);
  };
  simWorker.onmessage = (e: MessageEvent<FromSimWorker>) => {
    const ok = e.data.value === expected;
    gui.status.worker = ok ? 'ok (deterministic)' : 'MISMATCH';
    if (!ok) console.error('Sim worker RNG mismatch', e.data.value, expected);
  };
  simWorker.onerror = (e) => {
    gui.status.worker = 'error';
    console.error('Sim worker error', e);
  };

  runComputeSmokeTest(renderer)
    .then((ok) => (gui.status.compute = ok ? 'ok' : 'WRONG RESULT'))
    .catch((err: unknown) => {
      gui.status.compute = 'error';
      console.error('GPU compute smoke test failed', err);
    });

  const onResize = () => globe.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);
  onResize();

  void regenerate();

  let last = performance.now();
  await renderer.setAnimationLoop((now) => {
    const frameMs = now - last;
    last = now;
    overlay.record(frameMs, now);
    const dt = Math.min(frameMs, 100) / 1000;
    gameTime += dt * timeParams.rate;
    sunDirection(gameTime, orbitParams, calendar, globe.sun);
    globe.terrain.land.seasonPhase.value = seasonPhase(gameTime, orbitParams, calendar);
    globe.render(dt);

    const lon = globe.orbit.lon;
    timeParams.day = localDayOfYear(gameTime, lon, orbitParams, calendar);
    timeParams.hours = localSolarTime(gameTime, lon, orbitParams, calendar) / HOUR;
    timeParams.date = formatLocalDate(gameTime, lon, orbitParams, calendar);

    const o = globe.orbit;
    gui.status.altitudeKm = o.altitude / KM;
    gui.status.latDeg = o.lat / DEG;
    gui.status.lonDeg = o.lon / DEG;
    gui.status.tiltDeg = o.tilt / DEG;
    const ts = globe.terrain.stats;
    const fs = globe.forest.stats;
    gui.status.trees = globe.forest.group.visible
      ? `${fs.instances} clumps in ${fs.tiles} tiles${fs.pending ? `, ${fs.pending} loading` : ''}`
      : 'off (shown below 8 km)';
    gui.status.tiles = !globe.terrainReady
      ? 'waiting for the global pass'
      : tilesBlocked && viewParams.tiles
        ? 'off: this color mode needs the grid'
        : globe.useTiles
          ? `${ts.drawn} drawn, L${ts.deepest} deepest, ${ts.meshes} meshes, ${ts.dataTiles} data, ${ts.pending} loading`
          : 'off';
  });
}

main().catch((err: unknown) => {
  console.error(err);
  showFatalError(String(err));
});
