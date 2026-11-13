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
 * `model` names a spec in render/common/models/specs/ where one exists; the
 * other types get models later (V3, V4).
 */
import type { Side } from '../../campaign/cast';
import { HOUR, KM, KNOT, MINUTE } from '../../core/units';

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
  /** Model spec id (render/common/models/specs/<id>.json), or null until it has one. */
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

const AA = (stores: string): Loadout => ({ id: 'air-to-air', stores, radiusFactor: 1 });
const load = (id: string, stores: string, radiusFactor = 1): Loadout => ({
  id,
  stores,
  radiusFactor,
});

type Spec = Omit<AircraftType, 'helicopter' | 'carrier' | 'crew' | 'turnaround'> &
  Partial<Pick<AircraftType, 'helicopter' | 'carrier' | 'crew' | 'turnaround'>>;

function type(s: Spec): AircraftType {
  return {
    helicopter: false,
    carrier: false,
    crew: 1,
    turnaround: 3 * HOUR,
    ...s,
  };
}

/** Every aircraft type, Alliance first, in a fixed order (ids are stable). */
export const AIRCRAFT_TYPES: readonly AircraftType[] = [
  // ---- Alliance ----
  type({
    id: 'f25',
    name: 'F-25 Peregrine',
    side: 'alliance',
    role: 'air-superiority',
    reference: 'F-15C',
    model: null,
    flightSize: 4,
    cruiseSpeed: 500 * KNOT,
    lowLevelSpeed: 480 * KNOT,
    maxSpeed: 1430 * KNOT,
    cruiseAltitude: 10_000,
    ceiling: 18_000,
    climbRate: 150,
    combatRadius: 1000 * KM,
    stationTime: 20 * MINUTE,
    fuel: 9_500,
    loadouts: [AA('4 medium-range and 4 short-range missiles, 3 tanks')],
  }),
  type({
    id: 'f21',
    name: 'F-21 Kestrel',
    side: 'alliance',
    role: 'multirole',
    reference: 'F-16C',
    model: 'alliance-fighter',
    flightSize: 4,
    cruiseSpeed: 480 * KNOT,
    lowLevelSpeed: 480 * KNOT,
    maxSpeed: 1150 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 15_000,
    climbRate: 110,
    combatRadius: 550 * KM,
    stationTime: 15 * MINUTE,
    fuel: 5_800,
    loadouts: [
      AA('2 medium-range and 4 short-range missiles, 2 tanks'),
      load('strike', '2 × 900 kg bombs, 2 short-range missiles, 2 tanks', 0.85),
    ],
  }),
  type({
    id: 'f28',
    name: 'F-28 Skua',
    side: 'alliance',
    role: 'air-superiority',
    reference: 'F-14A',
    model: null,
    carrier: true,
    crew: 2,
    flightSize: 2,
    cruiseSpeed: 480 * KNOT,
    lowLevelSpeed: 450 * KNOT,
    maxSpeed: 1340 * KNOT,
    cruiseAltitude: 10_000,
    ceiling: 16_000,
    climbRate: 120,
    combatRadius: 900 * KM,
    stationTime: 30 * MINUTE,
    fuel: 10_000,
    loadouts: [AA('6 long-range and 2 short-range missiles, 2 tanks')],
  }),
  type({
    id: 'f30',
    name: 'F-30 Petrel',
    side: 'alliance',
    role: 'multirole',
    reference: 'F/A-18C',
    model: null,
    carrier: true,
    flightSize: 2,
    cruiseSpeed: 470 * KNOT,
    lowLevelSpeed: 480 * KNOT,
    maxSpeed: 1030 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 15_000,
    climbRate: 100,
    combatRadius: 600 * KM,
    stationTime: 15 * MINUTE,
    fuel: 7_000,
    loadouts: [
      AA('4 medium-range and 2 short-range missiles, 2 tanks'),
      load('strike', '4 × 450 kg bombs, 2 short-range missiles, 2 tanks', 0.85),
    ],
  }),
  type({
    id: 'f124',
    name: 'F-124 Harrow',
    side: 'alliance',
    role: 'deep-strike',
    reference: 'F-111F',
    model: 'alliance-strike',
    crew: 2,
    flightSize: 4,
    cruiseSpeed: 490 * KNOT,
    lowLevelSpeed: 540 * KNOT,
    maxSpeed: 1250 * KNOT,
    cruiseAltitude: 8_000,
    ceiling: 17_000,
    climbRate: 50,
    combatRadius: 1300 * KM,
    stationTime: 5 * MINUTE,
    fuel: 15_000,
    turnaround: 4 * HOUR,
    loadouts: [load('strike', '4 × 900 kg guided bombs, 2 short-range missiles')],
  }),
  type({
    id: 'a14',
    name: 'A-14 Bittern',
    side: 'alliance',
    role: 'carrier-attack',
    reference: 'A-6E',
    model: null,
    carrier: true,
    crew: 2,
    flightSize: 2,
    cruiseSpeed: 410 * KNOT,
    lowLevelSpeed: 450 * KNOT,
    maxSpeed: 560 * KNOT,
    cruiseAltitude: 7_000,
    ceiling: 12_000,
    climbRate: 40,
    combatRadius: 1000 * KM,
    stationTime: 5 * MINUTE,
    fuel: 9_000,
    turnaround: 4 * HOUR,
    loadouts: [
      load('strike', '10 × 230 kg bombs, 2 tanks', 0.9),
      load('anti-ship', '2 anti-ship missiles, 2 tanks'),
    ],
  }),
  type({
    id: 'f130',
    name: 'F-130 Nightjar',
    side: 'alliance',
    role: 'stealth-strike',
    reference: 'F-117A',
    model: null,
    flightSize: 1,
    cruiseSpeed: 470 * KNOT,
    lowLevelSpeed: 450 * KNOT,
    maxSpeed: 540 * KNOT,
    cruiseAltitude: 8_000,
    ceiling: 13_000,
    climbRate: 40,
    combatRadius: 900 * KM,
    stationTime: 5 * MINUTE,
    fuel: 8_000,
    turnaround: 6 * HOUR,
    loadouts: [load('strike', '2 × 900 kg laser-guided bombs in the bay')],
  }),
  type({
    id: 'a15',
    name: 'A-15 Buzzard',
    side: 'alliance',
    role: 'cas',
    reference: 'A-10A',
    model: null,
    flightSize: 2,
    cruiseSpeed: 300 * KNOT,
    lowLevelSpeed: 300 * KNOT,
    maxSpeed: 380 * KNOT,
    cruiseAltitude: 4_500,
    ceiling: 9_000,
    climbRate: 30,
    combatRadius: 450 * KM,
    stationTime: 40 * MINUTE,
    fuel: 5_000,
    loadouts: [load('cas', 'cannon, 6 anti-tank missiles, 4 cluster bombs', 0.9)],
  }),
  type({
    id: 'f34g',
    name: 'F-34G Magpie',
    side: 'alliance',
    role: 'sead',
    reference: 'F-4G',
    model: null,
    crew: 2,
    flightSize: 2,
    cruiseSpeed: 490 * KNOT,
    lowLevelSpeed: 500 * KNOT,
    maxSpeed: 1200 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 17_000,
    climbRate: 80,
    combatRadius: 800 * KM,
    stationTime: 20 * MINUTE,
    fuel: 9_000,
    loadouts: [load('sead', '4 anti-radiation missiles, 3 tanks')],
  }),
  type({
    id: 'rf34',
    name: 'RF-34 Magpie',
    side: 'alliance',
    role: 'recon',
    reference: 'RF-4C',
    model: null,
    crew: 2,
    flightSize: 2,
    cruiseSpeed: 500 * KNOT,
    lowLevelSpeed: 540 * KNOT,
    maxSpeed: 1200 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 18_000,
    climbRate: 80,
    combatRadius: 900 * KM,
    stationTime: 5 * MINUTE,
    fuel: 9_000,
    loadouts: [load('recon', 'cameras and side-looking radar, 3 tanks')],
  }),
  type({
    id: 'b40',
    name: 'B-40 Albatross',
    side: 'alliance',
    role: 'bomber',
    reference: 'B-52G',
    model: null,
    crew: 5,
    flightSize: 3,
    cruiseSpeed: 450 * KNOT,
    lowLevelSpeed: 350 * KNOT,
    maxSpeed: 550 * KNOT,
    cruiseAltitude: 11_000,
    ceiling: 15_000,
    climbRate: 15,
    combatRadius: 4000 * KM,
    stationTime: 10 * MINUTE,
    fuel: 140_000,
    turnaround: 8 * HOUR,
    loadouts: [load('strike', '27 × 340 kg bombs, cruise missiles on the pylons')],
  }),
  type({
    id: 'e5',
    name: 'E-5 Watchman',
    side: 'alliance',
    role: 'aew',
    reference: 'E-3A',
    model: null,
    crew: 18,
    flightSize: 1,
    cruiseSpeed: 420 * KNOT,
    lowLevelSpeed: 300 * KNOT,
    maxSpeed: 460 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 12_500,
    climbRate: 15,
    combatRadius: 1600 * KM,
    stationTime: 6 * HOUR,
    fuel: 70_000,
    turnaround: 6 * HOUR,
    loadouts: [load('aew', 'rotodome surveillance radar')],
  }),
  type({
    id: 'kc40',
    name: 'KC-40 Pelican',
    side: 'alliance',
    role: 'tanker',
    reference: 'KC-135A',
    model: null,
    crew: 3,
    flightSize: 1,
    cruiseSpeed: 460 * KNOT,
    lowLevelSpeed: 300 * KNOT,
    maxSpeed: 500 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 15_000,
    climbRate: 15,
    combatRadius: 1800 * KM,
    stationTime: 2 * HOUR,
    fuel: 90_000,
    turnaround: 6 * HOUR,
    loadouts: [load('tanker', 'transfer fuel through a boom')],
  }),
  type({
    id: 'c150',
    name: 'C-150 Drover',
    side: 'alliance',
    role: 'airlift',
    reference: 'C-130H',
    model: null,
    crew: 5,
    flightSize: 2,
    cruiseSpeed: 290 * KNOT,
    lowLevelSpeed: 250 * KNOT,
    maxSpeed: 320 * KNOT,
    cruiseAltitude: 7_000,
    ceiling: 10_000,
    climbRate: 10,
    combatRadius: 1800 * KM,
    stationTime: 10 * MINUTE,
    fuel: 20_000,
    turnaround: 4 * HOUR,
    loadouts: [load('cargo', '18 t of cargo or 64 paratroops')],
  }),
  type({
    id: 'ah70',
    name: 'AH-70 Lancer',
    side: 'alliance',
    role: 'attack-helicopter',
    reference: 'AH-64A',
    model: null,
    helicopter: true,
    crew: 2,
    flightSize: 4,
    cruiseSpeed: 140 * KNOT,
    lowLevelSpeed: 130 * KNOT,
    maxSpeed: 160 * KNOT,
    cruiseAltitude: 150,
    ceiling: 6_000,
    climbRate: 5,
    combatRadius: 150 * KM,
    stationTime: 30 * MINUTE,
    fuel: 1_200,
    turnaround: 2 * HOUR,
    loadouts: [load('cas', '16 anti-tank missiles, 30 mm cannon')],
  }),
  type({
    id: 'ch60',
    name: 'CH-60 Mule',
    side: 'alliance',
    role: 'heavy-helicopter',
    reference: 'CH-47D',
    model: null,
    helicopter: true,
    crew: 3,
    flightSize: 2,
    cruiseSpeed: 130 * KNOT,
    lowLevelSpeed: 120 * KNOT,
    maxSpeed: 160 * KNOT,
    cruiseAltitude: 600,
    ceiling: 5_500,
    climbRate: 5,
    combatRadius: 300 * KM,
    stationTime: 10 * MINUTE,
    fuel: 3_000,
    turnaround: 2 * HOUR,
    loadouts: [load('sling', '10 t under the hook')],
  }),

  // ---- Pact ----
  type({
    id: 'vo33',
    name: 'Vo-33 Krechet',
    side: 'pact',
    role: 'air-superiority',
    reference: 'Su-27',
    model: null,
    flightSize: 4,
    cruiseSpeed: 490 * KNOT,
    lowLevelSpeed: 480 * KNOT,
    maxSpeed: 1350 * KNOT,
    cruiseAltitude: 10_000,
    ceiling: 18_500,
    climbRate: 150,
    combatRadius: 1300 * KM,
    stationTime: 20 * MINUTE,
    fuel: 9_400,
    loadouts: [AA('6 medium-range and 4 short-range missiles')],
  }),
  type({
    id: 'vo31',
    name: 'Vo-31 Strizh',
    side: 'pact',
    role: 'air-superiority',
    reference: 'MiG-29',
    model: 'pact-fighter',
    flightSize: 4,
    cruiseSpeed: 480 * KNOT,
    lowLevelSpeed: 480 * KNOT,
    maxSpeed: 1320 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 18_000,
    climbRate: 150,
    combatRadius: 700 * KM,
    stationTime: 15 * MINUTE,
    fuel: 5_000,
    loadouts: [AA('2 medium-range and 4 short-range missiles, centerline tank')],
  }),
  type({
    id: 'vo31k',
    name: 'Vo-31K Strizh',
    side: 'pact',
    role: 'air-superiority',
    reference: 'MiG-29K',
    model: 'pact-fighter',
    carrier: true,
    flightSize: 2,
    cruiseSpeed: 480 * KNOT,
    lowLevelSpeed: 480 * KNOT,
    maxSpeed: 1250 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 17_000,
    climbRate: 140,
    combatRadius: 750 * KM,
    stationTime: 20 * MINUTE,
    fuel: 5_500,
    loadouts: [
      AA('4 medium-range and 2 short-range missiles, centerline tank'),
      load('anti-ship', '2 anti-ship missiles, 2 short-range missiles', 0.8),
    ],
  }),
  type({
    id: 'ar23',
    name: 'Ar-23 Yastreb',
    side: 'pact',
    role: 'multirole',
    reference: 'MiG-23ML',
    model: null,
    flightSize: 4,
    cruiseSpeed: 470 * KNOT,
    lowLevelSpeed: 500 * KNOT,
    maxSpeed: 1350 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 17_000,
    climbRate: 120,
    combatRadius: 700 * KM,
    stationTime: 15 * MINUTE,
    fuel: 6_000,
    loadouts: [
      AA('2 medium-range and 4 short-range missiles, centerline tank'),
      load('strike', '4 × 500 kg bombs, centerline tank', 0.8),
    ],
  }),
  type({
    id: 'vo37',
    name: 'Vo-37 Grom',
    side: 'pact',
    role: 'deep-strike',
    reference: 'Su-24M',
    model: null,
    crew: 2,
    flightSize: 4,
    cruiseSpeed: 480 * KNOT,
    lowLevelSpeed: 560 * KNOT,
    maxSpeed: 1200 * KNOT,
    cruiseAltitude: 8_000,
    ceiling: 11_000,
    climbRate: 50,
    combatRadius: 1050 * KM,
    stationTime: 5 * MINUTE,
    fuel: 13_000,
    turnaround: 4 * HOUR,
    loadouts: [load('strike', '6 × 500 kg bombs, 2 tanks', 0.9)],
  }),
  type({
    id: 'vo37p',
    name: 'Vo-37P Grom',
    side: 'pact',
    role: 'sead',
    reference: 'Su-24M with anti-radiation missiles',
    model: null,
    crew: 2,
    flightSize: 2,
    cruiseSpeed: 480 * KNOT,
    lowLevelSpeed: 560 * KNOT,
    maxSpeed: 1200 * KNOT,
    cruiseAltitude: 8_000,
    ceiling: 11_000,
    climbRate: 50,
    combatRadius: 900 * KM,
    stationTime: 15 * MINUTE,
    fuel: 13_000,
    turnaround: 4 * HOUR,
    loadouts: [load('sead', '4 anti-radiation missiles, 2 tanks')],
  }),
  type({
    id: 'vo35',
    name: 'Vo-35 Molot',
    side: 'pact',
    role: 'cas',
    reference: 'Su-25',
    model: 'pact-strike',
    flightSize: 4,
    cruiseSpeed: 400 * KNOT,
    lowLevelSpeed: 400 * KNOT,
    maxSpeed: 520 * KNOT,
    cruiseAltitude: 4_000,
    ceiling: 7_000,
    climbRate: 40,
    combatRadius: 400 * KM,
    stationTime: 20 * MINUTE,
    fuel: 4_300,
    turnaround: 2 * HOUR,
    loadouts: [load('cas', 'rocket pods, 4 × 250 kg bombs, cannon', 0.9)],
  }),
  type({
    id: 'ra90',
    name: 'Ra-90 Medved',
    side: 'pact',
    role: 'bomber',
    reference: 'Tu-95MS',
    model: null,
    crew: 7,
    flightSize: 2,
    cruiseSpeed: 380 * KNOT,
    lowLevelSpeed: 300 * KNOT,
    maxSpeed: 500 * KNOT,
    cruiseAltitude: 10_000,
    ceiling: 12_000,
    climbRate: 10,
    combatRadius: 4000 * KM,
    stationTime: 10 * MINUTE,
    fuel: 80_000,
    turnaround: 8 * HOUR,
    loadouts: [load('strike', '6 cruise missiles in the bay')],
  }),
  type({
    id: 'ra84',
    name: 'Ra-84 Burya',
    side: 'pact',
    role: 'maritime-bomber',
    reference: 'Tu-22M3',
    model: null,
    crew: 4,
    flightSize: 4,
    cruiseSpeed: 490 * KNOT,
    lowLevelSpeed: 500 * KNOT,
    maxSpeed: 1100 * KNOT,
    cruiseAltitude: 10_000,
    ceiling: 13_000,
    climbRate: 30,
    combatRadius: 2400 * KM,
    stationTime: 5 * MINUTE,
    fuel: 50_000,
    turnaround: 6 * HOUR,
    loadouts: [
      load('anti-ship', '2 heavy anti-ship missiles'),
      load('strike', '24 × 250 kg bombs', 0.85),
    ],
  }),
  type({
    id: 'ra60',
    name: 'Ra-60 Zarya',
    side: 'pact',
    role: 'aew',
    reference: 'A-50',
    model: null,
    crew: 15,
    flightSize: 1,
    cruiseSpeed: 420 * KNOT,
    lowLevelSpeed: 300 * KNOT,
    maxSpeed: 450 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 12_000,
    climbRate: 12,
    combatRadius: 1000 * KM,
    stationTime: 4 * HOUR,
    fuel: 60_000,
    turnaround: 6 * HOUR,
    loadouts: [load('aew', 'rotodome surveillance radar')],
  }),
  type({
    id: 'ra78',
    name: 'Ra-78 Rodnik',
    side: 'pact',
    role: 'tanker',
    reference: 'Il-78',
    model: null,
    crew: 6,
    flightSize: 1,
    cruiseSpeed: 420 * KNOT,
    lowLevelSpeed: 300 * KNOT,
    maxSpeed: 460 * KNOT,
    cruiseAltitude: 9_000,
    ceiling: 12_000,
    climbRate: 12,
    combatRadius: 1500 * KM,
    stationTime: 2 * HOUR,
    fuel: 90_000,
    turnaround: 6 * HOUR,
    loadouts: [load('tanker', 'transfer fuel through three hose-and-drogue pods')],
  }),
  type({
    id: 'ra44',
    name: 'Ra-44 Vol',
    side: 'pact',
    role: 'airlift',
    reference: 'An-12',
    model: null,
    crew: 5,
    flightSize: 2,
    cruiseSpeed: 310 * KNOT,
    lowLevelSpeed: 250 * KNOT,
    maxSpeed: 350 * KNOT,
    cruiseAltitude: 7_500,
    ceiling: 10_000,
    climbRate: 10,
    combatRadius: 1500 * KM,
    stationTime: 10 * MINUTE,
    fuel: 18_000,
    turnaround: 4 * HOUR,
    loadouts: [load('cargo', '20 t of cargo or 60 paratroops')],
  }),
  type({
    id: 'ar45r',
    name: 'Ar-45R Sapsan',
    side: 'pact',
    role: 'recon',
    reference: 'MiG-25RB',
    model: null,
    flightSize: 1,
    cruiseSpeed: 1150 * KNOT,
    lowLevelSpeed: 600 * KNOT,
    maxSpeed: 1640 * KNOT,
    cruiseAltitude: 19_000,
    ceiling: 21_000,
    climbRate: 150,
    combatRadius: 900 * KM,
    stationTime: 5 * MINUTE,
    fuel: 14_000,
    loadouts: [load('recon', 'cameras and an ELINT pod')],
  }),
  type({
    id: 've28',
    name: 'Ve-28 Shershen',
    side: 'pact',
    role: 'attack-helicopter',
    reference: 'Mi-24V',
    model: null,
    helicopter: true,
    crew: 2,
    flightSize: 4,
    cruiseSpeed: 145 * KNOT,
    lowLevelSpeed: 135 * KNOT,
    maxSpeed: 180 * KNOT,
    cruiseAltitude: 150,
    ceiling: 4_500,
    climbRate: 5,
    combatRadius: 160 * KM,
    stationTime: 20 * MINUTE,
    fuel: 1_700,
    turnaround: 2 * HOUR,
    loadouts: [load('cas', '4 anti-tank missiles, rocket pods, 12.7 mm gun')],
  }),
  type({
    id: 've36',
    name: 'Ve-36 Bizon',
    side: 'pact',
    role: 'heavy-helicopter',
    reference: 'Mi-26',
    model: null,
    helicopter: true,
    crew: 5,
    flightSize: 1,
    cruiseSpeed: 135 * KNOT,
    lowLevelSpeed: 120 * KNOT,
    maxSpeed: 160 * KNOT,
    cruiseAltitude: 600,
    ceiling: 4_600,
    climbRate: 5,
    combatRadius: 300 * KM,
    stationTime: 10 * MINUTE,
    fuel: 6_000,
    turnaround: 2 * HOUR,
    loadouts: [load('sling', '20 t under the hook')],
  }),
];

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
