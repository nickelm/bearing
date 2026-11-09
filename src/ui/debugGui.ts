/**
 * lil-gui debug panel. Holds world parameters (only the seed for now), debug
 * view toggles and read-only status values.
 */
import GUI from 'lil-gui';

export interface DebugGuiParams {
  seed: string;
  subdivisions: number;
  wireframe: boolean;
}

export interface DebugGuiStatus {
  altitudeKm: number;
  latDeg: number;
  lonDeg: number;
  tiltDeg: number;
  backend: string;
  compute: string;
  worker: string;
}

export interface DebugGuiCallbacks {
  regenerate(params: DebugGuiParams): void;
  setSubdivisions(n: number): void;
  setWireframe(on: boolean): void;
}

export class DebugGui {
  readonly gui = new GUI({ title: 'Bearing' });
  readonly status: DebugGuiStatus = {
    altitudeKm: 0,
    latDeg: 0,
    lonDeg: 0,
    tiltDeg: 0,
    backend: '—',
    compute: 'pending',
    worker: 'pending',
  };

  constructor(
    readonly params: DebugGuiParams,
    callbacks: DebugGuiCallbacks,
  ) {
    const world = this.gui.addFolder('World');
    world.add(params, 'seed').name('Seed');
    world.add({ regenerate: () => callbacks.regenerate(params) }, 'regenerate').name('Regenerate');
    world
      .add(
        {
          randomize: () => {
            params.seed = randomSeed();
            this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
            callbacks.regenerate(params);
          },
        },
        'randomize',
      )
      .name('Random seed');

    const view = this.gui.addFolder('Debug view');
    view
      .add(params, 'subdivisions', 1, 256, 1)
      .name('Face subdivisions')
      .onFinishChange((n: number) => callbacks.setSubdivisions(n));
    view
      .add(params, 'wireframe')
      .name('Wireframe')
      .onChange((on: boolean) => callbacks.setWireframe(on));

    const st = this.gui.addFolder('Status');
    st.add(this.status, 'altitudeKm').name('Altitude (km)').decimals(1).disable().listen();
    st.add(this.status, 'latDeg').name('Latitude (°)').decimals(3).disable().listen();
    st.add(this.status, 'lonDeg').name('Longitude (°)').decimals(3).disable().listen();
    st.add(this.status, 'tiltDeg').name('Tilt (°)').decimals(1).disable().listen();
    st.add(this.status, 'backend').name('Backend').disable().listen();
    st.add(this.status, 'compute').name('GPU compute').disable().listen();
    st.add(this.status, 'worker').name('Sim worker').disable().listen();
  }
}

/** UI-only: picking a fresh seed is the one place randomness is meant to be non-deterministic. */
function randomSeed(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0]);
}
