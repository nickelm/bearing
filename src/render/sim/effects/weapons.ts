/**
 * What the weapons show in the effects system (Proposal 0011, decision 326): a store's motor
 * decides its trail, its warhead its explosion.
 *
 * The motor belongs in each weapon's specification (the proposal); until the stores catalog
 * carries it (`src/data/stores.json`, the main line's), this table names it per store. An
 * AIM-9M analog flies a reduced-smoke motor, the Pact's R-73 analog and the radar missile a
 * smoky one, rockets a smoky one.
 */
import { STORES } from '../../../sim/air/stores';
import type { MotorKind } from '../../../sim/effects/events';

/** Each store's motor; stores not named have none, or are not stores (a wreck's model). */
export const WEAPON_MOTORS: Readonly<Record<string, MotorKind>> = {
  srm: 'reduced-smoke',
  'srm-p': 'solid',
  mrm: 'solid',
  'rockets-19': 'solid',
  rocket: 'solid',
};

/** What a drawn flying thing trails: a motor's smoke, a wreck's fire, or nothing. */
export function trailOf(model: string): MotorKind | 'wreck' {
  const m = WEAPON_MOTORS[model];
  if (m) return m;
  if (model === 'rocket' || model.startsWith('store-') || STORES[model]) return 'none';
  return 'wreck';
}

/** A store's explosive (kg), from its warhead, or a share of its mass. */
export function explosiveOf(store: string, mass: number): number {
  return STORES[store]?.warhead?.explosive ?? mass * 0.4;
}
