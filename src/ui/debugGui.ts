/**
 * lil-gui debug panel: world parameters, generation control, debug view
 * options and read-only status values.
 */
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
}

/** Preview clock controls (until the sim clock exists, milestone 6). */
export interface TimeGuiParams {
  /** Local day of the year at the camera, 0-based. */
  day: number;
  /** Local solar time at the camera, hours. */
  hours: number;
  /** Game seconds per real second. */
  rate: number;
  /** Local date and time at the camera (read-only). */
  date: string;
  exposure: number;
}

export const TIME_RATES: Record<string, number> = {
  paused: 0,
  '1×': 1,
  '1 min/s': 60,
  '10 min/s': 600,
  '1 h/s': 3600,
  '1 day/s': 86_400,
};

export interface TimeGuiCallbacks {
  dayChanged(day: number): void;
  hoursChanged(hours: number): void;
  exposureChanged(exposure: number): void;
}

export interface DebugGuiStatus {
  generation: string;
  altitudeKm: number;
  latDeg: number;
  lonDeg: number;
  tiltDeg: number;
  backend: string;
  compute: string;
  worker: string;
  tiles: string;
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
    backend: '—',
    compute: 'pending',
    worker: 'pending',
    tiles: '—',
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
    v.add(view, 'mode', [...viewModes])
      .name('Color by')
      .onChange(() => callbacks.viewChanged(view));
    v.add(view, 'exaggeration', 1, 40, 1)
      .name('Height exaggeration')
      .onFinishChange(() => callbacks.shapeChanged(view));
    v.add(view, 'wireframe')
      .name('Wireframe (grid)')
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

    const st = this.gui.addFolder('Status');
    st.add(this.status, 'generation').name('Generation').disable().listen();
    st.add(this.status, 'altitudeKm').name('Altitude (km)').decimals(1).disable().listen();
    st.add(this.status, 'latDeg').name('Latitude (°)').decimals(3).disable().listen();
    st.add(this.status, 'lonDeg').name('Longitude (°)').decimals(3).disable().listen();
    st.add(this.status, 'tiltDeg').name('Tilt (°)').decimals(1).disable().listen();
    st.add(this.status, 'backend').name('Backend').disable().listen();
    st.add(this.status, 'compute').name('GPU compute').disable().listen();
    st.add(this.status, 'worker').name('Sim worker').disable().listen();
    st.add(this.status, 'tiles').name('Tiles').disable().listen();
  }

  /** Adds the Time folder: day of year, time of day, clock rate and exposure. */
  addTimeControls(time: TimeGuiParams, daysPerYear: number, callbacks: TimeGuiCallbacks): void {
    const f = this.gui.addFolder('Time');
    // Placed above Status: lil-gui appends, so move the folder's element.
    const status = this.gui.folders.find((x) => x._title === 'Status');
    if (status) this.gui.$children.insertBefore(f.domElement, status.domElement);
    f.add(time, 'date').name('Local date').disable().listen();
    f.add(time, 'day', 0, Math.ceil(daysPerYear) - 1, 1)
      .name('Day of year')
      .listen()
      .onChange((d: number) => callbacks.dayChanged(d));
    f.add(time, 'hours', 0, 24, 0.05)
      .name('Local time (h)')
      .listen()
      .onChange((h: number) => callbacks.hoursChanged(h));
    f.add(time, 'rate', TIME_RATES).name('Clock rate');
    f.add(time, 'exposure', 0.2, 4, 0.05)
      .name('Exposure')
      .onChange((e: number) => callbacks.exposureChanged(e));
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
