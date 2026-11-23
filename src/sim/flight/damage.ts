/**
 * Hits and damage at full fidelity (roadmap R2.6, decision 301): what a round, a
 * missile's burst or a bomb's or rocket's impact does to what is near it. Pure.
 *
 * - **Blast.** A warhead does its full effect within its lethal radius and (lethal / d)²
 *   of it beyond, out to its reach (`blast`). The radii are generous on purpose: the
 *   owner wants explosives a little more effective and spectacular than real ones.
 * - **Aircraft** take damage 0..1, summed: a 20 mm round 0.07 (about fourteen kill a
 *   fighter), a warhead its blast. At 1 an aircraft is destroyed; from DAMAGED it is
 *   damaged (it smokes, and turns home in R3).
 * - **Vehicles** (R2.8) take blast × explosive / hardness, at most 1, and 20 mm rounds
 *   by their type, summed per vehicle as for aircraft; at 1 a vehicle is destroyed.
 * - **Ground targets** (the campaign's sites and road edges) take a hit's amount
 *   `blast × explosive / (explosive + hardness)`, measured from the target's edge
 *   (`size` m from its point), which `DamageState` combines as independent chances.
 *   A bridge (hardness 300) is cut (0.5) by one 900 kg bomb within its lethal radius,
 *   or by three 230 kg bombs.
 */
import type { WarheadSpec } from '../air/stores';

/** Damage one 20 mm round does to an aircraft. */
export const ROUND_DAMAGE = 0.07;
/** Damage from which an aircraft counts as damaged. */
export const DAMAGED = 0.3;
/** The radius (m) a round or a fuze takes for an aircraft it has no figure for (a fighter's). */
export const AIRCRAFT_RADIUS = 6;

/** A warhead's effect at distance d (m): 1 within the lethal radius, (lethal / d)² to its reach. */
export function blast(w: Readonly<WarheadSpec>, d: number): number {
  if (d <= w.lethal) return 1;
  if (d >= w.reach) return 0;
  const k = w.lethal / d;
  return k * k;
}

/** A ground target as hits see it. */
export interface GroundTargetKind {
  /** Its extent from its point (m): a hit is measured from its edge. */
  size: number;
  /** kg of explosive that does half its damage within the lethal radius. */
  hardness: number;
  /**
   * Vehicles (R2.8, decision 334): damage summed per vehicle, a blast doing
   * explosive / hardness of it, at most 1, so a bomb kills outright within a radius;
   * and the damage a 20 mm round passing within `size` does. Sites and roads have neither.
   */
  vehicle?: { round: number };
}

/** Ground targets by the kind of site they are (the campaign's `TargetSite.kind` or a road). */
export const GROUND_TARGETS: Readonly<Record<string, GroundTargetKind>> = {
  bridge: { size: 25, hardness: 300 },
  road: { size: 15, hardness: 120 },
  'supply-depot': { size: 60, hardness: 150 },
  'fuel-depot': { size: 60, hardness: 100 },
  refinery: { size: 80, hardness: 150 },
  'rail-yard': { size: 80, hardness: 200 },
  factory: { size: 60, hardness: 250 },
  'power-plant': { size: 60, hardness: 250 },
  default: { size: 50, hardness: 200 },
};

/** The amount (0..1) a warhead bursting `d` m from a ground target's point does to it. */
export function groundDamage(
  w: Readonly<WarheadSpec>,
  d: number,
  target: Readonly<GroundTargetKind>,
): number {
  const b = blast(w, Math.max(0, d - target.size));
  if (target.vehicle) return Math.min(1, (b * w.explosive) / target.hardness);
  return b * (w.explosive / (w.explosive + target.hardness));
}
