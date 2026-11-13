/**
 * The air order of battle at the outbreak (C2): squadrons at the placed
 * airbases and air wings on the carrier groups, with aircraft on strength,
 * aircraft available and base stocks. Built from the campaign input alone
 * (decision 52) and rng(seed, "orbat") forks, so it is the same world at any
 * time acceleration and for either viewing side.
 *
 * - **Airbases** get squadrons by kind: island fields multirole fighters (and
 *   Pact maritime bombers), forward fields close air support and attack
 *   helicopters, bomber bases bombers and tankers, and main bases a mix by
 *   depth behind the front: multirole and CAS near it, fighters and strike
 *   aircraft deeper, strike and fighters deepest. Main bases off any front get
 *   fighters.
 * - **Specials.** Every role a side has (AEW, tankers, airlift, reconnaissance,
 *   SEAD, heavy helicopters, the stealth strike aircraft) gets at least one
 *   squadron, at the deepest main base with the fewest squadrons.
 * - **Carrier air wings** (decision 56): an Alliance carrier carries a
 *   fighter squadron, two multirole squadrons and an all-weather attack
 *   squadron; a Pact carrier two squadrons of carrier fighters.
 * - **Strength.** Alliance squadrons and Pact regiments by role
 *   (STRENGTH); the Pact's regiments are larger (design: mass).
 * - **Stocks.** Fuel and munitions for STOCK_DAYS at SORTIES_PER_DAY per
 *   aircraft (CARRIER_STOCK_DAYS at sea); missions draw on them when planned.
 *   Resupply arrives with C3's convoys and airlift.
 */
import type { Side } from '../../campaign/cast';
import { rng } from '../../core/rng';
import type { Rng, WorldSeed } from '../../core/rng';
import type { CampaignInput } from '../command/campaignInput';
import { AIRCRAFT_TYPES, aircraftType, typesFor } from './aircraft';
import type { AircraftRole } from './aircraft';
import type { BaseRef } from './mission';

export interface Squadron {
  id: number;
  side: Side;
  name: string;
  /** Aircraft type id. */
  type: string;
  base: BaseRef;
  /** Aircraft on strength (losses lower it from C3 on) and aircraft ready to fly now. */
  aircraft: number;
  available: number;
}

export interface BaseStocks {
  /** Jet fuel (kg). */
  fuel: number;
  /** Munition loads (one per aircraft and armed sortie). */
  munitions: number;
}

export interface AirBaseRecord {
  ref: BaseRef;
  side: Side;
  name: string;
  /** Theater it mainly serves, or −1. */
  theater: number;
  squadrons: number[];
  stocks: BaseStocks;
}

export interface OrderOfBattle {
  squadrons: Squadron[];
  /** Airbases by id (Infrastructure.airbases order), then carrier groups by id. */
  bases: AirBaseRecord[];
}

export const STOCK_DAYS = 30;
export const CARRIER_STOCK_DAYS = 10;
export const SORTIES_PER_DAY = 2;
/** Main bases within this distance of the front's start line are front-line bases (m). */
export const FRONT_LINE_DEPTH = 150e3;
/** Main bases beyond this are deep bases (m). */
export const DEEP_DEPTH = 350e3;

/** Aircraft per squadron (Alliance) and per regiment (Pact). */
export const STRENGTH: Record<AircraftRole, Record<Side, number>> = {
  'air-superiority': { alliance: 18, pact: 30 },
  multirole: { alliance: 18, pact: 30 },
  'deep-strike': { alliance: 18, pact: 24 },
  'carrier-attack': { alliance: 10, pact: 10 },
  'stealth-strike': { alliance: 12, pact: 12 },
  cas: { alliance: 18, pact: 24 },
  'attack-helicopter': { alliance: 18, pact: 20 },
  sead: { alliance: 12, pact: 12 },
  bomber: { alliance: 12, pact: 16 },
  'maritime-bomber': { alliance: 12, pact: 18 },
  aew: { alliance: 4, pact: 4 },
  tanker: { alliance: 6, pact: 6 },
  airlift: { alliance: 12, pact: 12 },
  'heavy-helicopter': { alliance: 12, pact: 10 },
  recon: { alliance: 12, pact: 12 },
};

const UNIT_WORD: Record<AircraftRole, Record<Side, string>> = {
  'air-superiority': { alliance: 'Fighter', pact: 'Fighter' },
  multirole: { alliance: 'Fighter', pact: 'Fighter' },
  'deep-strike': { alliance: 'Strike', pact: 'Bomber' },
  'carrier-attack': { alliance: 'Attack', pact: 'Attack' },
  'stealth-strike': { alliance: 'Special Strike', pact: 'Special Strike' },
  cas: { alliance: 'Attack', pact: 'Assault' },
  'attack-helicopter': { alliance: 'Attack Helicopter', pact: 'Combat Helicopter' },
  sead: { alliance: 'Defense Suppression', pact: 'Fighter-Bomber' },
  bomber: { alliance: 'Bomb', pact: 'Heavy Bomber' },
  'maritime-bomber': { alliance: 'Maritime Bomb', pact: 'Naval Missile' },
  aew: { alliance: 'Airborne Control', pact: 'Early Warning' },
  tanker: { alliance: 'Air Refueling', pact: 'Tanker' },
  airlift: { alliance: 'Airlift', pact: 'Transport' },
  'heavy-helicopter': { alliance: 'Heavy Helicopter', pact: 'Transport Helicopter' },
  recon: { alliance: 'Reconnaissance', pact: 'Reconnaissance' },
};

/** Roles every side keeps at least one squadron of, where its table has the type. */
const SPECIAL_ROLES: readonly AircraftRole[] = [
  'aew',
  'tanker',
  'airlift',
  'recon',
  'sead',
  'heavy-helicopter',
  'stealth-strike',
  'deep-strike',
  'bomber',
  'maritime-bomber',
];

const ALLIANCE_WING: readonly string[] = ['f28', 'f30', 'f30', 'a14'];
const PACT_WING: readonly string[] = ['vo31k', 'vo31k'];

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/** Roles of a land base's squadrons, from its kind and depth. */
function baseRoles(kind: string, depth: number, side: Side, r: Rng): AircraftRole[] {
  switch (kind) {
    case 'island':
      return side === 'pact' ? ['multirole', 'maritime-bomber'] : ['multirole', 'air-superiority'];
    case 'forward':
      return ['cas', 'attack-helicopter', 'multirole'];
    case 'bomber':
      return side === 'pact' ? ['bomber', 'maritime-bomber', 'tanker'] : ['bomber', 'tanker'];
    default:
      if (depth < 0) return ['air-superiority', 'multirole'];
      if (depth < FRONT_LINE_DEPTH) return ['multirole', 'cas'];
      if (depth < DEEP_DEPTH)
        return r.chance(0.5)
          ? ['air-superiority', 'multirole']
          : ['air-superiority', 'deep-strike'];
      return ['deep-strike', 'air-superiority'];
  }
}

export function buildOrderOfBattle(input: CampaignInput, seed: WorldSeed): OrderOfBattle {
  const root = rng(seed, 'orbat');
  const names = root.fork('names');
  const usedNumbers: Record<Side, Set<number>> = { alliance: new Set(), pact: new Set() };
  const squadrons: Squadron[] = [];
  const bases: AirBaseRecord[] = [];

  const unitName = (side: Side, role: AircraftRole, carrier: boolean): string => {
    let n = 0;
    for (let guard = 0; guard < 100; guard++) {
      n = carrier ? 10 + names.int(190) : 1 + names.int(side === 'pact' ? 999 : 600);
      if (!usedNumbers[side].has(n)) break;
    }
    usedNumbers[side].add(n);
    const word = UNIT_WORD[role][side];
    if (carrier)
      return side === 'alliance' ? `${word} Squadron ${n}` : `${n} Shipborne ${word} Regiment`;
    if (side === 'alliance') return `${ordinal(n)} ${word} Squadron`;
    const small = STRENGTH[role].pact <= 12;
    return `${n} ${word} Aviation ${small ? 'Squadron' : 'Regiment'}`;
  };

  const addSquadron = (base: AirBaseRecord, typeId: string): void => {
    const t = aircraftType(typeId);
    const n = STRENGTH[t.role][t.side];
    const s: Squadron = {
      id: squadrons.length,
      side: t.side,
      name: unitName(t.side, t.role, base.ref.kind === 'carrier'),
      type: t.id,
      base: base.ref,
      aircraft: n,
      available: n,
    };
    squadrons.push(s);
    base.squadrons.push(s.id);
  };

  const pick = (side: Side, role: AircraftRole, r: Rng): string | null => {
    const list = typesFor(side, role);
    return list.length > 0 ? list[r.int(list.length)]!.id : null;
  };

  // Land bases.
  for (const a of input.airbases) {
    const base: AirBaseRecord = {
      ref: { kind: 'airbase', id: a.id },
      side: a.side,
      name: a.name,
      theater: a.theater,
      squadrons: [],
      stocks: { fuel: 0, munitions: 0 },
    };
    bases.push(base);
    const r = root.fork(`base-${a.id}`);
    for (const role of baseRoles(a.kind, a.depth, a.side, r)) {
      const id = pick(a.side, role, r);
      if (id) addSquadron(base, id);
    }
  }

  // Specials: at the deepest main bases, fewest squadrons first.
  const specials = root.fork('specials');
  for (const side of ['alliance', 'pact'] as const) {
    const candidates = input.airbases
      .filter((a) => a.side === side && a.kind === 'main')
      .sort((x, y) => y.depth - x.depth || x.id - y.id);
    if (candidates.length === 0) continue;
    for (const role of SPECIAL_ROLES) {
      if (squadrons.some((s) => s.side === side && aircraftType(s.type).role === role)) continue;
      const id = pick(side, role, specials);
      if (!id) continue;
      let best = candidates[0]!;
      for (const c of candidates) {
        if (bases[c.id]!.squadrons.length < bases[best.id]!.squadrons.length) best = c;
      }
      addSquadron(bases[best.id]!, id);
    }
  }

  // Carrier air wings.
  for (const c of input.carriers) {
    const base: AirBaseRecord = {
      ref: { kind: 'carrier', id: c.id },
      side: c.side,
      name: c.name,
      theater: c.theater,
      squadrons: [],
      stocks: { fuel: 0, munitions: 0 },
    };
    bases.push(base);
    for (const id of c.side === 'alliance' ? ALLIANCE_WING : PACT_WING) addSquadron(base, id);
  }

  // Stocks for the planned tempo.
  for (const b of bases) {
    const days = b.ref.kind === 'carrier' ? CARRIER_STOCK_DAYS : STOCK_DAYS;
    for (const id of b.squadrons) {
      const s = squadrons[id]!;
      const sorties = s.aircraft * SORTIES_PER_DAY * days;
      b.stocks.fuel += sorties * aircraftType(s.type).fuel;
      b.stocks.munitions += sorties;
    }
  }
  return { squadrons, bases };
}

/** Index in OrderOfBattle.bases of a base reference (airbases first, then carrier groups). */
export function baseIndex(ref: BaseRef, airbaseCount: number): number {
  return ref.kind === 'airbase' ? ref.id : airbaseCount + ref.id;
}

/** Every aircraft type that appears in an order of battle (for tests and the panel). */
export function typesInService(orbat: OrderOfBattle): string[] {
  const used = new Set(orbat.squadrons.map((s) => s.type));
  return AIRCRAFT_TYPES.filter((t) => used.has(t.id)).map((t) => t.id);
}
