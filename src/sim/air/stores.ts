/**
 * Stores and pylons (roadmap R2.6, decision 285): the catalog of what pylons carry
 * (`src/data/stores.json`), each type's pylons (its bundle's `pylons`) and what a
 * loadout hangs on them (`stations`: pylon id → store id; a mirrored pylon carries it
 * on both sides). Pure data and its checks; no render imports, so the sim worker and
 * full fidelity read the same stores.
 */
import catalog from '../../data/stores.json';
import type { MotorKind } from '../effects/events';

/** A point in the model's frame (m). */
export type Vec3 = [number, number, number];

export type StoreKind = 'ir-missile' | 'radar-missile' | 'bomb' | 'rockets' | 'tank';
const KINDS: readonly StoreKind[] = ['ir-missile', 'radar-missile', 'bomb', 'rockets', 'tank'];

/** A guided missile's figures (decision 297). */
export interface MissileSpec {
  /** Seeker: how far it looks off its axis (rad), the cone it acquires in (rad), its lock range (m). */
  gimbal: number;
  cone: number;
  lockRange: number;
  /** Motor: thrust (N), burn time (s), propellant (kg, part of the store's mass). */
  thrust: number;
  burn: number;
  propellant: number;
  /** Proportional navigation's gain and the g it can pull at full dynamic pressure. */
  gain: number;
  maxG: number;
  /** Proximity fuze radius (m) and how long it flies before it self-destructs (s). */
  fuze: number;
  life: number;
}

/** A warhead (decision 301): its explosive (kg), its lethal radius and its reach (m). */
export interface WarheadSpec {
  explosive: number;
  lethal: number;
  reach: number;
}

/** An unguided rocket of a pod (decision 300). */
export interface RocketSpec {
  /** Rockets per pod. */
  count: number;
  /** One rocket's mass (kg, propellant included) and drag area (m²). */
  mass: number;
  dragArea: number;
  /** Motor: thrust (N), burn (s), propellant (kg). */
  thrust: number;
  burn: number;
  propellant: number;
  /** Rockets per second while the trigger is held. */
  ripple: number;
}

export interface StoreSpec {
  id: string;
  name: string;
  /** The label on the stores format and the HUD (decision 289). */
  short: string;
  /** The real store the numbers come from. */
  reference: string;
  kind: StoreKind;
  /** kg (a tank full). */
  mass: number;
  /** m. */
  length: number;
  diameter: number;
  /** m²: drag = dynamic pressure × dragArea. */
  dragArea: number;
  /** kg of fuel a full tank holds (part of `mass`); 0 for anything but a tank. */
  fuel: number;
  /** A missile's guidance and motor (decision 297), or null. */
  missile: MissileSpec | null;
  /** A rocket pod's rockets (decision 300), or null. */
  rocket: RocketSpec | null;
  /** Its warhead (a pod's: each rocket's; decision 301), or null. */
  warhead: WarheadSpec | null;
  /**
   * How its motor smokes (a pod's: each rocket's), which decides its trail in the effects
   * (Proposal 0011, decision 329); null for a store with no motor.
   */
  smoke: MotorKind | null;
}

const SMOKES: readonly MotorKind[] = ['solid', 'reduced-smoke', 'sam'];

function parseWarhead(raw: unknown, what: string): WarheadSpec {
  const o = raw as Record<string, unknown>;
  const n = (k: string) => {
    const v = o[k];
    if (typeof v !== 'number' || !(v > 0)) throw new StoresError(`${what}.${k}: not > 0`);
    return v;
  };
  const w = { explosive: n('explosive'), lethal: n('lethal'), reach: n('reach') };
  if (w.reach <= w.lethal) throw new StoresError(`${what}.reach: not beyond the lethal radius`);
  return w;
}

function parseRocket(raw: unknown, what: string): RocketSpec {
  const o = raw as Record<string, unknown>;
  const n = (k: string) => {
    const v = o[k];
    if (typeof v !== 'number' || !(v > 0)) throw new StoresError(`${what}.${k}: not > 0`);
    return v;
  };
  return {
    count: n('count'),
    mass: n('mass'),
    dragArea: n('dragArea'),
    thrust: n('thrust'),
    burn: n('burn'),
    propellant: n('propellant'),
    ripple: n('ripple'),
  };
}

function parseMissile(raw: unknown, what: string): MissileSpec {
  const o = raw as Record<string, Record<string, unknown> | number>;
  const n = (v: unknown, k: string) => {
    if (typeof v !== 'number' || !(v > 0)) throw new StoresError(`${what}.${k}: not > 0`);
    return v;
  };
  const sub = (k: string) => {
    const v = o[k];
    if (typeof v !== 'object' || v === null) throw new StoresError(`${what}.${k}: missing`);
    return v;
  };
  const seeker = sub('seeker');
  const motor = sub('motor');
  const guidance = sub('guidance');
  return {
    gimbal: (n(seeker.gimbalDeg, 'seeker.gimbalDeg') * Math.PI) / 180,
    cone: (n(seeker.coneDeg, 'seeker.coneDeg') * Math.PI) / 180,
    lockRange: n(seeker.range, 'seeker.range'),
    thrust: n(motor.thrust, 'motor.thrust'),
    burn: n(motor.burn, 'motor.burn'),
    propellant: n(motor.propellant, 'motor.propellant'),
    gain: n(guidance.gain, 'guidance.gain'),
    maxG: n(guidance.maxG, 'guidance.maxG'),
    fuze: n(o.fuze, 'fuze'),
    life: n(o.life, 'life'),
  };
}

export class StoresError extends Error {}

function parseCatalog(raw: unknown): Readonly<Record<string, StoreSpec>> {
  const stores = (raw as { stores?: Record<string, Record<string, unknown>> }).stores;
  if (!stores) throw new StoresError('stores.json: no stores');
  const out: Record<string, StoreSpec> = {};
  for (const [id, s] of Object.entries(stores)) {
    const num = (k: string) => {
      const v = s[k];
      if (typeof v !== 'number' || !(v > 0)) throw new StoresError(`stores.${id}.${k}: not > 0`);
      return v;
    };
    const kind = s.kind as StoreKind;
    if (!KINDS.includes(kind)) throw new StoresError(`stores.${id}.kind: ${String(s.kind)}`);
    const spec: StoreSpec = {
      id,
      name: String(s.name),
      short: String(s.short ?? id).toUpperCase(),
      reference: String(s.reference ?? ''),
      kind,
      mass: num('mass'),
      length: num('length'),
      diameter: num('diameter'),
      dragArea: num('dragArea'),
      fuel: kind === 'tank' ? num('fuel') : 0,
      missile: s.missile === undefined ? null : parseMissile(s.missile, `stores.${id}.missile`),
      rocket: s.rocket === undefined ? null : parseRocket(s.rocket, `stores.${id}.rocket`),
      warhead: s.warhead === undefined ? null : parseWarhead(s.warhead, `stores.${id}.warhead`),
      smoke: s.smoke === undefined ? null : (s.smoke as MotorKind),
    };
    if (spec.smoke !== null && !SMOKES.includes(spec.smoke))
      throw new StoresError(`stores.${id}.smoke: ${String(s.smoke)}`);
    if ((kind.endsWith('missile') || kind === 'rockets') && spec.smoke === null)
      throw new StoresError(
        `stores.${id}.smoke: a missile or a rocket pod names its motor's smoke`,
      );
    if (spec.missile && spec.missile.propellant >= spec.mass)
      throw new StoresError(`stores.${id}.missile.motor.propellant: not below its mass`);
    if (spec.fuel >= spec.mass) throw new StoresError(`stores.${id}.fuel: not below its mass`);
    out[id] = spec;
  }
  return out;
}

/** Every store by id. */
export const STORES: Readonly<Record<string, StoreSpec>> = parseCatalog(catalog);

/** The gun's id among the weapons (a weapon selection, an expended count of rounds; decision 295). */
export const GUN = 'gun';

/** The master mode a weapon belongs to: missiles air-to-air, bombs and rockets air-to-ground; tanks none. */
export function weaponMode(store: string): 'air-to-air' | 'air-to-ground' | null {
  // The gun serves both; selected, it brings air-to-air (decision 295).
  if (store === GUN) return 'air-to-air';
  const k = STORES[store]?.kind;
  if (k === 'ir-missile' || k === 'radar-missile') return 'air-to-air';
  if (k === 'bomb' || k === 'rockets') return 'air-to-ground';
  return null;
}

/** A pylon of a type (its bundle's `pylons`), in the model's frame (x forward, y up, z right). */
export interface PylonSpec {
  id: string;
  /** Where the store's center hangs (m); a mirrored pylon's left twin is at z → −z. */
  at: Vec3;
  mirror: boolean;
  /** The stores it can carry. */
  carries: string[];
}

/** Parses a bundle's `pylons` (`what` names it in errors). */
export function parsePylons(raw: unknown, what: string): PylonSpec[] {
  if (!Array.isArray(raw)) throw new StoresError(`${what}: not a list`);
  const seen = new Set<string>();
  return raw.map((p, i) => {
    const o = p as Record<string, unknown>;
    const w = `${what}[${i}]`;
    if (typeof o.id !== 'string') throw new StoresError(`${w}.id: not a string`);
    if (seen.has(o.id)) throw new StoresError(`${w}.id: ${o.id} twice`);
    seen.add(o.id);
    const at = o.at;
    if (!Array.isArray(at) || at.length !== 3 || at.some((x) => typeof x !== 'number'))
      throw new StoresError(`${w}.at: not [x, y, z]`);
    const carries = o.carries;
    if (!Array.isArray(carries) || carries.length === 0)
      throw new StoresError(`${w}.carries: none`);
    for (const c of carries)
      if (typeof c !== 'string' || !STORES[c]) throw new StoresError(`${w}.carries: ${String(c)}`);
    return {
      id: o.id,
      at: [at[0], at[1], at[2]] as Vec3,
      mirror: o.mirror === true,
      carries: carries as string[],
    };
  });
}

/** One store on one pylon: which pylon, which side of a mirrored one, what. */
export interface StationLoad {
  /** `<pylon>` for a single pylon, `<pylon>.left` / `<pylon>.right` for a mirrored one. */
  station: string;
  pylon: string;
  store: string;
  /** Where it hangs (m, model frame). */
  at: Vec3;
}

/** Checks a loadout's stations against the pylons (`what` names it in errors). */
export function checkStations(
  stations: Readonly<Record<string, string>>,
  pylons: readonly PylonSpec[],
  what: string,
): void {
  for (const [pylon, store] of Object.entries(stations)) {
    const p = pylons.find((x) => x.id === pylon);
    if (!p) throw new StoresError(`${what}: no pylon "${pylon}"`);
    if (!p.carries.includes(store))
      throw new StoresError(`${what}: pylon "${pylon}" does not carry "${store}"`);
  }
}

/** The stores a loadout hangs, station by station, in pylon order (right before left). */
export function stationLoads(
  stations: Readonly<Record<string, string>>,
  pylons: readonly PylonSpec[],
): StationLoad[] {
  const out: StationLoad[] = [];
  for (const p of pylons) {
    const store = stations[p.id];
    if (!store) continue;
    if (!p.mirror) {
      out.push({ station: p.id, pylon: p.id, store, at: [...p.at] as Vec3 });
      continue;
    }
    out.push({ station: `${p.id}.right`, pylon: p.id, store, at: [...p.at] as Vec3 });
    out.push({
      station: `${p.id}.left`,
      pylon: p.id,
      store,
      at: [p.at[0], p.at[1], -p.at[2]] as Vec3,
    });
  }
  return out;
}

/**
 * Stations for a flight data's standard load (store id → count; decision 288): each store
 * on the first pylons, in bundle order, that carry it and are still free, a mirrored
 * pylon taking two. What cannot be hung is left out.
 */
export function standardStations(
  pylons: readonly PylonSpec[],
  standard: Readonly<Record<string, number>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [store, count] of Object.entries(standard)) {
    let left = count;
    for (const p of pylons) {
      if (left <= 0) break;
      if (out[p.id] || !p.carries.includes(store)) continue;
      const n = p.mirror ? 2 : 1;
      if (n > left) continue;
      out[p.id] = store;
      left -= n;
    }
  }
  return out;
}

/** How many of each store the stations hang. */
export function storeCounts(loads: readonly StationLoad[]): Record<string, number> {
  const n: Record<string, number> = {};
  for (const l of loads) n[l.store] = (n[l.store] ?? 0) + 1;
  return n;
}

/** What is left of each store after `expended` (store id → count), never below zero. */
export function remainingStores(
  loads: readonly StationLoad[],
  expended: Readonly<Record<string, number>>,
): Record<string, number> {
  const n = storeCounts(loads);
  for (const [k, v] of Object.entries(expended)) if (k in n) n[k] = Math.max(0, n[k]! - v);
  return n;
}

/** The stores' mass (kg) and drag area (m²) of `counts`. */
export function storesLoad(counts: Readonly<Record<string, number>>): {
  mass: number;
  dragArea: number;
} {
  let mass = 0;
  let dragArea = 0;
  for (const [k, v] of Object.entries(counts)) {
    const s = STORES[k];
    if (!s) continue;
    mass += s.mass * v;
    dragArea += s.dragArea * v;
  }
  return { mass, dragArea };
}
