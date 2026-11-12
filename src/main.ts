import './style.css';
import { Vector2, WebGPURenderer } from 'three/webgpu';
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
import { DEG, HOUR, KM } from './core/units';
import { latLonToDirection } from './core/coords';
import { Vec3d } from './core/vec3d';
import { DEFAULT_PLANET_PARAMS } from './worldgen/params';
import type { PlanetParams } from './worldgen/params';
import { GlobeScene } from './render/sim/globeScene';
import { StrategicScene } from './render/strategic/strategicScene';
import { OVERLAY_LAYERS } from './render/strategic/overlays/militaryModel';
import { INFRA_LAYERS } from './render/strategic/infra/infraModel';
import { InfraScene } from './render/sim/infra/infraScene';
import { airfieldGrading, globalMapSampler } from './render/sim/infra/airfieldGrading';
import { observerStations } from './render/sim/camera/observerStations';
import type { ObserverStation } from './render/sim/camera/observerStations';
import { VIEW_MODES } from './render/common/globeMesh';
import type { ViewMode } from './render/common/globeMesh';
import { runComputeSmokeTest } from './render/common/computeSmokeTest';
import { RenderScaleController } from './render/common/renderScale';
import {
  describeAdapter,
  isOnWebGpuBackend,
  probeWebGpu,
  requestRendererDevice,
  rendererDevice,
  showFatalError,
  showWebGpuRequired,
} from './render/common/webgpuSupport';
import {
  DEFAULT_GLOBAL_RESOLUTION,
  DebugGui,
  GLOBAL_RESOLUTIONS,
  RESOLUTIONS,
} from './ui/debugGui';
import { GpuContext } from './worldgen/gpu/gpuContext';
import { TileSynthesizer } from './worldgen/gpu/tileSynth';
import { RiverIndex } from './worldgen/riverIndex';
import { DEFAULT_LOD } from './render/common/terrain/quadtree';
import type { TileViewMode } from './render/common/terrain/tileMesh';
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
  CampaignGuiParams,
  DebugGuiCallbacks,
  LightingGuiParams,
  MapGuiParams,
  TimeGuiParams,
  ViewGuiParams,
  WorldGuiParams,
} from './ui/debugGui';
import { FrameTimeOverlay } from './ui/frameTimeOverlay';
import { BuildStamp } from './ui/buildStamp';
import { CampaignPanel } from './ui/campaignPanel';
import { SeedBrowser } from './ui/seedBrowser';
import { THEATER_LABELS } from './campaign/theaters';
import type { StrategicWorld } from './worldgen/campaignWorld';
import { SimClient } from './workers/simClient';
import { SnapshotField } from './workers/protocol';
import { buildWeatherClimate } from './sim/weather/climate';
import { WeatherGrid } from './sim/weather/grid';
import { TimeControls } from './ui/timeControls';
import { GenerationCancelled, WorldgenClient } from './workers/worldgenClient';
import { fetchLabelFonts } from './render/strategic/labels/fonts';
import { buildFontAtlas } from './render/strategic/labels/fontAtlas';

async function main(): Promise<void> {
  // First, so the deployed version shows even if WebGPU is missing.
  new BuildStamp(__BUILD_COMMIT__, __BUILD_TIME__);
  const probe = await probeWebGpu();
  if ('problem' in probe) {
    showWebGpuRequired(probe.problem);
    return;
  }

  const container = document.getElementById('app')!;
  // The device comes from the high-performance adapter the probe found (decision 69).
  const device = await requestRendererDevice(probe.adapter, probe.limits);
  // Reversed depth: the observer camera needs a near plane under a meter with the
  // horizon 200 km away (decision 112).
  const renderer = new WebGPURenderer({ antialias: true, device, reversedDepthBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  await renderer.init();
  // Adaptive resolution (decision 69): the canvas backing store follows the frame time.
  const renderScale = new RenderScaleController();
  const applyRenderScale = (scale: number, now: number) => {
    renderScale.set(scale, now);
    renderer.setPixelRatio(window.devicePixelRatio * renderScale.scale);
    onResize();
  };

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
    // Individual trees and buildings are simulator detail (decision 71).
    trees: false,
    treeRange: 5,
    // On: the simulation view is a ground view now (the observer camera, decision 112).
    buildings: true,
    ink: true,
    inkWidth: 1.6,
    nightLights: 3,
    renderScale: 'auto',
    targetFps: 30,
    scene: query.get('view') === 'strategic' ? 'strategic' : 'simulation',
    simCamera: 'observer',
    station: '',
  };
  // The free camera is a development tool until V4 (decision 72): on the dev server, or with ?dev.
  const devCamera = import.meta.env.DEV || query.has('dev');

  // The game clock lives in the sim worker (decision 67); the display time follows it.
  // A new world resets the campaign calendar (decision 33) and restarts the sim.
  const orbitParams: OrbitParams = DEFAULT_PLANET_PARAMS;
  let calendar: CampaignCalendar = defaultCampaignStart(new Vec3d(0, 0.6, 0.8), orbitParams);
  let gameTime = 0;
  const timeParams: TimeGuiParams = {
    day: 0,
    hours: 0,
    date: '',
    autoSlowdown: true,
    alarmHours: 1,
    sim: 'no world yet',
    weather: '—',
  };
  const sim = new SimClient();
  const weatherGrid = new WeatherGrid();
  /** Starts the simulation for a world: its climate drives the weather (decision 68). */
  const startSim = (world: World, seed: string, radius: number) => {
    const climate = buildWeatherClimate(
      { ...world.maps, resolution: world.info.resolution, reliefScale: world.info.reliefScale },
      weatherGrid,
      radius,
    );
    sim.init(seed, radius, orbitParams, calendar, climate);
  };
  sim.onWeather = () => globe.weather.setFrames(sim.weather);

  let grid = new CubeGrid(worldParams.resolution);
  const globe = new GlobeScene(renderer, { radius: DEFAULT_PLANET_PARAMS.radius, grid });
  globe.globe.setFaceSeed(worldParams.seed);
  globe.globe.setExaggeration(viewParams.exaggeration);
  globe.terrain.setExaggeration(viewParams.exaggeration);
  globe.terrain.budgetMiB = viewParams.tileMemory;
  // The strategic view (decision 72): its own scene and camera, resident beside the
  // simulation view; only the active view renders and takes input (decision 74).
  const strategicView = new StrategicScene(renderer, {
    radius: DEFAULT_PLANET_PARAMS.radius,
    grid,
    input: false,
    // The map's clouds come from the simulation view's cloud field (decision 89).
    weather: globe.clouds,
  });
  strategicView.setFaceSeed(worldParams.seed);
  // Label fonts load in the background; the map draws names once the atlas exists (decision 98).
  void fetchLabelFonts()
    .then((fonts) => {
      const t0 = performance.now();
      strategicView.setLabelFonts(buildFontAtlas(fonts));
      console.info(`Label atlas: ${(performance.now() - t0).toFixed(0)} ms`);
    })
    .catch((e: unknown) => console.warn('Label fonts failed to load; the map has no names.', e));
  strategicView.bands.onChange((band, previous) =>
    console.info(`Zoom band: ${previous} → ${band}`),
  );
  let activeView: 'simulation' | 'strategic' = 'simulation';
  /** The camera of the view on screen; the clock and status read their position from it. */
  const activeOrbit = () =>
    activeView === 'strategic'
      ? strategicView.orbit
      : globe.cameraMode === 'observer'
        ? globe.observer
        : globe.orbit;
  const setActiveView = (view: 'simulation' | 'strategic') => {
    if (view === activeView) return;
    // Keep the place: the new view's camera starts over the same point, with the same heading.
    // The observer stays at its station (it is entered through the station, decision 72).
    const from = activeOrbit();
    activeView = view;
    const to = activeView === 'strategic' ? strategicView.orbit : globe.orbit;
    if (to !== globe.orbit || globe.cameraMode === 'free') {
      to.lat = from.lat;
      to.lon = from.lon;
      to.heading = from.heading;
    }
    globe.inputEnabled = view === 'simulation';
    strategicView.inputEnabled = view === 'strategic';
  };

  /** Observer stations of the current world (airbases and ports, decision 112). */
  let stations: ObserverStation[] = [];
  /**
   * Puts the simulation view's camera where the GUI says: the observer at the chosen
   * station, or the free camera (dev flag). Without stations (no world yet) the free
   * camera shows the globe while it generates.
   */
  const applyCamera = () => {
    const station = stations.find((x) => x.label === viewParams.station) ?? stations[0] ?? null;
    const observer = station !== null && (viewParams.simCamera === 'observer' || !devCamera);
    if (observer && globe.observer.station?.key !== station.key) globe.observer.setStation(station);
    globe.cameraMode = observer ? 'observer' : 'free';
  };

  const campaignParams: CampaignGuiParams = {
    overlay: true,
    // Off by default: the panel covers much of the screen (GUI → Campaign → Briefing).
    briefing: false,
    seedUsed: '—',
    theaters: '—',
    rangeFactor: 0,
    airbases: '—',
    coarseSeconds: 0,
  };
  const campaignPanel = new CampaignPanel();
  const showStrategic = (s: StrategicWorld | null) => {
    globe.strategic.setWorld(s?.graph ?? null, s?.campaign.cast ?? null, s?.infrastructure ?? null);
    strategicView.setStrategic(
      s?.graph ?? null,
      s?.campaign.cast ?? null,
      s?.infrastructure ?? null,
    );
    if (!s) {
      campaignPanel.visible = false;
      campaignParams.seedUsed = '—';
      campaignParams.theaters = '—';
      return;
    }
    const cast = s.campaign.cast;
    campaignPanel.show(String(s.seed), s.retries, cast);
    campaignPanel.visible = campaignParams.briefing;
    campaignParams.seedUsed =
      s.retries > 0 ? `${String(s.seed)} (retry ${s.retries})` : String(s.seed);
    campaignParams.theaters = cast.theaters.map((t) => THEATER_LABELS[t.kind]).join(', ') || 'none';
    campaignParams.rangeFactor = cast.rangeFactor;
    campaignParams.airbases = `${cast.airbases.alliance} / ${cast.airbases.pact}`;
    const total = s.timings.find((t) => t.stage === 'coarse pass total');
    campaignParams.coarseSeconds = total ? total.ms / 1000 : 0;
    if (!s.campaign.validity.valid) {
      console.warn(
        `World ${String(s.seed)} failed the validity check:`,
        s.campaign.validity.reasons,
      );
    }
  };

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
        strategicView.setGrid(grid);
      }
      globe.globe.setFaceSeed(worldParams.seed);
      globe.globe.setWorld(world);
      strategicView.setFaceSeed(worldParams.seed);
      // Label fonts load in the background; the map draws names once the atlas exists (decision 98).
      void fetchLabelFonts()
        .then((fonts) => {
          const t0 = performance.now();
          strategicView.setLabelFonts(buildFontAtlas(fonts));
          console.info(`Label atlas: ${(performance.now() - t0).toFixed(0)} ms`);
        })
        .catch((e: unknown) =>
          console.warn('Label fonts failed to load; the map has no names.', e),
        );
      strategicView.setWorld(world);
      globe.climate.setWorld(world);
      calendar = defaultCampaignStart(new Vec3d(...world.info.mainContinent), orbitParams);
      gameTime = 0;
      globe.weather.fill(0);
    };
    const showGlobal = (
      world: World,
      global: GlobalWorld,
      params: PlanetParams,
      strategic: StrategicWorld,
    ) => {
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
      // Roads, airfields, lights and buildings from the coarse pass (decision 65).
      const infra = new InfraScene(strategic.graph, strategic.infrastructure, params.radius);
      globe.terrain.setWorld({
        synth,
        seed: params.seed,
        radius: params.radius,
        reliefScale: params.reliefScale,
        rivers: riverIndex,
        infra,
        // Airfields graded flat into the terrain (V3).
        grading: airfieldGrading(infra, global.height, global.n),
      });
      globe.setInfrastructure(infra);
      globe.terrainReady = true;
      // Observer stations at every airbase and port; ports face the sea (decision 112).
      stations = observerStations(
        strategic.infrastructure,
        params.radius,
        globalMapSampler(global.height, global.n),
      );
      gui.setStations(stations.map((x) => x.label));
      globe.observer.station = null;
      applyCamera();
      // The map's relief mesh draws from the same synthesizer (decision 77).
      strategicView.setTerrainWorld({
        synth,
        seed: params.seed,
        radius: params.radius,
        reliefScale: params.reliefScale,
        biome: global.finish.biome,
        biomeResolution: global.n,
        height: global.height,
        rivers: riverIndex,
      });
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
      const display: World = {
        maps: {
          ...world.maps,
          height: d.height,
          biome: d.biome,
          discharge: d.discharge,
          lakeDepth: d.lakeDepth,
        },
        info: { ...world.info, maxHeight },
      };
      globe.globe.setWorld(display);
      strategicView.setWorld(display);
    };
    showStrategic(null);
    const key = worldKey(params, resolution, globalN);
    try {
      // 0. A world generated before with the same parameters loads from IndexedDB.
      const stored = await store.load(key).catch((err: unknown) => {
        console.warn('World cache unavailable', err);
        return null;
      });
      if (token !== generation) return;
      if (stored?.strategic) {
        showTectonic(stored.tectonic);
        showStrategic(stored.strategic);
        startSim(stored.tectonic, String(stored.strategic.seed), params.radius);
        showGlobal(
          stored.tectonic,
          restoreGlobalWorld(gpu, stored.global),
          { ...params, seed: stored.strategic.seed },
          stored.strategic,
        );
        gui.status.generation = `cached (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
        return;
      }

      // 1. Coarse pass (graph, theaters, casting, validity retries) and the tectonic
      // world in the worker, shown at once as a preview.
      const generated = await worldgen.generate(params, resolution, status);
      if (token !== generation) return;
      const { strategic, ...world } = generated;
      showTectonic(world);
      showStrategic(strategic);
      startSim(world, String(strategic.seed), params.radius);
      // Everything after this uses the seed that passed the validity check.
      const worldSeedParams: PlanetParams = { ...params, seed: strategic.seed };
      console.table(strategic.timings.map((t) => ({ stage: t.stage, ms: Math.round(t.ms) })));
      console.info(
        `World ${worldParams.seed} @ ${resolution}: land ${(world.info.landFraction * 100).toFixed(1)}%, ` +
          `heights ${world.info.minHeight.toFixed(0)}..${world.info.maxHeight.toFixed(0)} m, ` +
          `${world.info.landmassCount} landmasses, largest ${(world.info.largestLandmassArea / 1e6).toFixed(0)} km²`,
      );
      console.table(world.info.timings.map((t) => ({ stage: t.stage, ms: Math.round(t.ms) })));

      // 2. Global pass: GPU detail and erosion here, drainage and rivers in the worker.
      const global = await buildGlobalWorld(gpu, worldSeedParams, world, {
        n: globalN,
        finish: (input) => worldgen.finish(input),
        onProgress: (stage, f) => status(`global ${globalN}: ${stage}`, f),
        cancelled: () => token !== generation,
      });
      if (token !== generation) {
        global.grid.dispose();
        return;
      }
      showGlobal(world, global, worldSeedParams, strategic);
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
          strategic,
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
  const guiCallbacks: DebugGuiCallbacks = {
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
      const gridMode = (
        (VIEW_MODES as readonly string[]).includes(v.mode) ? v.mode : 'biome'
      ) as ViewMode;
      globe.globe.setViewMode(gridMode);
      strategicView.setViewMode(gridMode);
      setActiveView(v.scene);
      globe.globe.wireframe = v.wireframe;
      globe.useTiles = v.tiles && !tilesBlocked;
      strategicView.useTiles = v.tiles && !tilesBlocked;
      if (tileMode) {
        globe.terrain.setMode(tileMode);
        strategicView.relief.setMode(tileMode);
      }
      globe.terrain.geomorph = v.geomorph;
      globe.terrain.lod.sseThreshold = v.sse;
      globe.terrain.budgetMiB = v.tileMemory;
      globe.forest.enabled = v.trees;
      globe.forest.range.value = v.treeRange * KM;
      globe.structures.enabled = v.buildings;
      globe.structures.ink = v.ink;
      globe.structures.setInk(v.inkWidth, 0);
      globe.structures.lightBrightness.value = v.nightLights;
      renderScale.targetMs = 1000 / v.targetFps;
      const fixed = RenderScaleController.fixed(v.renderScale);
      applyRenderScale(fixed ?? renderScale.scale, performance.now());
    },
    shapeChanged: (v) => {
      globe.globe.setExaggeration(v.exaggeration);
      globe.terrain.setExaggeration(v.exaggeration);
    },
    cameraChanged: () => applyCamera(),
  };
  const gui = new DebugGui(worldParams, viewParams, COLOR_MODES, guiCallbacks, { devCamera });
  setActiveView(viewParams.scene); // ?view=strategic opens the map
  gui.status.backend = `WebGPU on ${describeAdapter(probe.adapter)}`;
  console.info(`WebGPU adapter: ${describeAdapter(probe.adapter)}`, probe.adapter.info);
  // Seed browser: its own worker, so scanning does not cancel the displayed world.
  const scanner = new WorldgenClient();
  const seedBrowser = new SeedBrowser((seed) => {
    worldParams.seed = seed;
    gui.refresh();
    void regenerate();
  });
  let nextScanSeed: bigint | null = null;
  gui.addCampaign(
    campaignParams,
    (c) => {
      globe.strategic.enabled = c.overlay;
      campaignPanel.visible = c.briefing && campaignParams.seedUsed !== '—';
    },
    {
      scan: (count) => {
        // Numeric seeds continue from the current one; text seeds start at 1.
        const current = /^\d+$/.test(worldParams.seed.trim())
          ? BigInt(worldParams.seed.trim())
          : 0n;
        const from = nextScanSeed ?? current + 1n;
        const seeds = Array.from({ length: count }, (_, i) => String(from + BigInt(i)));
        nextScanSeed = from + BigInt(count);
        seedBrowser.visible = true;
        seedBrowser.status(`scanning ${seeds[0]}–${seeds[seeds.length - 1]}…`);
        const params = {
          ...DEFAULT_PLANET_PARAMS,
          plateCount: worldParams.plateCount,
          oceanFraction: worldParams.oceanFraction,
          reliefScale: worldParams.reliefScale,
          temperatureOffset: worldParams.temperatureOffset,
          moistureScale: worldParams.moistureScale,
          erosionStrength: worldParams.erosionStrength,
        };
        scanner
          .scan(params, seeds, (row) => seedBrowser.add(row))
          .then(() => seedBrowser.status('click a row to load that seed'))
          .catch((err: unknown) => {
            if (!(err instanceof GenerationCancelled)) console.error(err);
            seedBrowser.status('stopped');
          });
      },
      stop: () => scanner.cancel(),
    },
  );
  gui.addTimeControls(timeParams, daysPerYear(orbitParams), {
    dayChanged: (d) => {
      const lon = activeOrbit().lon;
      const days = d - localDayOfYear(gameTime, lon, orbitParams, calendar);
      sim.seek(gameTime + days * orbitParams.solarDay);
    },
    hoursChanged: (h) => {
      sim.seek(withLocalTime(gameTime, activeOrbit().lon, h * HOUR, orbitParams, calendar));
    },
    autoSlowdownChanged: (enabled) => sim.setAutoSlowdown(enabled),
    alarm: (hours) => {
      const at = gameTime + hours * HOUR;
      sim.alarm(
        at,
        `Test alarm (${formatLocalDate(at, activeOrbit().lon, orbitParams, calendar)})`,
      );
    },
  });
  const timeControls = new TimeControls((rate) => sim.setRate(rate));
  sim.onFlagged = (n) => {
    const labels = n.events.map((e) => e.label).join(', ');
    timeControls.notify(n.slowed ? `Slowed to 1×: ${labels}` : labels);
  };
  const relief = strategicView.relief;
  const mapParams: MapGuiParams = {
    exaggeration: relief.exaggeration.value,
    hillshade: relief.hillshadeStrength.value,
    lightElevation: Math.round(relief.hillshadeElevation.value / DEG),
    ambient: relief.ambient.value,
    patterns: true,
    night: 1,
    twilight: 1,
    seasons: true,
    weather: true,
    cloudOpacity: 1,
    graticule: false,
    rangeRings: true,
    finish: 1,
    glyphs: true,
    labels: true,
    territory: true,
    territoryOpacity: relief.territoryOpacity.value,
    front: true,
    defense: true,
    corridors: true,
    lanes: true,
    chokepoints: true,
    graphDebug: false,
    towns: true,
    roads: true,
    railways: true,
    sites: true,
  };
  gui.addMapControls(mapParams, (m) => {
    // The relief applies exaggeration in its shader; the fallback grid globe rebuilds.
    if (m.exaggeration !== relief.exaggeration.value) {
      relief.exaggeration.value = m.exaggeration;
      strategicView.globe.setExaggeration(m.exaggeration);
    }
    relief.hillshadeStrength.value = m.hillshade;
    relief.hillshadeElevation.value = m.lightElevation * DEG;
    relief.ambient.value = m.ambient;
    relief.patterns.value = m.patterns ? 1 : 0;
    relief.nightStrength.value = m.night;
    relief.twilightStrength.value = m.twilight;
    relief.seasons.value = m.seasons ? 1 : 0;
    relief.weatherOn.value = m.weather ? 1 : 0;
    relief.cloudOpacity.value = m.cloudOpacity;
    strategicView.showGraticule = m.graticule;
    strategicView.showRings = m.rangeRings;
    strategicView.showGlyphs = m.glyphs;
    strategicView.showLabels = m.labels;
    strategicView.showTerritory = m.territory;
    relief.territoryOpacity.value = m.territoryOpacity;
    for (const layer of OVERLAY_LAYERS) strategicView.setLayerVisible(layer, m[layer]);
    strategicView.overlay.enabled = m.graphDebug;
    strategicView.showTowns = m.towns;
    for (const layer of INFRA_LAYERS) strategicView.setInfraVisible(layer, m[layer]);
    relief.finish.value = m.finish;
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
    roads: true,
    roadLegibility: globe.terrain.roadStyle.legibility.value,
    nightLights: globe.terrain.roadStyle.lights.value,
    clouds: true,
    cloudCover: 0,
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
    globe.terrain.roadStyle.enabled.value = l.roads ? 1 : 0;
    globe.terrain.roadStyle.legibility.value = l.roadLegibility;
    globe.terrain.roadStyle.lights.value = l.nightLights;
    globe.clouds.enabled.value = l.clouds ? 1 : 0;
    globe.clouds.coverageBias.value = l.cloudCover;
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

  sim.onStatus = (status) => (gui.status.worker = status);
  const pingWorker = (seed: string) => sim.ping(seed);

  runComputeSmokeTest(renderer)
    .then((ok) => (gui.status.compute = ok ? 'ok' : 'WRONG RESULT'))
    .catch((err: unknown) => {
      gui.status.compute = 'error';
      console.error('GPU compute smoke test failed', err);
    });

  const onResize = () => {
    globe.resize(window.innerWidth, window.innerHeight);
    strategicView.resize(window.innerWidth, window.innerHeight);
    const size = renderer.getDrawingBufferSize(new Vector2());
    gui.status.resolution = `${size.x}×${size.y} (${Math.round(renderScale.scale * 100)}% of ${window.devicePixelRatio}×)`;
  };
  window.addEventListener('resize', onResize);
  onResize();
  // Apply the View folder's starting values (once onResize exists): before this, the
  // scene kept its own defaults, buildings off, until a View control changed.
  guiCallbacks.viewChanged(viewParams);

  void regenerate();

  let last = performance.now();
  let lastClockText = 0;
  const here = new Vec3d();
  await renderer.setAnimationLoop((now) => {
    const frameMs = now - last;
    last = now;
    overlay.record(frameMs, now);
    if (viewParams.renderScale === 'auto') {
      const scale = renderScale.record(frameMs, now);
      if (scale !== null) applyRenderScale(scale, now);
    }
    const dt = Math.min(frameMs, 100) / 1000;
    gameTime = sim.displayTime(now);
    sunDirection(gameTime, orbitParams, calendar, globe.sun);
    globe.terrain.land.seasonPhase.value = seasonPhase(gameTime, orbitParams, calendar);
    // The map shares the sun and the season (decision 87).
    strategicView.sun.copy(globe.sun);
    strategicView.relief.seasonPhase.value = globe.terrain.land.seasonPhase.value;
    globe.clouds.time.value = gameTime;
    globe.weather.update(sim.weather, gameTime);
    if (activeView === 'strategic') strategicView.render(dt);
    else globe.render(dt);

    const lon = activeOrbit().lon;
    timeParams.day = localDayOfYear(gameTime, lon, orbitParams, calendar);
    timeParams.hours = localSolarTime(gameTime, lon, orbitParams, calendar) / HOUR;
    timeParams.date = formatLocalDate(gameTime, lon, orbitParams, calendar);
    if (now - lastClockText > 200) {
      lastClockText = now;
      latLonToDirection(activeOrbit().lat, activeOrbit().lon, here);
      const weather = describeWeather(sim, here, gameTime);
      timeParams.weather = weather;
      timeParams.sim = describeSim(sim);
      timeControls.update({
        rate: sim.rate,
        local: `${timeParams.date} local`,
        campaign: `T+${campaignClock(gameTime, orbitParams.solarDay)}`,
        weather,
      });
    }

    const o = activeOrbit();
    gui.status.altitudeKm = o.altitude / KM;
    gui.status.latDeg = o.lat / DEG;
    gui.status.lonDeg = o.lon / DEG;
    gui.status.tiltDeg = o.tilt / DEG;
    gui.status.band = activeView === 'strategic' ? strategicView.bands.band : '—';
    const ts = globe.terrain.stats;
    const fs = globe.forest.stats;
    gui.status.trees = globe.forest.group.visible
      ? `${fs.instances} clumps in ${fs.tiles} tiles${fs.pending ? `, ${fs.pending} loading` : ''}`
      : 'off (shown below 8 km)';
    const bs = globe.structures.stats;
    gui.status.buildings = globe.structures.group.visible
      ? `${bs.instances} in ${bs.tiles} tiles${bs.pending ? `, ${bs.pending} loading` : ''}`
      : 'off (shown below 15 km)';
    const rs = strategicView.relief.stats;
    const tileText =
      activeView === 'strategic'
        ? `map: ${rs.drawn} drawn, L${rs.deepest} deepest, ${rs.meshes} meshes, ${rs.dataTiles} data, ${rs.pending} loading`
        : `${ts.drawn} drawn, L${ts.deepest} deepest, ${ts.meshes} meshes, ${ts.dataTiles} data, ${ts.pending} loading`;
    const tilesOn = activeView === 'strategic' ? strategicView.useTiles : globe.useTiles;
    gui.status.tiles = !globe.terrainReady
      ? 'waiting for the global pass'
      : tilesBlocked && viewParams.tiles
        ? 'off: this color mode needs the grid'
        : tilesOn
          ? tileText
          : 'off';
  });
}

/** Time since campaign start as "2 d 06:30". */
function campaignClock(t: number, day: number): string {
  const d = Math.floor(t / day);
  const rest = t - d * day;
  const hh = Math.floor(rest / HOUR);
  const mm = Math.floor((rest % HOUR) / 60);
  return `${d} d ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Weather at a direction for the time bar: cover, ceiling, visibility, wind, temperature. */
function describeWeather(sim: SimClient, dir: Vec3d, t: number): string {
  if (!sim.weather.ready) return 'weather —';
  const r = sim.weather.report(dir, t);
  const w = sim.weather.wind(dir, 10, t);
  const from = ((Math.atan2(-w.east, -w.north) / DEG + 360) % 360).toFixed(0).padStart(3, '0');
  const speed = Math.hypot(w.east, w.north);
  const ceiling = Number.isFinite(r.ceiling)
    ? `ceiling ${Math.round(r.ceiling / 10) * 10} m`
    : 'no ceiling';
  const mmh = r.precipitation * HOUR * 1000;
  const precip = mmh >= 0.1 ? `, ${r.snow > 0.5 ? 'snow' : 'rain'} ${mmh.toFixed(1)} mm/h` : '';
  const vis =
    r.visibility >= 10_000
      ? `${Math.round(r.visibility / 1000)} km`
      : `${(r.visibility / 1000).toFixed(1)} km`;
  return (
    `cloud ${Math.round(r.cloudCover * 100)}%, ${ceiling}, vis ${vis}, ` +
    `wind ${from}° ${speed.toFixed(0)} m/s, ${r.temperature.toFixed(0)} °C${precip}`
  );
}

/** Sim status for the GUI: rate, events and ticks run, pending events, weather systems. */
function describeSim(sim: SimClient): string {
  const h = sim.header;
  if (!sim.started || !h) return 'no world yet';
  const F = SnapshotField;
  return (
    `${h[F.Rate]}×, ${h[F.Events]} events, ${h[F.Ticks]} ticks, ${h[F.Pending]} pending, ` +
    `${h[F.WeatherSystems]} weather systems, step ${h[F.StepMs]!.toFixed(1)} ms`
  );
}

main().catch((err: unknown) => {
  console.error(err);
  showFatalError(String(err));
});
