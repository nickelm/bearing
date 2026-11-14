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
import { QualityGovernor } from './render/common/qualityGovernor';
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
import { DEFAULT_TILE_MEMORY_MIB } from './render/common/terrain/terrainBudget';
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
  AtmosphereGuiParams,
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
import { AirPanel } from './ui/airPanel';
import { SeedBrowser } from './ui/seedBrowser';
import { THEATER_LABELS } from './campaign/theaters';
import type { StrategicWorld } from './worldgen/campaignWorld';
import { SimClient } from './workers/simClient';
import { campaignInput } from './sim/command/campaignInput';
import { SnapshotField } from './workers/protocol';
import { buildWeatherClimate } from './sim/weather/climate';
import { WeatherView } from './sim/weather/frame';
import { WeatherGrid } from './sim/weather/grid';
import { applyPreset } from './sim/weather/presets';
import type { WeatherPreset } from './sim/weather/presets';
import {
  applyAtmosphere,
  GOVERNOR_STEPS,
  governorStatus,
  readAtmosphere,
} from './ui/atmosphereSettings';
import { WeatherAudio } from './ui/audio/weatherAudio';
import { DEFAULT_OPTIONS } from './ui/flight/freeFlightMenu';
import { weatherLine } from './ui/weatherLine';
import { TimeControls } from './ui/timeControls';
import { hasTouch, TouchControls } from './ui/touchControls';
import { GenerationCancelled, WorldgenClient } from './workers/worldgenClient';
import { fetchLabelFonts } from './render/strategic/labels/fonts';
import { FreeFlight, parseFreeFlightUrl } from './freeflight/freeFlight';
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
  // Free Flight (decision 134): ?mode=freeflight&seed=…&base=…&weather=…, a sandbox without the war.
  const freeFlightMode = query.get('mode') === 'freeflight';
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
    exaggeration: 1,
    wireframe: false,
    tiles: true,
    geomorph: true,
    sse: DEFAULT_LOD.sseThreshold,
    tileMemory: DEFAULT_TILE_MEMORY_MIB,
    prefetch: true,
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
    scene: query.get('view') === 'strategic' || freeFlightMode ? 'strategic' : 'simulation',
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
  /**
   * Starts the simulation for a world: its climate drives the weather (decision 68),
   * its campaign the air war (C2).
   */
  const startSim = (world: World, strategic: StrategicWorld, radius: number) => {
    const climate = buildWeatherClimate(
      { ...world.maps, resolution: world.info.resolution, reliefScale: world.info.reliefScale },
      weatherGrid,
      radius,
    );
    // Cloud bases, fog and dust stand on the mean ground of each weather sample (decision 141):
    // a copy, because the sim takes the climate's buffers with it.
    globe.weather.setGround(climate.ground.slice());
    // Lightning strikes are drawn from the world's seed (decision 142).
    globe.lightning.seed = String(strategic.seed);
    if (freeFlight) {
      // Free Flight runs no war simulation (decision 134): the weather model alone, on this thread.
      freeFlight.setClimate({
        seed: String(strategic.seed),
        radius,
        orbit: orbitParams,
        calendar,
        climate,
      });
      return;
    }
    const campaign = campaignInput(
      strategic.graph,
      strategic.campaign.cast,
      strategic.infrastructure,
    );
    presetWeather.clear();
    sim.init(String(strategic.seed), radius, orbitParams, calendar, climate, campaign);
  };
  /**
   * The weather on screen in the campaign: the sim's own, or a preset of it chosen in the
   * debug panel (GUI → Atmosphere → Weather). The preset is applied to every frame the sim
   * sends, so it holds as the hours pass. Free Flight shows its own (freeflight/flightWeather.ts).
   */
  let weatherPreset: WeatherPreset = 'live';
  const presetWeather = new WeatherView(weatherGrid);
  const shownWeather = (): WeatherView | null =>
    freeFlight ? freeFlight.weatherView : weatherPreset === 'live' ? sim.weather : presetWeather;
  const showWeather = () => {
    if (freeFlight) return;
    if (weatherPreset !== 'live') applyPreset(weatherPreset, sim.weather, presetWeather);
    const view = shownWeather();
    if (view?.ready) globe.weather.setFrames(view);
  };
  sim.onWeather = showWeather;
  sim.onMissions = () => strategicView.setMissions(sim.missions);

  let grid = new CubeGrid(worldParams.resolution);
  const globe = new GlobeScene(renderer, { radius: DEFAULT_PLANET_PARAMS.radius, grid });
  // The moon and the stars are placed from the orbit and the campaign's calendar (decision 140).
  globe.planetOrbit = orbitParams;
  globe.calendar = calendar;
  // The weather's sound (decision 142): rain, wind and thunder. It starts on the first key or
  // pointer event and falls silent over the map, which has no weather sound.
  const audio = new WeatherAudio();
  audio.attach();
  globe.lightning.onThunder = (e) => {
    if (activeView === 'simulation') audio.thunder(e);
  };
  globe.globe.setFaceSeed(worldParams.seed);
  globe.globe.setExaggeration(viewParams.exaggeration);
  globe.terrain.setExaggeration(viewParams.exaggeration);
  globe.terrain.budgetMiB = viewParams.tileMemory;
  globe.terrain.prefetch.enabled = viewParams.prefetch;
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
  /** The Free Flight mode, when the URL asks for it (created once the GUI exists). */
  let freeFlight: FreeFlight | null = null;
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
    if (view === 'strategic') {
      // The simulation view's render targets are not kept while the map shows (decision 138).
      globe.pipeline?.release();
    } else {
      // Back in the simulation view after any length of game time: the effects start over.
      globe.resetAtmosphere();
      // Its first frames allocate targets and compile shaders: they do not count for the scale,
      // and what the scale learned over the map says nothing here.
      renderScale.reset(performance.now());
    }
    // The selection panel belongs to the map.
    if (view !== 'strategic') strategicView.airSelected = null;
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
    // The chase camera belongs to Free Flight while it flies.
    if (globe.cameraMode === 'chase') return;
    const station = stations.find((x) => x.label === viewParams.station) ?? stations[0] ?? null;
    const observer = station !== null && (viewParams.simCamera === 'observer' || !devCamera);
    const mode = observer ? 'observer' : 'free';
    const moved = observer && globe.observer.station?.key !== station.key;
    if (moved) globe.observer.setStation(station);
    // A camera cut: wetness, fog banks, particles and shadows start over at the new place.
    if (moved || mode !== globe.cameraMode) globe.resetAtmosphere();
    globe.cameraMode = mode;
  };

  const campaignParams: CampaignGuiParams = {
    // Off by default (owner request): a developer view of the graph over the simulation view.
    overlay: false,
    // Off by default: the panel covers much of the screen (GUI → Campaign → Briefing).
    briefing: false,
    seedUsed: '—',
    theaters: '—',
    rangeFactor: 0,
    airbases: '—',
    coarseSeconds: 0,
  };
  const campaignPanel = new CampaignPanel();
  // The flight or carrier clicked on the map (decision 133).
  const airPanel = new AirPanel();
  strategicView.onAirSelect = (key) => airPanel.select(key);
  airPanel.onClose = () => (strategicView.airSelected = null);
  const showStrategic = (s: StrategicWorld | null) => {
    freeFlight?.setStrategic(s);
    globe.strategic.setWorld(s?.graph ?? null, s?.campaign.cast ?? null, s?.infrastructure ?? null);
    strategicView.setStrategic(
      s?.graph ?? null,
      s?.campaign.cast ?? null,
      s?.infrastructure ?? null,
    );
    strategicView.airSelected = null;
    airPanel.setCampaign(s?.campaign.cast ?? null, s?.infrastructure ?? null, s?.graph.radius ?? 1);
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
      globe.calendar = calendar;
      gameTime = 0;
      globe.weather.fill(0);
      globe.resetAtmosphere();
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
      const riverIndex = new RiverIndex(global.finish.rivers, {
        height: global.height,
        radius: params.radius,
      });
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
      const grading = airfieldGrading(infra, global.height, global.n);
      globe.terrain.setWorld({
        synth,
        seed: params.seed,
        radius: params.radius,
        reliefScale: params.reliefScale,
        rivers: riverIndex,
        infra,
        // Airfields graded flat into the terrain (V3).
        grading,
      });
      // Mountain shadows are baked from the global heights (decision 139).
      globe.shadows.setHeights(global.height, global.n);
      freeFlight?.setTerrain({
        infra,
        grading,
        height: global.height,
        n: global.n,
        airbases: strategic.infrastructure,
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
      // The valley floor, so snow and seasons read the Earth-like elevation (decision 122).
      globe.climate.setValleyFloor(global.finish.display.valleyFloor ?? null, world.maps.height);
      strategicView.setValleyFloor(global.finish.display.valleyFloor ?? null);
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
        startSim(stored.tectonic, stored.strategic, params.radius);
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
      startSim(world, strategic, params.radius);
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
      globe.terrain.prefetch.enabled = v.prefetch;
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
  // The overlay's own default is on; the GUI's value reaches it only on change otherwise.
  globe.strategic.enabled = campaignParams.overlay;
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
  /**
   * Jumps the game clock: the effects that remember the last frame start over. The sun and
   * the display time jump at once; the weather of the new time comes with the worker's answer,
   * and the ground takes its wetness from it then (until then the view holds the old frames).
   */
  const seek = (time: number) => {
    sim.seek(time);
    globe.resetAtmosphere();
  };
  sim.onSeeked = () => globe.weatherState.reset();
  gui.addTimeControls(timeParams, daysPerYear(orbitParams), {
    dayChanged: (d) => {
      const lon = activeOrbit().lon;
      const days = d - localDayOfYear(gameTime, lon, orbitParams, calendar);
      seek(gameTime + days * orbitParams.solarDay);
    },
    hoursChanged: (h) => {
      seek(withLocalTime(gameTime, activeOrbit().lon, h * HOUR, orbitParams, calendar));
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
  // Free Flight keeps its own clock, and Space is the wheel brakes there.
  if (freeFlightMode) timeControls.dispose();
  // On-screen walk stick, height slider and ×5 for the observer on touch screens (decision 114).
  const touchControls = new TouchControls(globe.observer.stick);
  const touchDevice = hasTouch();
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
    flights: true,
    trails: true,
    carriers: true,
    routes: false,
    viewingSide: 'both',
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
    strategicView.setAirVisible('flights', m.flights);
    strategicView.setAirVisible('trails', m.trails);
    strategicView.setAirVisible('carriers', m.carriers);
    strategicView.setAirVisible('routes', m.routes);
    strategicView.airView.side = m.viewingSide;
    strategicView.airView.routes = m.routes;
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
    facets: globe.terrain.land.facets.value > 0,
    farmland: globe.terrain.land.farmland.value > 0,
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
    // The temperature shift is applied each frame, with the weather preset's (see the loop).
    globe.terrain.land.detail.value = l.detail;
    globe.terrain.land.facets.value = l.facets ? 1 : 0;
    globe.terrain.land.farmland.value = l.farmland ? 1 : 0;
    globe.terrain.riverStyle.legibility.value = l.riverLegibility;
    globe.terrain.roadStyle.enabled.value = l.roads ? 1 : 0;
    globe.terrain.roadStyle.legibility.value = l.roadLegibility;
    globe.terrain.roadStyle.lights.value = l.nightLights;
    globe.clouds.enabled.value = l.clouds ? 1 : 0;
    globe.clouds.coverageBias.value = l.cloudCover;
  });

  // Atmosphere (decisions 137–143): the panel starts from the scene's own values.
  const flightUrl = freeFlightMode ? parseFreeFlightUrl(query, worldParams.seed) : null;
  const atmosphere: AtmosphereGuiParams = readAtmosphere(
    globe,
    audio,
    flightUrl ? (flightUrl.options.weather ?? DEFAULT_OPTIONS.weather) : weatherPreset,
  );
  // The governor lowers the volumetric quality and the particles on a machine that struggles.
  const governor = new QualityGovernor(GOVERNOR_STEPS);
  let governed = atmosphere.autoQuality;
  const applyAtmosphereSettings = () => {
    const now = performance.now();
    if (atmosphere.autoQuality && !governed) governor.reset(now);
    governed = atmosphere.autoQuality;
    // New shader variants compile in the next frames: they do not count for the render scale,
    // and the scale finds its place anew under the changed load.
    if (applyAtmosphere(atmosphere, globe, audio, governor.level)) renderScale.reset(now);
    atmosphere.status = governorStatus(atmosphere, governor.level);
  };
  applyAtmosphereSettings();
  /** Land temperature shift of the campaign's weather preset at the camera (°C). */
  let presetTemperatureShift = 0;
  gui.addAtmosphereControls(atmosphere, applyAtmosphereSettings, (preset) => {
    if (freeFlight) {
      freeFlight.setWeather(preset);
      return;
    }
    weatherPreset = preset;
    showWeather();
    // The ground's wetness and the fog start from the new weather.
    globe.resetAtmosphere();
  });
  /** The sound as the pause menu sets it, kept in step with the panel. */
  const sound = {
    get volume() {
      return atmosphere.volume;
    },
    set volume(v: number) {
      atmosphere.volume = v;
      audio.volume = v;
    },
    get muted() {
      return atmosphere.mute;
    },
    set muted(on: boolean) {
      atmosphere.mute = on;
      audio.muted = on;
    },
  };
  // Sound stops while the game is paused or the tab is hidden (thunder on its way waits).
  // Not before it has started: the context must first run from the key or click that creates
  // it, or a browser that asks for a gesture (Safari) never lets it sound; the campaign
  // starts paused.
  let audioHeld = false;
  const holdAudio = () => {
    if (!audio.started) return;
    const hold = document.hidden || globe.paused;
    if (hold === audioHeld) return;
    audioHeld = hold;
    if (hold) audio.suspend();
    else audio.resume();
  };
  document.addEventListener('visibilitychange', () => {
    holdAudio();
    // The time away is no evidence of a struggle or of headroom: the governor starts over.
    governor.hold(performance.now());
  });
  // Leaving the page for good closes the audio; a page kept for back and forward keeps it.
  window.addEventListener('pagehide', (e) => {
    if (!e.persisted) audio.dispose();
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

  // Free Flight: its start screen over the map, then the flight (decision 134).
  if (freeFlightMode) {
    freeFlight = new FreeFlight(
      {
        canvas: renderer.domElement,
        globe,
        strategic: strategicView,
        radius: DEFAULT_PLANET_PARAMS.radius,
        orbit: orbitParams,
        calendar: () => calendar,
        setView: (v) => {
          viewParams.scene = v;
          setActiveView(v);
        },
        loadSeed: (seed) => {
          worldParams.seed = seed;
          gui.refresh();
          void regenerate();
        },
        exit: () => {
          const u = new URL(location.href);
          for (const k of ['mode', 'base', 'tod', 'weather', 'wind', 'spawn', 'fuel', 'autopilot'])
            u.searchParams.delete(k);
          location.href = u.toString();
        },
        status: () =>
          `World ${worldParams.seed}: ${gui.status.generation}${globe.terrainReady ? '' : ' (the terrain must finish before you fly)'}`,
        sound,
        weatherChanged: (preset) => (atmosphere.weather = preset),
      },
      flightUrl!,
    );
    // The debug GUI stays out of the way unless asked for (?dev).
    if (!query.has('dev')) gui.gui.hide();
    // Tools and screenshots drive the mode from the page (dev server, or ?autopilot).
    if (import.meta.env.DEV || query.has('autopilot'))
      (window as unknown as { freeFlight: FreeFlight }).freeFlight = freeFlight;
  } else {
    gui.gui
      .add(
        {
          'Free Flight…': () => {
            const u = new URL(location.href);
            u.searchParams.set('mode', 'freeflight');
            u.searchParams.set('seed', worldParams.seed);
            location.href = u.toString();
          },
        },
        'Free Flight…',
      )
      .name('Free Flight (fly from an airbase)…');
  }
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
    // The atmosphere's quality follows the machine, while the simulation view has terrain to draw.
    if (atmosphere.autoQuality && activeView === 'simulation' && globe.terrainReady) {
      const level = governor.record({
        frameMs,
        nowMs: now,
        targetMs: renderScale.targetMs,
        scale: renderScale.scale,
        minScale: renderScale.minScale,
        maxScale: renderScale.maxScale,
        adaptive: viewParams.renderScale === 'auto',
      });
      if (level !== null) {
        applyAtmosphereSettings();
        // The load has changed: the render scale finds its place anew.
        renderScale.reset(now);
      }
    } else {
      governor.hold(now);
    }
    const dt = Math.min(frameMs, 100) / 1000;
    freeFlight?.frame(Math.min(frameMs, 250) / 1000, frameMs);
    gameTime =
      freeFlight && freeFlight.state !== 'menu' ? freeFlight.gameTime : sim.displayTime(now);
    globe.gameTime = gameTime;
    // A standing clock holds the weather's motion, the particles and the sound.
    globe.paused = freeFlight ? freeFlight.state === 'paused' : sim.rate === 0;
    holdAudio();
    sunDirection(gameTime, orbitParams, calendar, globe.sun);
    globe.terrain.land.seasonPhase.value = seasonPhase(gameTime, orbitParams, calendar);
    // The map shares the sun and the season (decision 87).
    strategicView.sun.copy(globe.sun);
    strategicView.relief.seasonPhase.value = globe.terrain.land.seasonPhase.value;
    strategicView.setAirTime(gameTime);
    if (activeView === 'strategic') airPanel.update(sim.missions, gameTime, now);
    globe.clouds.time.value = gameTime;
    // The weather the scene reads at the camera; Free Flight feeds the texture itself.
    const weather = shownWeather();
    if (!freeFlight && weather?.ready) globe.weather.update(weather, gameTime);
    globe.weatherView = weather?.ready ? weather : null;
    // Snow lies where a weather preset makes it snow: the land takes the preset's temperature shift.
    globe.terrain.land.temperatureOffset.value =
      lightParams.temperatureShift +
      (freeFlight ? freeFlight.temperatureShift : presetTemperatureShift);
    touchControls.visible =
      touchDevice && activeView === 'simulation' && globe.cameraMode === 'observer';
    if (activeView === 'strategic') strategicView.render(dt);
    else globe.render(dt);
    if (freeFlight && activeView === 'simulation') freeFlight.drawHud(globe.camera);
    // Rain, wind and dust where the camera is; silence over the map.
    const listening = activeView === 'simulation';
    const falling = globe.precipitation?.levels;
    const state = globe.weatherState;
    audio.update({
      rain: listening ? (falling?.rain ?? state.rain.value) : 0,
      snow: listening ? (falling?.snow ?? state.snow.value) : 0,
      dust: listening ? (falling?.dust ?? state.dust.value) : 0,
      wind: listening ? state.wind.value.length() : 0,
    });

    const lon = activeOrbit().lon;
    timeParams.day = localDayOfYear(gameTime, lon, orbitParams, calendar);
    timeParams.hours = localSolarTime(gameTime, lon, orbitParams, calendar) / HOUR;
    timeParams.date = formatLocalDate(gameTime, lon, orbitParams, calendar);
    if (now - lastClockText > 200) {
      lastClockText = now;
      // Where the view's camera is; the chase camera flies with the aircraft.
      if (activeView === 'simulation' && globe.cameraMode === 'chase')
        here.copy(globe.chase.eye).normalize();
      else latLonToDirection(activeOrbit().lat, activeOrbit().lon, here);
      const line = weatherLine(weather, here, gameTime);
      timeParams.weather = line;
      timeParams.sim = describeSim(sim);
      presetTemperatureShift =
        weatherPreset !== 'live' && presetWeather.ready && sim.weather.ready
          ? presetWeather.report(here, gameTime).temperature -
            sim.weather.report(here, gameTime).temperature
          : 0;
      if (!freeFlightMode)
        timeControls.update({
          rate: sim.rate,
          local: `${timeParams.date} local`,
          campaign: `T+${campaignClock(gameTime, orbitParams.solarDay)}`,
          weather: line,
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
    const ob = globe.observer;
    gui.status.observer =
      globe.cameraMode === 'observer' && ob.station
        ? `${(ob.distanceFromStation / KM).toFixed(1)} km from the station, ${ob.height.toFixed(0)} m up`
        : '—';
    const rs = strategicView.relief.stats;
    const tileText =
      activeView === 'strategic'
        ? `map: ${rs.drawn} drawn, L${rs.deepest} deepest, ${rs.meshes} meshes, ${rs.dataTiles} data, ${rs.pending} loading`
        : `${ts.drawn} drawn, L${ts.deepest} deepest, ${ts.meshes} meshes, ${ts.dataTiles} data, ${ts.pending} loading, bubble ${ts.bubbleReady}/${ts.bubble}${ts.ahead ? `, ${ts.ahead} ahead` : ''}`;
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

/** Sim status for the GUI: rate, events and ticks run, pending events, weather systems. */
function describeSim(sim: SimClient): string {
  const h = sim.header;
  if (!sim.started || !h) return 'no world yet';
  const F = SnapshotField;
  return (
    `${h[F.Rate]}×, ${h[F.Events]} events, ${h[F.Ticks]} ticks, ${h[F.Pending]} pending, ` +
    `${h[F.WeatherSystems]} weather systems, ${h[F.Missions]} missions, ` +
    `airborne ${h[F.AirborneAlliance]} Alliance / ${h[F.AirbornePact]} Pact, step ${h[F.StepMs]!.toFixed(1)} ms`
  );
}

main().catch((err: unknown) => {
  console.error(err);
  showFatalError(String(err));
});
