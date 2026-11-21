/**
 * Aircraft bundles (rule 17, decisions 230, 232; roadmap R1.7): every aircraft
 * type is one JSON file in src/data/models/aircraft/, holding its geometry (the
 * model spec the renderer builds), its flight data, avionics profile, air-war
 * entry, camera rig, pylons and calibration. This is the one loader: the sim
 * worker and the renderer both read types through it, and nothing about a type
 * lives in code.
 *
 * Blocks (all optional; `bundleGaps` lists what a type lacks):
 *
 * - `parts`, `groups`, `rotors`, `emissives`: geometry (render/common/models/spec.ts).
 *   A bundle without parts may name another bundle's geometry in `model` (a
 *   variant such as the Vo-31K).
 * - `flight`: flight-model tables (sim/flight/flightSpec.ts).
 * - `airWar`: the air war's entry. Units are named in the keys and converted
 *   here (rule 1): speeds in knots (`…Kt`), the combat radius in km, the station
 *   time in minutes and the turnaround in hours; altitudes (m), the climb rate
 *   (m/s) and fuel (kg) are SI already. `order` is the type's place in the table,
 *   which the order of battle depends on.
 * - `avionics`: the avionics profile (decision 224); the radar's range in km
 *   and its scan limits in degrees.
 * - `rig`: the chase camera's rig: a fast jet's numbers (field of view in
 *   degrees), or `{ "kind": "helicopter" }` for the rig scaled by the main rotor.
 * - `pylons`, `calibration`: R2.6 and R2.2 fill them.
 */
import { checkStations, parsePylons, stationLoads, STORES, StoresError } from './stores';
import type { PylonSpec } from './stores';
import { HOUR, KM, KNOT, MINUTE } from '../../core/units';
import type { AvionicsProfile } from '../avionics/profiles';
import type { AircraftRole, AircraftType, Loadout } from './aircraft';

const DEG = Math.PI / 180;

const files = import.meta.glob<unknown>('../../data/models/aircraft/*.json', {
  eager: true,
  import: 'default',
});

/** A chase-camera rig as a bundle gives it (render/sim/camera/chaseCamera.ts builds it). */
export type RigSpec =
  | {
      kind: 'fast-jet';
      distance: number;
      height: number;
      groundDistance: number;
      groundHeight: number;
      rotation: number;
      stretch: number;
      stretchPerAccel: number;
      /** Vertical field of view (rad). */
      fov: number;
    }
  | { kind: 'helicopter' };

export interface AircraftBundle {
  /** File name without .json: the model spec id. */
  id: string;
  name: string;
  /** Model class (polygon budget). */
  class: string;
  /** Camouflage scheme. */
  scheme: string | null;
  /** The spec whose geometry draws it: its own id, the `model` it names, or null. */
  geometry: string | null;
  hasFlight: boolean;
  hasRotors: boolean;
  airWar: AircraftType | null;
  /** The air-war entry's place in the table. */
  order: number | null;
  avionics: AvionicsProfile | null;
  rig: RigSpec | null;
  /** Its pylons (decision 285), or null. */
  pylons: PylonSpec[] | null;
  calibration: Record<string, unknown> | null;
}

export class BundleError extends Error {}

type Json = Record<string, unknown>;

function obj(v: unknown, what: string): Json {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new BundleError(`${what}: not an object`);
  return v as Json;
}

function num(o: Json, key: string, what: string, fallback?: number): number {
  const v = o[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new BundleError(`${what}.${key}: not a number`);
  return v;
}

function str(o: Json, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0)
    throw new BundleError(`${what}.${key}: not a string`);
  return v;
}

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new BundleError(`${what}: not a list of strings`);
  }
  return v as string[];
}

function bool(o: Json, key: string, what: string, fallback: boolean): boolean {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new BundleError(`${what}.${key}: not a boolean`);
  return v;
}

function parseAirWar(raw: unknown, name: string, geometry: string | null, what: string) {
  const o = obj(raw, what);
  const side = str(o, 'side', what);
  if (side !== 'alliance' && side !== 'pact') throw new BundleError(`${what}.side: ${side}`);
  if (!Array.isArray(o.loadouts) || o.loadouts.length === 0) {
    throw new BundleError(`${what}.loadouts: none`);
  }
  const loadouts: Loadout[] = o.loadouts.map((l, i) => {
    const lo = obj(l, `${what}.loadouts[${i}]`);
    const loadout: Loadout = {
      id: str(lo, 'id', `${what}.loadouts[${i}]`),
      stores: str(lo, 'stores', `${what}.loadouts[${i}]`),
      radiusFactor: num(lo, 'radiusFactor', `${what}.loadouts[${i}]`),
    };
    if (lo.stations !== undefined) {
      const st = obj(lo.stations, `${what}.loadouts[${i}].stations`);
      for (const [k, v] of Object.entries(st))
        if (typeof v !== 'string') throw new BundleError(`${what}.loadouts[${i}].stations.${k}`);
      loadout.stations = st as Record<string, string>;
    }
    return loadout;
  });
  const type: AircraftType = {
    id: str(o, 'id', what),
    name,
    side,
    role: str(o, 'role', what) as AircraftRole,
    reference: str(o, 'reference', what),
    model: geometry,
    helicopter: bool(o, 'helicopter', what, false),
    carrier: bool(o, 'carrier', what, false),
    crew: num(o, 'crew', what, 1),
    flightSize: num(o, 'flightSize', what),
    cruiseSpeed: num(o, 'cruiseSpeedKt', what) * KNOT,
    lowLevelSpeed: num(o, 'lowLevelSpeedKt', what) * KNOT,
    maxSpeed: num(o, 'maxSpeedKt', what) * KNOT,
    cruiseAltitude: num(o, 'cruiseAltitude', what),
    ceiling: num(o, 'ceiling', what),
    climbRate: num(o, 'climbRate', what),
    combatRadius: num(o, 'combatRadiusKm', what) * KM,
    stationTime: num(o, 'stationTimeMin', what) * MINUTE,
    fuel: num(o, 'fuel', what),
    turnaround: num(o, 'turnaroundH', what, 3) * HOUR,
    loadouts,
  };
  return { type, order: num(o, 'order', what) };
}

function parseAvionics(raw: unknown, what: string): AvionicsProfile {
  const o = obj(raw, what);
  const skin = str(o, 'skin', what);
  if (skin !== 'alliance' && skin !== 'pact') throw new BundleError(`${what}.skin: ${skin}`);
  const slots = obj(o.slots, `${what}.slots`);
  const profile: AvionicsProfile = {
    skin,
    roundScopes: bool(o, 'roundScopes', what, false),
    systems: strings(o.systems, `${what}.systems`) as AvionicsProfile['systems'],
    slots: Object.fromEntries(
      Object.entries(slots).map(([k, v]) => [k, strings(v, `${what}.slots.${k}`)]),
    ) as AvionicsProfile['slots'],
    rotorGauges: bool(o, 'rotorGauges', what, false),
    crew: strings(o.crew ?? [], `${what}.crew`),
  };
  if (o.hudRadar !== undefined) profile.hudRadar = bool(o, 'hudRadar', what, false);
  if (o.radar !== undefined) {
    const r = obj(o.radar, `${what}.radar`);
    const kind = str(r, 'kind', `${what}.radar`);
    if (kind !== 'pulse-doppler' && kind !== 'pulse')
      throw new BundleError(`${what}.radar.kind: ${kind}`);
    profile.radar = {
      kind,
      range: num(r, 'rangeKm', `${what}.radar`) * 1000,
      azimuth: num(r, 'azimuthDeg', `${what}.radar`) * DEG,
      elevation: num(r, 'elevationDeg', `${what}.radar`) * DEG,
      notch: num(r, 'notch', `${what}.radar`),
    };
  }
  return profile;
}

function parseRig(raw: unknown, what: string): RigSpec {
  const o = obj(raw, what);
  const kind = str(o, 'kind', what);
  if (kind === 'helicopter') return { kind };
  if (kind !== 'fast-jet') throw new BundleError(`${what}.kind: ${kind}`);
  return {
    kind,
    distance: num(o, 'distance', what),
    height: num(o, 'height', what),
    groundDistance: num(o, 'groundDistance', what),
    groundHeight: num(o, 'groundHeight', what),
    rotation: num(o, 'rotation', what),
    stretch: num(o, 'stretch', what),
    stretchPerAccel: num(o, 'stretchPerAccel', what),
    fov: num(o, 'fovDeg', what) * DEG,
  };
}

/** Parses one bundle file's JSON (exported for tests). */
export function parseBundle(raw: unknown, id: string): AircraftBundle {
  const o = obj(raw, id);
  const name = str(o, 'name', id);
  const parts = Array.isArray(o.parts) && o.parts.length > 0;
  const model = typeof o.model === 'string' ? o.model : null;
  if (parts && model) throw new BundleError(`${id}: has its own parts and names model "${model}"`);
  const geometry = parts ? id : model;
  const air = o.airWar === undefined ? null : parseAirWar(o.airWar, name, geometry, `${id}.airWar`);
  let pylons: PylonSpec[] | null;
  try {
    pylons = o.pylons === undefined ? null : parsePylons(o.pylons, `${id}.pylons`);
    // Every loadout's stations name the bundle's pylons and stores they carry.
    for (const l of air?.type.loadouts ?? []) {
      if (!l.stations) continue;
      if (!pylons) throw new StoresError(`${id}.airWar.loadouts.${l.id}: stations without pylons`);
      checkStations(l.stations, pylons, `${id}.airWar.loadouts.${l.id}`);
    }
  } catch (e) {
    if (e instanceof StoresError) throw new BundleError(e.message);
    throw e;
  }
  // Each loadout's fuel is the flight data's internal fuel plus its tanks (decision 294).
  const internal = (o.flight as { mass?: { fuel?: unknown } } | undefined)?.mass?.fuel;
  for (const l of air?.type.loadouts ?? []) {
    if (!l.stations || !pylons) continue;
    const loads = stationLoads(l.stations, pylons);
    const tanks = loads.filter((x) => STORES[x.store]?.kind === 'tank');
    l.tanks = {};
    for (const x of tanks) l.tanks[x.store] = (l.tanks[x.store] ?? 0) + 1;
    if (typeof internal === 'number')
      l.fuel = internal + tanks.reduce((s, x) => s + STORES[x.store]!.fuel, 0);
  }
  return {
    id,
    name,
    class: str(o, 'class', id),
    scheme: typeof o.scheme === 'string' ? o.scheme : null,
    geometry,
    hasFlight: o.flight !== undefined,
    hasRotors: Array.isArray(o.rotors) && o.rotors.length > 0,
    airWar: air?.type ?? null,
    order: air?.order ?? null,
    avionics: o.avionics === undefined ? null : parseAvionics(o.avionics, `${id}.avionics`),
    rig: o.rig === undefined ? null : parseRig(o.rig, `${id}.rig`),
    pylons,
    calibration: o.calibration === undefined ? null : obj(o.calibration, `${id}.calibration`),
  };
}

/** Every bundle by file id, in id order. */
export const AIRCRAFT_BUNDLES: Readonly<Record<string, AircraftBundle>> = Object.fromEntries(
  Object.entries(files)
    .map(([path, json]) => {
      const id = path.replace(/^.*\//, '').replace(/\.json$/, '');
      return [id, parseBundle(json, id)] as const;
    })
    .sort((a, b) => a[0].localeCompare(b[0])),
);

/** The bundle of an air-war type id (e.g. "f21"). */
export function bundleOfType(typeId: string): AircraftBundle {
  const b = Object.values(AIRCRAFT_BUNDLES).find((x) => x.airWar?.id === typeId);
  if (!b) throw new BundleError(`No bundle for aircraft type "${typeId}"`);
  return b;
}

/**
 * What a bundle lacks of the full set (rule 17): geometry, flight data, an
 * air-war entry, avionics, a rig, pylons and calibration.
 */
export function bundleGaps(b: AircraftBundle): string[] {
  const gaps: string[] = [];
  if (!b.geometry) gaps.push('geometry');
  if (!b.hasFlight) gaps.push('flight');
  if (!b.airWar) gaps.push('air war');
  if (!b.avionics) gaps.push('avionics');
  if (!b.rig) gaps.push('rig');
  if (!b.pylons) gaps.push('pylons');
  if (!b.calibration) gaps.push('calibration');
  return gaps;
}
