/**
 * What the weapons show in the effects system (Proposal 0011, decisions 326, 329): a store's
 * motor smoke (`smoke` in the stores catalog) decides its trail, its warhead its explosion.
 */
import { STORES } from '../../../sim/air/stores';
import type { MotorKind } from '../../../sim/effects/events';

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
