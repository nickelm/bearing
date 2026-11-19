/**
 * The aircraft type table for both sides (design, "Factions and Sides"; C2).
 * Fictional names and silhouettes; a real Cold War type is each one's
 * reference for role, performance and doctrine. All values are SI and real:
 * the cast's range factor (decision 51) scales only the fuel load, when a
 * mission is planned (route.ts), so speeds and climb rates stay real.
 *
 * Fuel model. Each type has a real combat radius for its typical profile and
 * the time it can spend on target or on station at that radius. Fuel flows are
 * multiples of a cruise flow (FLOW), and the cruise flow is the one that makes
 * that profile use exactly the usable fuel: out and back at cruise speed plus
 * the station time at loiter flow. A shorter trip leaves more station time.
 *
 * The types themselves are data: each is the `airWar` block of its aircraft
 * bundle (src/data/models/aircraft/, rule 17, R1.7). `model` names the spec
 * whose geometry draws it, where one exists.
 */
import type { Side } from '../../campaign/cast';
import { AIRCRAFT_BUNDLES } from './bundles';

export type AircraftRole =
  | 'air-superiority'
  | 'multirole'
  | 'deep-strike'
  | 'carrier-attack'
  | 'stealth-strike'
  | 'cas'
  | 'attack-helicopter'
  | 'sead'
  | 'bomber'
  | 'maritime-bomber'
  | 'aew'
  | 'tanker'
  | 'airlift'
  | 'heavy-helicopter'
  | 'recon';

export const AIRCRAFT_ROLES: readonly AircraftRole[] = [
  'air-superiority',
  'multirole',
  'deep-strike',
  'carrier-attack',
  'stealth-strike',
  'cas',
  'attack-helicopter',
  'sead',
  'bomber',
  'maritime-bomber',
  'aew',
  'tanker',
  'airlift',
  'heavy-helicopter',
  'recon',
];

/**
 * Roles only one side has: the A-6 and F-117 analogues (design), and the
 * Tu-22M analogue, since the Alliance's B-52 analogue flies maritime strikes too.
 */
export const ONE_SIDED_ROLES: Partial<Record<AircraftRole, Side>> = {
  'carrier-attack': 'alliance',
  'stealth-strike': 'alliance',
  'maritime-bomber': 'pact',
};

/** A store fit for a kind of mission. */
export interface Loadout {
  id: string;
  /** What it carries, for the mission panel. */
  stores: string;
  /** Combat radius with this load as a share of the type's radius (drag and weight). */
  radiusFactor: number;
}

export interface AircraftType {
  id: string;
  name: string;
  side: Side;
  role: AircraftRole;
  /** The real type it is modeled on. */
  reference: string;
  /** Model spec id (src/data/models/aircraft/<id>.json) of its geometry, or null until it has one. */
  model: string | null;
  helicopter: boolean;
  /** Flies from carriers. */
  carrier: boolean;
  crew: number;
  /** Usual aircraft per flight. */
  flightSize: number;
  /** True airspeed in cruise at cruiseAltitude, at low level, and the maximum (m/s). */
  cruiseSpeed: number;
  lowLevelSpeed: number;
  maxSpeed: number;
  /** Cruise altitude and service ceiling (m above sea level). */
  cruiseAltitude: number;
  ceiling: number;
  /** Mean climb and descent rates between the ground and cruise altitude (m/s). */
  climbRate: number;
  /** Real combat radius for the typical profile, before the range factor (m). */
  combatRadius: number;
  /** Time on target or on station at the combat radius (s). */
  stationTime: number;
  /** Internal plus usual external fuel (kg). */
  fuel: number;
  /** Ground turnaround between sorties (s). */
  turnaround: number;
  loadouts: Loadout[];
}

/** Fuel flow by flight regime, as a multiple of the cruise flow. */
export const FLOW = {
  ground: 0,
  climb: 2,
  cruise: 1,
  lowLevel: 1.8,
  loiter: 0.8,
  combat: 1.5,
  descent: 0.4,
} as const;
export type FlowRegime = keyof typeof FLOW;

/** Fuel kept back for diversion and holding. */
export const FUEL_RESERVE = 0.1;

/**
 * Every aircraft type, Alliance first, in a fixed order (ids are stable): the
 * air-war entries of the aircraft bundles (src/data/models/aircraft/, R1.7),
 * by their `order`.
 */
export const AIRCRAFT_TYPES: readonly AircraftType[] = (() => {
  const entries = Object.values(AIRCRAFT_BUNDLES)
    .filter((b) => b.airWar)
    .sort((x, y) => x.order! - y.order!);
  entries.forEach((b, i) => {
    if (b.order !== i) throw new Error(`Aircraft bundle ${b.id}: order ${b.order}, expected ${i}`);
  });
  const ids = new Set<string>();
  for (const b of entries) {
    if (ids.has(b.airWar!.id)) throw new Error(`Aircraft type id "${b.airWar!.id}" twice`);
    ids.add(b.airWar!.id);
  }
  return entries.map((b) => b.airWar!);
})();

const BY_ID = new Map(AIRCRAFT_TYPES.map((t) => [t.id, t]));

export function aircraftType(id: string): AircraftType {
  const t = BY_ID.get(id);
  if (!t) throw new Error(`Unknown aircraft type "${id}"`);
  return t;
}

/** Types of a side with a role, in table order; carrier types only if `carrier`. */
export function typesFor(side: Side, role: AircraftRole, carrier = false): AircraftType[] {
  return AIRCRAFT_TYPES.filter((t) => t.side === side && t.role === role && t.carrier === carrier);
}

/**
 * Cruise fuel flow (kg/s) with a loadout: the flow at which the type's typical
 * profile (out and back over its radius at cruise speed, plus its station time
 * at loiter flow) uses its usable fuel. Real, before the range factor.
 */
export function cruiseFlow(t: AircraftType, radiusFactor = 1): number {
  const usable = t.fuel * (1 - FUEL_RESERVE);
  const radius = t.combatRadius * radiusFactor;
  return usable / ((2 * radius) / t.cruiseSpeed + t.stationTime * FLOW.loiter);
}
