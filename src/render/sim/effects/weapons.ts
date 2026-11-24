/**
 * What the weapons show in the effects system (Proposal 0011, decisions 326, 329): a store's
 * motor smoke (`smoke` in the stores catalog) decides its trail, its warhead its explosion.
 */
import { STORES } from '../../../sim/air/stores';
import type { MotorKind } from '../../../sim/effects/events';
import { Vec3d } from '../../../core/vec3d';
import type { GunSpec } from '../../../sim/flight/gun';
import { modelToBody } from '../../../sim/flight/rigidBody';
import type { EffectsSystem } from './effectsSystem';

/** What a drawn flying thing trails: a motor's smoke, a wreck's fire, or nothing. */
export function trailOf(model: string): MotorKind | 'wreck' {
  // A rocket in flight is drawn as `rocket`: the pods' rockets.
  if (model === 'rocket') {
    const pod = Object.values(STORES).find((s) => s.rocket);
    return pod?.smoke ?? 'solid';
  }
  const s = STORES[model];
  if (s) return s.smoke ?? 'none';
  if (model.startsWith('store-')) return 'none';
  return 'wreck';
}

/** A store's explosive (kg), from its warhead, or a share of its mass. */
export function explosiveOf(store: string, mass: number): number {
  return STORES[store]?.warhead?.explosive ?? mass * 0.4;
}

/**
 * The gun's effects for one frame (decision 339): while it fires, smoke and flash at the
 * muzzle (a 30 mm cannon's thick cloud, a 20 mm gun's light one), and a kick of dirt where
 * each round struck the ground since the last frame. `key` names the aircraft.
 */
export function gunEffects(
  effects: EffectsSystem,
  key: string,
  rack: {
    gun: { spec: Readonly<GunSpec> } | null;
    gunFiring: boolean;
    roundImpacts: { at: Vec3d; time: number }[];
  },
  model: { pos: Readonly<Vec3d>; vel: Readonly<Vec3d>; q: { rotate(v: Vec3d): Vec3d } },
  cg: readonly [number, number, number],
): void {
  const g = rack.gun;
  const impacts = rack.roundImpacts.splice(0);
  if (!g) return;
  const cannon = g.spec.rate * g.spec.roundMass * g.spec.muzzleVelocity > CANNON_MOMENTUM;
  if (rack.gunFiring) {
    const pos = model.pos.clone().add(model.q.rotate(modelToBody(g.spec.at, cg)));
    const dir = model.q.rotate(new Vec3d(1, 0, 0));
    effects.track(`gun:${key}`, cannon ? 'cannon-smoke' : 'gun-smoke', {
      pos,
      vel: model.vel,
      dir,
    });
  }
  for (const i of impacts) effects.roundImpact(i.at, cannon ? 1.6 : 1);
}

/** Rounds' momentum per second (kg·m/s²) above which a gun is a cannon for its smoke (the A-15's 28,000). */
const CANNON_MOMENTUM = 20_000;
