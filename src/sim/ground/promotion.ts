/**
 * Minimal entity promotion (roadmap R2.8): a battalion near the player expands into a
 * few representative vehicles, deterministically from its seed, its strength and the
 * vehicles full fidelity has destroyed; their losses fold back into its strength.
 *
 * - **Rosters.** Each battalion kind stands for ROSTERS[kind] vehicles by type (a tank
 *   battalion 31 tanks, 6 trucks and an attached air defense vehicle). The roster's
 *   order interleaves the types by smooth weighted round robin, the rarer types weighted
 *   up so the first few vehicles show the mix: a vehicle's index in that order is its
 *   identity, the same at every promotion.
 * - **Strength.** A battalion's strength (1 at full) is the share of its roster alive:
 *   round(strength · N) vehicles. The vehicles full fidelity destroyed are `killed` by
 *   index; the aggregate war's anonymous losses come off the end of the order. So the
 *   alive vehicles are the first round(strength · N) of the order without the killed.
 * - **Promotion** shows the first PROMOTED[kind] alive vehicles, laid out round the
 *   battalion's anchor (a point and the heading toward the enemy): three company
 *   clusters along the front, trucks behind, the air defense vehicle in the middle,
 *   each vehicle's place and heading from rng(seed, "promotion") forked by its index.
 * - **Demotion.** A destroyed vehicle lowers the strength by exactly 1/N
 *   (`strengthAfterKill`) and joins `killed`, so it never comes back and the vehicle
 *   count drops by the same count. Nothing else is folded: the vehicles have no other
 *   state until R3.6 gives them behavior.
 *
 * Hits on vehicles (`VEHICLE_TARGETS`, decision 334): a warhead's blast measured from the
 * vehicle's edge (decision 301's falloff) times explosive / hardness, and 20 mm rounds
 * that pass within its size, summed per vehicle; at 1 it is destroyed.
 *
 * Headless and deterministic: the sim's types only.
 */
import type { Side } from '../../campaign/cast';
import { destination } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { rng } from '../../core/rng';
import type { Meters, Radians } from '../../core/units';
import type { GroundTargetKind } from '../flight/damage';
import type { BattalionKind } from './orbat';

export type VehicleType = 'tank' | 'ifv' | 'shorad' | 'truck';
export const VEHICLE_TYPES: readonly VehicleType[] = ['tank', 'ifv', 'shorad', 'truck'];

/** Vehicles a battalion of each kind stands for, by type. */
export const ROSTERS: Readonly<Record<BattalionKind, Partial<Record<VehicleType, number>>>> = {
  tank: { tank: 31, truck: 6, shorad: 1 },
  mechanized: { ifv: 30, truck: 6, shorad: 1 },
  'air-defense': { shorad: 12, truck: 8 },
  artillery: { truck: 24 },
  logistics: { truck: 40 },
};

/** Vehicles promoted at most per battalion ("a few representative vehicles"). */
export const PROMOTED: Readonly<Record<BattalionKind, number>> = {
  tank: 8,
  mechanized: 8,
  'air-defense': 4,
  artillery: 5,
  logistics: 6,
};

/** Model spec of each vehicle type (src/data/models). */
export const VEHICLE_MODELS: Readonly<Record<VehicleType, string>> = {
  tank: 'vehicle-tank',
  ifv: 'vehicle-ifv',
  shorad: 'vehicle-shorad',
  truck: 'vehicle-truck',
};

/** Camouflage scheme of each side's vehicles (Part I, Factions). */
export const VEHICLE_SCHEMES: Readonly<Record<Side, string>> = {
  alliance: 'alliance-woodland',
  pact: 'pact-tactical',
};

/**
 * Hits on vehicles by type (decision 334): a blast does explosive / hardness of a kill
 * within its lethal radius (falling off as decision 301's blast beyond), summed per
 * vehicle. A 230 kg bomb (87 kg) kills a tank within about 40 m of its edge, an infantry
 * fighting vehicle within 60 m and a truck anywhere in its reach; a rocket (1.5 kg)
 * within 7 m does 0.03 to a tank, 0.08 to an infantry fighting vehicle and 0.38 to a
 * truck. A 20 mm round that passes within the vehicle's size does `round`: a tank
 * shrugs off the gun (200 rounds), an infantry fighting vehicle takes about 17, a
 * truck 7.
 */
export const VEHICLE_TARGETS: Readonly<Record<VehicleType, GroundTargetKind>> = {
  tank: { size: 3.5, hardness: 50, vehicle: { round: 0.005 } },
  ifv: { size: 3.2, hardness: 20, vehicle: { round: 0.06 } },
  shorad: { size: 3.2, hardness: 12, vehicle: { round: 0.08 } },
  truck: { size: 3.5, hardness: 4, vehicle: { round: 0.15 } },
};

/** Vehicles in a battalion of `kind` at full strength. */
export function rosterSize(kind: BattalionKind): number {
  let n = 0;
  for (const c of Object.values(ROSTERS[kind])) n += c ?? 0;
  return n;
}

const orders = new Map<BattalionKind, VehicleType[]>();

/**
 * The roster of `kind` in its representative order (cached): smooth weighted round
 * robin over the types, each weighted at least N / PROMOTED so a rare type shows among
 * the first few; a type leaves the rotation when its count is used up.
 */
export function rosterOrder(kind: BattalionKind): readonly VehicleType[] {
  const cached = orders.get(kind);
  if (cached) return cached;
  const n = rosterSize(kind);
  const floor = n / PROMOTED[kind];
  const left = new Map<VehicleType, number>();
  const weight = new Map<VehicleType, number>();
  const current = new Map<VehicleType, number>();
  for (const t of VEHICLE_TYPES) {
    const c = ROSTERS[kind][t] ?? 0;
    if (c <= 0) continue;
    left.set(t, c);
    weight.set(t, Math.max(c, floor));
    current.set(t, 0);
  }
  const out: VehicleType[] = [];
  while (out.length < n) {
    let total = 0;
    let best: VehicleType | null = null;
    for (const t of VEHICLE_TYPES) {
      if ((left.get(t) ?? 0) <= 0) continue;
      const w = weight.get(t)!;
      total += w;
      current.set(t, current.get(t)! + w);
      if (best === null || current.get(t)! > current.get(best)!) best = t;
    }
    current.set(best!, current.get(best!)! - total);
    left.set(best!, left.get(best!)! - 1);
    out.push(best!);
  }
  orders.set(kind, out);
  return out;
}

/** Vehicles alive in a battalion: round(strength · N), within 0..N. */
export function aliveCount(kind: BattalionKind, strength: number): number {
  const n = rosterSize(kind);
  return Math.max(0, Math.min(n, Math.round(strength * n)));
}

/** The battalion's strength after full fidelity destroyed one of its vehicles: exactly one vehicle less. */
export function strengthAfterKill(kind: BattalionKind, strength: number): number {
  return Math.max(0, strength - 1 / rosterSize(kind));
}

/** Indices (in roster order) of a battalion's alive vehicles: the first round(strength · N) not killed. */
export function aliveVehicles(
  kind: BattalionKind,
  strength: number,
  killed: Iterable<number>,
): number[] {
  const dead = new Set(killed);
  const n = rosterSize(kind);
  const want = aliveCount(kind, strength);
  const out: number[] = [];
  for (let i = 0; i < n && out.length < want; i++) if (!dead.has(i)) out.push(i);
  return out;
}

/** What promotion needs of a battalion (the worker's `Battalion` or the ground picture's entry). */
export interface PromotableBattalion {
  id: number;
  side: Side;
  kind: BattalionKind;
  seed: number;
  strength: number;
  killed: readonly number[];
}

/** A promoted vehicle: its battalion, its index in the roster order, its type and where it stands. */
export interface PromotedVehicle {
  battalion: number;
  index: number;
  type: VehicleType;
  side: Side;
  /** Unit direction from the planet's center. */
  point: Dir;
  /** Heading of its hull (rad from north). */
  heading: Radians;
}

/** Company clusters along the front (m), the spread within one, and the trucks' and SHORAD's depth. */
export const COMPANY_SPACING: Meters = 450;
export const COMPANY_SPREAD: Meters = 140;
export const TRUCK_DEPTH: Meters = 350;
export const SHORAD_DEPTH: Meters = 200;

/**
 * The vehicles battalion b shows when promoted round `anchor` (its point; `heading` toward
 * the enemy), on a planet of radius R: the first PROMOTED alive vehicles, each placed from
 * its own index's stream so a vehicle stands where it stood at every promotion.
 */
export function promoteBattalion(
  b: Readonly<PromotableBattalion>,
  anchor: Readonly<Dir>,
  heading: Radians,
  R: Meters,
): PromotedVehicle[] {
  const order = rosterOrder(b.kind);
  const alive = aliveVehicles(b.kind, b.strength, b.killed).slice(0, PROMOTED[b.kind]);
  const root = rng(b.seed, 'promotion');
  return alive.map((index) => {
    const type = order[index]!;
    const r = root.fork(`v${index}`);
    // Forward (toward the enemy) and right offsets from the anchor (m).
    let fwd: number;
    let right: number;
    if (type === 'truck') {
      fwd = -TRUCK_DEPTH + r.range(-120, 120);
      right = r.range(-1.2, 1.2) * COMPANY_SPACING;
    } else if (type === 'shorad') {
      fwd = -SHORAD_DEPTH + r.range(-60, 60);
      right = r.range(-80, 80);
    } else {
      const company = (index % 3) - 1;
      fwd = r.range(-0.6, 0.6) * COMPANY_SPREAD;
      right = company * COMPANY_SPACING + r.range(-1, 1) * COMPANY_SPREAD;
    }
    const along = Math.hypot(fwd, right);
    const bearing = heading + Math.atan2(right, fwd);
    const point = along > 0 ? destination(anchor, bearing, along, R) : ([...anchor] as Dir);
    // Fighting vehicles face the enemy within 30°; trucks park anyhow.
    const spread = type === 'truck' ? Math.PI : 0.5;
    return {
      battalion: b.id,
      index,
      type,
      side: b.side,
      point,
      heading: heading + r.range(-spread, spread),
    };
  });
}

/** The hit id of a promoted vehicle (`StoresRack` ground targets and hits). */
export function vehicleKey(battalion: number, index: number): string {
  return `vehicle:${battalion}:${index}`;
}

/** The battalion and index a vehicle's hit id names, or null for another target. */
export function parseVehicleKey(key: string): { battalion: number; index: number } | null {
  const m = /^vehicle:(\d+):(\d+)$/.exec(key);
  return m ? { battalion: Number(m[1]), index: Number(m[2]) } : null;
}

/**
 * Damage on promoted vehicles while they are promoted (R2.8): each hit's amount added,
 * as for aircraft (decision 301); a vehicle at 1 is destroyed, once. Damage short of
 * that is not kept past demotion: the vehicle is whole or destroyed (R3 adds damaged).
 */
export class VehicleDamage {
  private readonly level = new Map<string, number>();
  private readonly dead = new Set<string>();

  /** Adds a hit's amount to vehicle `key`; true the moment it is destroyed. */
  hit(key: string, amount: number): boolean {
    if (this.dead.has(key) || !(amount > 0)) return false;
    const d = (this.level.get(key) ?? 0) + amount;
    if (d < 1) {
      this.level.set(key, d);
      return false;
    }
    this.level.delete(key);
    this.dead.add(key);
    return true;
  }

  damage(key: string): number {
    return this.dead.has(key) ? 1 : (this.level.get(key) ?? 0);
  }

  destroyed(key: string): boolean {
    return this.dead.has(key);
  }

  /** Forgets vehicle `key`'s damage short of destruction (its battalion was demoted). */
  forget(key: string): void {
    this.level.delete(key);
  }
}
