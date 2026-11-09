/**
 * lil-gui debug panel: world parameters, generation control, debug view
 * options and read-only status values.
 */
import GUI from 'lil-gui';

export interface WorldGuiParams {
  seed: string;
  /** Cells per cube-face edge. */
  resolution: number;
  plateCount: number;
  oceanFraction: number;
  reliefScale: number;
  temperatureOffset: number;
  moistureScale: number;
}

export interface ViewGuiParams {
  mode: string;
  exaggeration: number;
  wireframe: boolean;
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
}

export interface DebugGuiCallbacks {
  regenerate(): void;
  cancel(): void;
  viewChanged(view: ViewGuiParams): void;
  shapeChanged(view: ViewGuiParams): void;
}

export const RESOLUTIONS = [64, 128, 256, 512] as const;

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
    w.add(world, 'resolution', [...RESOLUTIONS])
      .name('Cells per face edge')
      .onFinishChange(regen);
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
      .name('Wireframe')
      .onChange(() => callbacks.viewChanged(view));

    const st = this.gui.addFolder('Status');
    st.add(this.status, 'generation').name('Generation').disable().listen();
    st.add(this.status, 'altitudeKm').name('Altitude (km)').decimals(1).disable().listen();
    st.add(this.status, 'latDeg').name('Latitude (°)').decimals(3).disable().listen();
    st.add(this.status, 'lonDeg').name('Longitude (°)').decimals(3).disable().listen();
    st.add(this.status, 'tiltDeg').name('Tilt (°)').decimals(1).disable().listen();
    st.add(this.status, 'backend').name('Backend').disable().listen();
    st.add(this.status, 'compute').name('GPU compute').disable().listen();
    st.add(this.status, 'worker').name('Sim worker').disable().listen();
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
