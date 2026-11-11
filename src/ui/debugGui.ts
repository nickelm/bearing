/**
 * lil-gui debug panel: world parameters, generation control, debug view
 * options and read-only status values.
 */
import { RENDER_SCALES } from '../render/common/renderScale';
import type { RenderScaleSetting } from '../render/common/renderScale';
import GUI from 'lil-gui';

export interface WorldGuiParams {
  seed: string;
  /** Tectonic grid: cells per cube-face edge. */
  resolution: number;
  /** Global grid (erosion, drainage): cells per cube-face edge. */
  globalResolution: number;
  plateCount: number;
  oceanFraction: number;
  reliefScale: number;
  temperatureOffset: number;
  moistureScale: number;
  erosionStrength: number;
}

export interface ViewGuiParams {
  mode: string;
  exaggeration: number;
  wireframe: boolean;
  /** Tiled LOD terrain instead of the M1 grid mesh. */
  tiles: boolean;
  geomorph: boolean;
  /** Screen-space error threshold (pixels). */
  sse: number;
  /** Tile memory budget (MiB). */
  tileMemory: number;
  /** Instanced tree clumps near the camera. */
  trees: boolean;
  /** Tree range (km). */
  treeRange: number;
  /** Instanced buildings of towns, airbases and industry near the camera. */
  buildings: boolean;
  /** Canvas resolution relative to the device pixel ratio: 'auto' adapts to the frame time. */
  renderScale: RenderScaleSetting;
  /** Frame rate the automatic render scale holds. */
  targetFps: number;
  /** Which view is on screen (decision 72): the strategic map or the simulation view. */
  scene: 'simulation' | 'strategic';
}

/** Time folder: jumps of the sim clock, alarms and the sim status (milestone 6). */
export interface TimeGuiParams {
  /** Local day of the year at the camera, 0-based. */
  day: number;
  /** Local solar time at the camera, hours. */
  hours: number;
  /** Local date and time at the camera (read-only). */
  date: string;
  /** Drop to 1× when a flagged event runs. */
  autoSlowdown: boolean;
  /** Hours from now for the test alarm. */
  alarmHours: number;
  /** Sim status: clock, events, ticks, weather systems (read-only). */
  sim: string;
  /** Weather under the camera (read-only). */
  weather: string;
}

/** Map folder: the strategic view's relief and hillshade (decisions 77, 78). */
export interface MapGuiParams {
  /** Relief exaggeration on the map (Part II default 4×). */
  exaggeration: number;
  /** 0 = no relief shading, 1 = full cartographic hillshade. */
  hillshade: number;
  /** Light elevation above the ground (degrees). */
  lightElevation: number;
  /** Darkest a shadowed slope gets, relative to flat ground. */
  ambient: number;
  /** Forest stipple and farmland with its field grid (decision 80). */
  patterns: boolean;
  /** Night tint and twilight strength 0..1 (decision 87). */
  night: number;
  twilight: number;
  /** Seasonal snow, sea ice and lake ice. */
  seasons: boolean;
  /** Clouds and precipitation hatching from the live weather (decision 89). */
  weather: boolean;
  /** Cloud opacity scale (1 = 25% to 45% by coverage). */
  cloudOpacity: number;
  /** Latitude and longitude lines (decision 91). */
  graticule: boolean;
  /** Range rings around the clicked point; Escape clears it. */
  rangeRings: boolean;
  /** Vignette and paper grain strength (decision 92). */
  finish: number;
}

export interface LightingGuiParams {
  atmosphere: boolean;
  /** Air density relative to Earth's (scales scattering and absorption). */
  airDensity: number;
  exposure: number;
  /** Multiplier on the atmosphere's sky light on surfaces. */
  skyLight: number;
  /** Starlight and airglow on the night side. */
  nightLight: number;
  /** Water wave slope multiplier (0 = mirror-flat). */
  waves: number;
  /** Coastal foam multiplier (0 = none). */
  foam: number;
  /** Shifts surface temperatures for snow and season tint (°C). */
  temperatureShift: number;
  /** Terrain albedo detail-noise strength. */
  detail: number;
  /** How readable sub-pixel rivers are (0 = physically faint). */
  riverLegibility: number;
  /** Roads and airfield pavement drawn on the terrain. */
  roads: boolean;
  /** How readable sub-pixel roads are. */
  roadLegibility: number;
  /** Settlement lights on the night side (0 = off). */
  nightLights: number;
  clouds: boolean;
  /** Cloud coverage bias (positive is cloudier). */
  cloudCover: number;
}

/** Campaign folder: the cast summary (read-only) and overlay toggles. */
export interface CampaignGuiParams {
  /** Strategic graph overlay on the globe. */
  overlay: boolean;
  /** Briefing panel. */
  briefing: boolean;
  /** Seed actually generated (differs from the input after validity retries). */
  seedUsed: string;
  theaters: string;
  rangeFactor: number;
  airbases: string;
  /** Coarse pass time (s). */
  coarseSeconds: number;
}

export interface TimeGuiCallbacks {
  /** Jumps to a local day of the year (seeks the sim; backward replays from campaign start). */
  dayChanged(day: number): void;
  /** Jumps to a local time on the current day. */
  hoursChanged(hours: number): void;
  autoSlowdownChanged(enabled: boolean): void;
  /** Schedules a flagged test event `hours` from now. */
  alarm(hours: number): void;
}

export interface DebugGuiStatus {
  generation: string;
  altitudeKm: number;
  latDeg: number;
  lonDeg: number;
  tiltDeg: number;
  /** Strategic zoom band (decision 76), or "—" in the simulation view. */
  band: string;
  backend: string;
  /** Drawing-buffer size and render scale. */
  resolution: string;
  compute: string;
  worker: string;
  tiles: string;
  trees: string;
  buildings: string;
}

export interface DebugGuiCallbacks {
  regenerate(): void;
  /** Deletes all cached worlds from IndexedDB. */
  clearCache(): void;
  cancel(): void;
  viewChanged(view: ViewGuiParams): void;
  shapeChanged(view: ViewGuiParams): void;
}

export const RESOLUTIONS = [64, 128, 256, 512] as const;
/** Global grid sizes; 1024 is the default (decision 27). */
export const GLOBAL_RESOLUTIONS = [512, 1024, 2048] as const;
export const DEFAULT_GLOBAL_RESOLUTION = 1024;

export class DebugGui {
  readonly gui = new GUI({ title: 'Bearing' });
  readonly status: DebugGuiStatus = {
    generation: 'idle',
    altitudeKm: 0,
    latDeg: 0,
    lonDeg: 0,
    tiltDeg: 0,
    band: '—',
    backend: '—',
    resolution: '—',
    compute: 'pending',
    worker: 'pending',
    tiles: '—',
    trees: '—',
    buildings: '—',
  };

  constructor(
    readonly world: WorldGuiParams,
    readonly view: ViewGuiParams,
    viewModes: readonly string[],
    callbacks: DebugGuiCallbacks,
  ) {
    const regen = () => callbacks.regenerate();

    const w = this.gui.addFolder('World');
    w.add(world, 'seed').name('Seed').onFinishChange(regen);
    w.add({ regenerate: regen }, 'regenerate').name('Regenerate');
    w.add(
      {
        randomize: () => {
          world.seed = randomSeed();
          this.refresh();
          regen();
        },
      },
      'randomize',
    ).name('Random seed');
    w.add({ cancel: () => callbacks.cancel() }, 'cancel').name('Cancel generation');
    w.add({ clear: () => callbacks.clearCache() }, 'clear').name('Clear world cache');
    w.add(world, 'resolution', [...RESOLUTIONS])
      .name('Tectonic cells per face')
      .onFinishChange(regen);
    w.add(world, 'globalResolution', [...GLOBAL_RESOLUTIONS])
      .name('Global cells per face')
      .onFinishChange(regen);
    w.add(world, 'erosionStrength', 0, 2, 0.05).name('Erosion strength').onFinishChange(regen);
    w.add(world, 'plateCount', 6, 40, 1).name('Plates').onFinishChange(regen);
    w.add(world, 'oceanFraction', 0.4, 0.9, 0.01).name('Ocean fraction').onFinishChange(regen);
    w.add(world, 'reliefScale', 0.05, 1, 0.005).name('Relief scale').onFinishChange(regen);
    w.add(world, 'temperatureOffset', -20, 20, 0.5)
      .name('Temperature offset (°C)')
      .onFinishChange(regen);
    w.add(world, 'moistureScale', 0.2, 2, 0.05).name('Moisture scale').onFinishChange(regen);

    const v = this.gui.addFolder('View');
    v.add(view, 'scene', ['simulation', 'strategic'])
      .name('View')
      .onChange(() => callbacks.viewChanged(view));
    v.add(view, 'mode', [...viewModes])
      .name('Color by')
      .onChange(() => callbacks.viewChanged(view));
    v.add(view, 'exaggeration', 1, 40, 1)
      .name('Height exaggeration')
      .onFinishChange(() => callbacks.shapeChanged(view));
    v.add(view, 'wireframe')
      .name('Wireframe (grid)')
      .onChange(() => callbacks.viewChanged(view));
    v.add(view, 'renderScale', [...RENDER_SCALES])
      .name('Render scale')
      .onChange(() => callbacks.viewChanged(view));
    v.add(view, 'targetFps', 20, 60, 5)
      .name('Target FPS (auto scale)')
      .onChange(() => callbacks.viewChanged(view));
    const t = v.addFolder('Terrain tiles');
    t.add(view, 'tiles')
      .name('Tiled terrain')
      .onChange(() => callbacks.viewChanged(view));
    t.add(view, 'geomorph')
      .name('Geomorphing')
      .onChange(() => callbacks.viewChanged(view));
    t.add(view, 'sse', 0.5, 8, 0.25)
      .name('Detail (error px)')
      .onChange(() => callbacks.viewChanged(view));
    t.add(view, 'tileMemory', 128, 2048, 64)
      .name('Tile memory (MiB)')
      .onFinishChange(() => callbacks.viewChanged(view));
    t.add(view, 'trees')
      .name('Trees (sim detail)')
      .onChange(() => callbacks.viewChanged(view));
    t.add(view, 'treeRange', 1, 8, 0.5)
      .name('Tree range (km)')
      .onFinishChange(() => callbacks.viewChanged(view));
    t.add(view, 'buildings')
      .name('Buildings (sim detail)')
      .onChange(() => callbacks.viewChanged(view));

    const st = this.gui.addFolder('Status');
    st.add(this.status, 'generation').name('Generation').disable().listen();
    st.add(this.status, 'altitudeKm').name('Altitude (km)').decimals(1).disable().listen();
    st.add(this.status, 'latDeg').name('Latitude (°)').decimals(3).disable().listen();
    st.add(this.status, 'lonDeg').name('Longitude (°)').decimals(3).disable().listen();
    st.add(this.status, 'tiltDeg').name('Tilt (°)').decimals(1).disable().listen();
    st.add(this.status, 'band').name('Zoom band').disable().listen();
    st.add(this.status, 'backend').name('Backend').disable().listen();
    st.add(this.status, 'resolution').name('Resolution').disable().listen();
    st.add(this.status, 'compute').name('GPU compute').disable().listen();
    st.add(this.status, 'worker').name('Sim worker').disable().listen();
    st.add(this.status, 'tiles').name('Tiles').disable().listen();
    st.add(this.status, 'trees').name('Trees').disable().listen();
    st.add(this.status, 'buildings').name('Buildings').disable().listen();
  }

  /** Adds a top-level folder above Status (lil-gui appends, so move its element). */
  private folderBeforeStatus(title: string): GUI {
    const f = this.gui.addFolder(title);
    const status = this.gui.folders.find((x) => x._title === 'Status');
    if (status) this.gui.$children.insertBefore(f.domElement, status.domElement);
    return f;
  }

  /** Adds the Time folder: date, jumps by day and time of day, alarms and sim status. */
  addTimeControls(time: TimeGuiParams, daysPerYear: number, callbacks: TimeGuiCallbacks): void {
    const f = this.folderBeforeStatus('Time');
    f.add(time, 'date').name('Local date').disable().listen();
    // Jumps apply on release: each one seeks the sim (backward replays from campaign start).
    f.add(time, 'day', 0, Math.ceil(daysPerYear) - 1, 1)
      .name('Day of year')
      .listen()
      .onFinishChange((d: number) => callbacks.dayChanged(d));
    f.add(time, 'hours', 0, 24, 0.05)
      .name('Local time (h)')
      .listen()
      .onFinishChange((h: number) => callbacks.hoursChanged(h));
    f.add(time, 'autoSlowdown')
      .name('Auto-slowdown')
      .onChange((v: boolean) => callbacks.autoSlowdownChanged(v));
    f.add(time, 'alarmHours', 0.25, 48, 0.25).name('Alarm in (h)');
    f.add({ alarm: () => callbacks.alarm(time.alarmHours) }, 'alarm').name('Set test alarm');
    f.add(time, 'sim').name('Sim').disable().listen();
    f.add(time, 'weather').name('Weather here').disable().listen();
  }

  /** Adds the Lighting folder: atmosphere, air density, exposure, sky and night light. */
  /** Adds the Map folder: the strategic view's relief and hillshade. */
  addMapControls(map: MapGuiParams, changed: (m: MapGuiParams) => void): void {
    const f = this.folderBeforeStatus('Map (strategic view)');
    f.add(map, 'exaggeration', 1, 12, 0.5)
      .name('Relief exaggeration')
      .onChange(() => changed(map));
    f.add(map, 'hillshade', 0, 2, 0.05)
      .name('Hillshade strength')
      .onChange(() => changed(map));
    f.add(map, 'lightElevation', 15, 75, 1)
      .name('Light elevation (°)')
      .onChange(() => changed(map));
    f.add(map, 'ambient', 0, 1, 0.05)
      .name('Shadow floor')
      .onChange(() => changed(map));
    f.add(map, 'patterns')
      .name('Patterns (forest, farmland)')
      .onChange(() => changed(map));
    f.add(map, 'night', 0, 1, 0.05)
      .name('Night')
      .onChange(() => changed(map));
    f.add(map, 'twilight', 0, 1, 0.05)
      .name('Twilight')
      .onChange(() => changed(map));
    f.add(map, 'seasons')
      .name('Seasons (snow, ice)')
      .onChange(() => changed(map));
    f.add(map, 'weather')
      .name('Weather (clouds, rain)')
      .onChange(() => changed(map));
    f.add(map, 'cloudOpacity', 0, 2, 0.05)
      .name('Cloud opacity')
      .onChange(() => changed(map));
    f.add(map, 'graticule')
      .name('Graticule')
      .onChange(() => changed(map));
    f.add(map, 'rangeRings')
      .name('Range rings (click; Esc)')
      .onChange(() => changed(map));
    f.add(map, 'finish', 0, 3, 0.05)
      .name('Paper finish')
      .onChange(() => changed(map));
    f.close();
  }

  addLightingControls(light: LightingGuiParams, changed: (l: LightingGuiParams) => void): void {
    const f = this.folderBeforeStatus('Lighting');
    f.add(light, 'atmosphere')
      .name('Atmosphere')
      .onChange(() => changed(light));
    f.add(light, 'airDensity', 0, 4, 0.05)
      .name('Air density (× Earth)')
      .onFinishChange(() => changed(light));
    f.add(light, 'exposure', 0.2, 4, 0.05)
      .name('Exposure')
      .onChange(() => changed(light));
    f.add(light, 'skyLight', 0, 4, 0.05)
      .name('Sky light')
      .onChange(() => changed(light));
    f.add(light, 'nightLight', 0, 0.1, 0.001)
      .name('Night light')
      .onChange(() => changed(light));
    f.add(light, 'waves', 0, 3, 0.05)
      .name('Water waves')
      .onChange(() => changed(light));
    f.add(light, 'foam', 0, 3, 0.05)
      .name('Coastal foam')
      .onChange(() => changed(light));
    f.add(light, 'temperatureShift', -20, 20, 0.5)
      .name('Snow: temperature shift (°C)')
      .onChange(() => changed(light));
    f.add(light, 'detail', 0, 3, 0.05)
      .name('Ground detail')
      .onChange(() => changed(light));
    f.add(light, 'riverLegibility', 0, 1, 0.05)
      .name('River legibility')
      .onChange(() => changed(light));
    f.add(light, 'roads')
      .name('Roads and airfields')
      .onChange(() => changed(light));
    f.add(light, 'roadLegibility', 0, 1, 0.05)
      .name('Road legibility')
      .onChange(() => changed(light));
    f.add(light, 'nightLights', 0, 3, 0.1)
      .name('Night lights')
      .onChange(() => changed(light));
    f.add(light, 'clouds')
      .name('Clouds')
      .onChange(() => changed(light));
    f.add(light, 'cloudCover', -0.5, 0.5, 0.01)
      .name('Cloud cover')
      .onChange(() => changed(light));
  }

  /**
   * Adds the Campaign folder: overlay and briefing toggles, the cast summary
   * and the seed browser (scan the next seeds, stop).
   */
  addCampaign(
    params: CampaignGuiParams,
    changed: (p: CampaignGuiParams) => void,
    seedBrowser: { scan(count: number): void; stop(): void },
  ): void {
    const f = this.folderBeforeStatus('Campaign');
    f.add(params, 'overlay')
      .name('Strategic graph')
      .onChange(() => changed(params));
    f.add(params, 'briefing')
      .name('Briefing')
      .onChange(() => changed(params));
    f.add(params, 'seedUsed').name('Seed generated').disable().listen();
    f.add(params, 'theaters').name('Theaters').disable().listen();
    f.add(params, 'rangeFactor').name('Range factor').decimals(2).disable().listen();
    f.add(params, 'airbases').name('Airbase sites A/P').disable().listen();
    f.add(params, 'coarseSeconds').name('Coarse pass (s)').decimals(1).disable().listen();
    f.add({ scan: () => seedBrowser.scan(10) }, 'scan').name('Seed browser: scan next 10');
    f.add({ stop: () => seedBrowser.stop() }, 'stop').name('Seed browser: stop');
  }

  /**
   * Adds the Self-tests folder: one status line per test and a button that
   * runs them all. `run` reports each test's status ('running', 'ok' or a
   * failure message).
   */
  addSelfTests(
    names: readonly string[],
    run: (report: (name: string, status: string) => void) => Promise<void>,
  ): void {
    const f = this.gui.addFolder('Self-tests');
    const status: Record<string, string> = {};
    for (const n of names) status[n] = 'not run';
    let running = false;
    f.add(
      {
        run: () => {
          if (running) return;
          running = true;
          void run((name, s) => (status[name] = s)).finally(() => (running = false));
        },
      },
      'run',
    ).name('Run GPU self-tests');
    for (const n of names) f.add(status, n).disable().listen();
    f.close();
  }

  refresh(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
}

/** UI-only: picking a fresh seed is the one place randomness is meant to be non-deterministic. */
function randomSeed(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0]);
}
