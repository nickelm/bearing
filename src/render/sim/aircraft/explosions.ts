/**
 * Explosions where bombs and rockets reach the ground and where wrecks strike it (decisions
 * 300, 301, 326, 330): the scene's effects system draws them. An impact explodes by its
 * warhead's explosive (flash, fireball, smoke, debris, scorch and ring); a wreck's strike is
 * a fuel fire that burns on.
 */
import type { Group } from 'three/webgpu';
import type { Vec3d } from '../../../core/vec3d';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { EffectsSystem } from '../effects/effectsSystem';
import { explosiveOf } from '../effects/weapons';
import type { Impact } from '../../../sim/flight/ordnance';
import { impactMass } from '../../../sim/flight/ordnance';

/** A wreck's fuel, as explosive (kg): its blast and the fire it leaves. */
const WRECK_EXPLOSIVE = 300;

export class Explosions {
  /** `vehicles` and `lighting` are kept for the callers' sake; the effects system draws. */
  constructor(
    _vehicles: Group,
    _lighting: PlanetLighting,
    private readonly effects: EffectsSystem,
  ) {}

  /** A bomb or rocket that reached the ground. */
  impact(x: Impact): void {
    this.effects.explode(x.at, explosiveOf(x.store, impactMass(x)), 'ground');
  }

  /** A wreck that struck the ground at `at`: it explodes and burns on. */
  wreck(at: Readonly<Vec3d>, _t?: number): void {
    this.effects.explode(at, WRECK_EXPLOSIVE, 'fuel');
  }

  /** An explosion of a store of `mass` (kg) at `at`: its explosive taken as 40% of it. */
  add(at: Readonly<Vec3d>, mass: number, _t?: number): void {
    this.effects.explode(at, mass * 0.4, 'ground');
  }

  /** The effects system places its own; kept for the callers' frame. */
  place(_t: number, _eye: Readonly<Vec3d>): void {}

  /** The effects system clears on a cut. */
  clear(): void {}

  dispose(): void {}
}
