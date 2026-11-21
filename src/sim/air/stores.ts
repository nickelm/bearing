/**
 * Stores and pylons (roadmap R2.6, decision 285): the catalog of what pylons carry
 * (`src/data/stores.json`), each type's pylons (its bundle's `pylons`) and what a
 * loadout hangs on them (`stations`: pylon id → store id; a mirrored pylon carries it
 * on both sides). Pure data and its checks; no render imports, so the sim worker and
 * full fidelity read the same stores.
 */
import catalog from '../../data/stores.json';

/** A point in the model's frame (m). */
export type Vec3 = [number, number, number];

export type StoreKind = 'ir-missile' | 'radar-missile' | 'bomb' | 'rockets' | 'tank';
const KINDS: readonly StoreKind[] = ['ir-missile', 'radar-missile', 'bomb', 'rockets', 'tank'];

export interface StoreSpec {
  id: string;
  name: string;
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
      reference: String(s.reference ?? ''),
      kind,
      mass: num('mass'),
      length: num('length'),
      diameter: num('diameter'),
      dragArea: num('dragArea'),
      fuel: kind === 'tank' ? num('fuel') : 0,
    };
    if (spec.fuel >= spec.mass) throw new StoresError(`stores.${id}.fuel: not below its mass`);
    out[id] = spec;
  }
  return out;
}

/** Every store by id. */
export const STORES: Readonly<Record<string, StoreSpec>> = parseCatalog(catalog);

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
