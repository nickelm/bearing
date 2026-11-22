/**
 * Missiles in flight (decision 297; visual-style Part I, Aircraft): each drawn as its
 * store's model along its velocity and a short warm flame at its tail while the motor burns.
 * Its trail, by its motor's smoke, is the effects system's (decisions 326, 329, 330); so is a
 * burning wreck's fire and smoke. Placed camera-relative each frame (rule 4).
 */
import {
  AdditiveBlending,
  ConeGeometry,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Group } from 'three/webgpu';
import { float, positionLocal, vec3 } from 'three/tsl';
import { Quatd } from '../../../core/quat';
import { Vec3d } from '../../../core/vec3d';
/**
 * Something in flight the view draws (decisions 297, 299): a missile, a bomb or a rocket,
 * keyed by the sim's own object, with the store model it shows and whether a motor burns.
 */
export interface Flying {
  key: object;
  /** The store whose model it shows (`store-<id>`), or another model spec id. */
  model: string;
  pos: Readonly<Vec3d>;
  vel: Readonly<Vec3d>;
  burning: boolean;
}
import type { PlanetLighting } from '../lighting/planetLighting';
import type { EffectsSystem } from '../effects/effectsSystem';
import { trailOf } from '../effects/weapons';
import { AircraftView } from './aircraftView';
import { storeModel } from './storeMounts';
import { MODEL_SPECS } from '../../common/models/library';

interface View {
  view: AircraftView;
  flame: Mesh;
}

export class MissileViews {
  private readonly views = new Map<object, View>();
  private readonly flameGeo: ConeGeometry;
  private readonly flameMat: MeshBasicNodeMaterial;

  /** Small ids for the effects' emitter keys, by the sim's own object. */
  private readonly ids = new WeakMap<object, number>();
  private nextId = 0;

  constructor(
    private readonly vehicles: Group,
    private readonly lighting: PlanetLighting,
    private readonly radius: number,
    /** Draws the trails: missiles' by their motors, wrecks' fire and smoke (decisions 326, 330). */
    private readonly effects: EffectsSystem,
  ) {
    this.flameGeo = new ConeGeometry(0.09, 1, 6, 1, true);
    this.flameGeo.translate(0, -0.5, 0);
    this.flameGeo.rotateZ(-Math.PI / 2);
    this.flameMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    const along = positionLocal.x.negate().clamp(0, 1);
    this.flameMat.colorNode = vec3(1.0, 0.55, 0.15).mul(float(3).sub(along.mul(2)));
    this.flameMat.opacityNode = float(1).sub(along).mul(0.9);
  }

  /**
   * Draws `missiles` for the frame at game time t from `eye`: views for new ones, gone
   * for ended ones, trails from the effects system; `groundAt` lays their shadows.
   */
  place(
    missiles: readonly Flying[],
    _t: number,
    eye: Readonly<Vec3d>,
    sun: Readonly<Vec3d>,
    radPerPixel: number,
    groundAt: (dir: Readonly<Vec3d>) => number,
  ): void {
    const live = new Set(missiles.map((x) => x.key));
    for (const [k, v] of this.views) if (!live.has(k)) this.drop(k, v);
    for (const ms of missiles) {
      let v = this.views.get(ms.key);
      if (!v) {
        const spec = storeModel(ms.model) ?? MODEL_SPECS[ms.model];
        if (!spec) continue;
        const view = new AircraftView(spec, [0, 0, 0], this.lighting);
        view.planetRadius = this.radius;
        const flame = new Mesh(this.flameGeo, this.flameMat);
        flame.frustumCulled = false;
        // At the tail: the model's rearmost point.
        flame.position.set(tailOf(spec), 0, 0);
        view.group.add(flame);
        this.vehicles.add(view.group, view.shadowMesh);
        v = { view, flame };
        this.views.set(ms.key, v);
      }
      const speed = ms.vel.length();
      const fwd = ms.vel.clone().scale(1 / Math.max(1, speed));
      const up = ms.pos.clone().normalize();
      const right = fwd.clone().cross(up);
      if (right.length() < 1e-6) right.set(0, 1, 0);
      right.normalize();
      const down = fwd.clone().cross(right).normalize();
      v.view.sun.copy(sun);
      v.view.radPerPixel = radPerPixel;
      v.view.update(
        {
          pos: ms.pos,
          q: Quatd.fromAxes(fwd, right, down),
          elevator: 0,
          aileron: 0,
          rudder: 0,
          gear: 0,
          speedbrake: 0,
          afterburner: 0,
          flaps: 0,
          groundHeight: groundAt(up),
        },
        eye,
      );
      v.flame.visible = ms.burning;
      v.flame.scale.set(1.6, 1, 1);
      let id = this.ids.get(ms.key);
      if (id === undefined) this.ids.set(ms.key, (id = this.nextId++));
      const trail = trailOf(ms.model);
      if (trail === 'wreck') this.effects.trackAircraft(`wreck${id}`, ms.pos, ms.vel, 'burning');
      else this.effects.trackMissile(`${id}`, trail, ms.burning, ms.pos, ms.vel);
    }
  }

  /** Removes every missile (their trails stop with them). */
  clear(): void {
    for (const [k, v] of this.views) this.drop(k, v);
  }

  dispose(): void {
    this.clear();
    this.flameGeo.dispose();
    this.flameMat.dispose();
  }

  private drop(k: object, v: View): void {
    this.vehicles.remove(v.view.group, v.view.shadowMesh);
    v.view.dispose();
    this.views.delete(k);
  }
}

/** The rearmost x of a store's model (m): where its motor's flame starts. */
function tailOf(spec: { parts: readonly unknown[] }): number {
  let x = 0;
  for (const p of spec.parts as { from?: number[]; to?: number[]; stations?: { x: number }[] }[]) {
    for (const v of [p.from?.[0], p.to?.[0], ...(p.stations ?? []).map((q) => q.x)])
      if (typeof v === 'number') x = Math.min(x, v);
  }
  return x;
}

/** What a stores rack has in flight, as the view draws it: missiles, bombs and rockets. */
export function flyingOf(rack: {
  missiles: readonly {
    store: string;
    pos: Readonly<Vec3d>;
    vel: Readonly<Vec3d>;
    burning: boolean;
  }[];
  ordnance: readonly {
    store: string;
    kind: 'bomb' | 'rocket';
    pos: Readonly<Vec3d>;
    vel: Readonly<Vec3d>;
    age: number;
    ballistics: { burn: number };
  }[];
}): Flying[] {
  const out: Flying[] = rack.missiles.map((m) => ({
    key: m,
    model: m.store,
    pos: m.pos,
    vel: m.vel,
    burning: m.burning,
  }));
  for (const p of rack.ordnance)
    out.push({
      key: p,
      model: p.kind === 'rocket' ? 'rocket' : p.store,
      pos: p.pos,
      vel: p.vel,
      burning: p.age < p.ballistics.burn,
    });
  return out;
}
