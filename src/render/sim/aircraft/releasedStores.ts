/**
 * Stores that leave their pylons and fall (decision 294): a jettisoned tank drops away
 * from the aircraft, tumbling, until it reaches the drawn ground or a minute has passed.
 * Each falls by `stepFalling` (sim/flight/ballistics.ts) and is drawn as its own model
 * with its shadow (an `AircraftView` of the store's spec), placed camera-relative.
 */
import type { Group } from 'three/webgpu';
import { Quatd } from '../../../core/quat';
import { Vec3d } from '../../../core/vec3d';
import { STORES } from '../../../sim/air/stores';
import type { StationLoad } from '../../../sim/air/stores';
import { stepFalling } from '../../../sim/flight/ballistics';
import type { FallingStore } from '../../../sim/flight/ballistics';
import { modelToBody } from '../../../sim/flight/rigidBody';
import type { PlanetLighting } from '../lighting/planetLighting';
import { AircraftView } from './aircraftView';
import { storeModel } from './storeMounts';

/** How long a released store is followed at most (s). */
const MAX_FALL = 60;
/** Step of the fall (s). */
const STEP = 1 / 60;

interface Falling {
  store: FallingStore;
  view: AircraftView;
  age: number;
}

export class ReleasedStores {
  private readonly falling: Falling[] = [];
  private acc = 0;

  constructor(
    private readonly vehicles: Group,
    private readonly lighting: PlanetLighting,
    private readonly radius: number,
  ) {}

  /** How many are falling. */
  get count(): number {
    return this.falling.length;
  }

  /**
   * Releases `load` from an aircraft at `pos` with `vel` and attitude `q`, its CG at
   * `cg` in the model's frame; `mass` is what the store weighs now (a tank with its fuel).
   */
  release(
    load: StationLoad,
    aircraft: { pos: Readonly<Vec3d>; vel: Readonly<Vec3d>; q: Readonly<Quatd> },
    cg: readonly [number, number, number],
    mass: number,
  ): void {
    const spec = storeModel(load.store);
    const s = STORES[load.store];
    if (!spec || !s) return;
    const at = aircraft.q.rotate(modelToBody(load.at, cg));
    const down = aircraft.q.rotate(new Vec3d(0, 0, 1));
    const store: FallingStore = {
      pos: aircraft.pos.clone().add(at),
      // Pushed clear of the pylon, 2 m/s down the aircraft's own axis.
      vel: aircraft.vel.clone().addScaled(down, 2),
      q: new Quatd().copy(aircraft.q),
      mass,
      dragArea: s.dragArea,
      tumble: s.kind === 'tank' ? [0.25, -0.5, 0.12] : [0, -0.05, 0],
    };
    const view = new AircraftView(spec, [0, 0, 0], this.lighting);
    view.planetRadius = this.radius;
    this.vehicles.add(view.group, view.shadowMesh);
    this.falling.push({ store, view, age: 0 });
  }

  /** Steps the falls by `dt` game seconds; a store at the ground (`groundAt`, m) goes. */
  update(dt: number, groundAt: (dir: Readonly<Vec3d>) => number): void {
    this.acc += Math.min(dt, 0.5);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (const f of this.falling) {
        stepFalling(f.store, STEP, this.radius);
        f.age += STEP;
      }
    }
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i]!;
      const dir = f.store.pos.clone().normalize();
      const h = f.store.pos.length() - this.radius;
      if (f.age > MAX_FALL || h <= groundAt(dir)) this.remove(i);
    }
  }

  /** Places them camera-relative for the frame (rule 4). */
  place(
    eye: Readonly<Vec3d>,
    sun: Readonly<Vec3d>,
    radPerPixel: number,
    groundAt: (dir: Readonly<Vec3d>) => number,
  ): void {
    for (const f of this.falling) {
      f.view.sun.copy(sun);
      f.view.radPerPixel = radPerPixel;
      f.view.update(
        {
          pos: f.store.pos,
          q: f.store.q,
          elevator: 0,
          aileron: 0,
          rudder: 0,
          gear: 0,
          speedbrake: 0,
          afterburner: 0,
          flaps: 0,
          groundHeight: groundAt(f.store.pos.clone().normalize()),
        },
        eye,
      );
    }
  }

  /** Removes every falling store. */
  clear(): void {
    for (let i = this.falling.length - 1; i >= 0; i--) this.remove(i);
  }

  private remove(i: number): void {
    const f = this.falling[i]!;
    this.vehicles.remove(f.view.group, f.view.shadowMesh);
    f.view.dispose();
    this.falling.splice(i, 1);
  }
}
