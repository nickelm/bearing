/**
 * The mission model (design, "Mission Types"; decision 50). A mission is one
 * flight of one type flying one route; a package groups the missions planned
 * together for one need (a strike and its escort). Each mission records the
 * need it serves and its score, so the mission panel can say why it exists,
 * and its own seed, from which promotion (P1 and later) expands its aircraft.
 *
 * Every mission's route is analytic (route.ts), so its phase timeline is
 * known when it is planned: departure, climb-out, ingress, fence-in, on
 * target or on station, egress, approach, recovery, and complete.
 */
import type { Side } from '../../campaign/cast';
import type { Dir } from '../../core/greatCircle';
import { HOUR, MINUTE } from '../../core/units';
import type { GameTime } from '../../core/units';
import type { AircraftRole } from './aircraft';
import type { Route } from './route';

export type MissionType =
  | 'cap'
  | 'sweep'
  | 'escort'
  | 'interdiction'
  | 'deep-strike'
  | 'stealth-strike'
  | 'sead'
  | 'cas'
  | 'helo-cas'
  | 'anti-shipping'
  | 'strategic-bombing'
  | 'recon'
  | 'support'
  | 'airlift'
  | 'airdrop'
  | 'sling-load';

export type MissionPhase =
  | 'departure'
  | 'climb-out'
  | 'ingress'
  | 'fence-in'
  | 'on-target'
  | 'egress'
  | 'approach'
  | 'recovery'
  | 'complete';

export const MISSION_PHASES: readonly MissionPhase[] = [
  'departure',
  'climb-out',
  'ingress',
  'fence-in',
  'on-target',
  'egress',
  'approach',
  'recovery',
  'complete',
];

export const MISSION_LABELS: Record<MissionType, string> = {
  cap: 'Combat air patrol',
  sweep: 'Fighter sweep',
  escort: 'Escort',
  interdiction: 'Interdiction',
  'deep-strike': 'Low-level penetration strike',
  'stealth-strike': 'Stealth strike',
  sead: 'SEAD',
  cas: 'Close air support',
  'helo-cas': 'Attack helicopter CAS',
  'anti-shipping': 'Anti-shipping',
  'strategic-bombing': 'Strategic bombing',
  recon: 'Reconnaissance',
  support: 'Support',
  airlift: 'Airlift resupply',
  airdrop: 'Combat airdrop',
  'sling-load': 'Sling-load resupply',
};

/**
 * How a mission type flies.
 * - `roles`: aircraft roles that fly it, in order of preference.
 * - `loadout`: the loadout id it carries (the type's first loadout if absent).
 * - `station`: 'orbit' holds a racetrack on station; 'pass' flies through the
 *   target point; 'land' lands there and takes off again (airlift).
 * - `low`: descends to low level for the fence-in, on target and the first part of egress.
 * - `stationTime`: [least, wanted] time on target or on station (s); fuel decides between them.
 */
export interface MissionProfile {
  roles: readonly AircraftRole[];
  loadout?: string;
  station: 'orbit' | 'pass' | 'land';
  low: boolean;
  stationTime: readonly [number, number];
}

export const MISSION_PROFILES: Record<MissionType, MissionProfile> = {
  cap: {
    roles: ['air-superiority', 'multirole'],
    loadout: 'air-to-air',
    station: 'orbit',
    low: false,
    stationTime: [20 * MINUTE, 90 * MINUTE],
  },
  sweep: {
    roles: ['air-superiority'],
    loadout: 'air-to-air',
    station: 'orbit',
    low: false,
    stationTime: [10 * MINUTE, 20 * MINUTE],
  },
  escort: {
    roles: ['air-superiority', 'multirole'],
    loadout: 'air-to-air',
    station: 'pass',
    low: false,
    stationTime: [3 * MINUTE, 5 * MINUTE],
  },
  interdiction: {
    roles: ['multirole', 'deep-strike', 'carrier-attack'],
    loadout: 'strike',
    station: 'pass',
    low: false,
    stationTime: [2 * MINUTE, 4 * MINUTE],
  },
  'deep-strike': {
    roles: ['deep-strike', 'carrier-attack'],
    loadout: 'strike',
    station: 'pass',
    low: true,
    stationTime: [2 * MINUTE, 3 * MINUTE],
  },
  'stealth-strike': {
    roles: ['stealth-strike'],
    loadout: 'strike',
    station: 'pass',
    low: false,
    stationTime: [2 * MINUTE, 3 * MINUTE],
  },
  sead: {
    roles: ['sead'],
    loadout: 'sead',
    station: 'orbit',
    low: false,
    stationTime: [10 * MINUTE, 20 * MINUTE],
  },
  cas: {
    roles: ['cas', 'multirole'],
    loadout: 'cas',
    station: 'orbit',
    low: false,
    stationTime: [15 * MINUTE, 40 * MINUTE],
  },
  'helo-cas': {
    roles: ['attack-helicopter'],
    loadout: 'cas',
    station: 'orbit',
    low: true,
    stationTime: [10 * MINUTE, 30 * MINUTE],
  },
  'anti-shipping': {
    roles: ['maritime-bomber', 'carrier-attack', 'deep-strike'],
    loadout: 'anti-ship',
    station: 'pass',
    low: false,
    stationTime: [2 * MINUTE, 3 * MINUTE],
  },
  'strategic-bombing': {
    roles: ['bomber', 'maritime-bomber'],
    loadout: 'strike',
    station: 'pass',
    low: false,
    stationTime: [2 * MINUTE, 4 * MINUTE],
  },
  recon: {
    roles: ['recon'],
    loadout: 'recon',
    station: 'pass',
    low: true,
    stationTime: [3 * MINUTE, 5 * MINUTE],
  },
  support: {
    roles: ['aew', 'tanker'],
    station: 'orbit',
    low: false,
    stationTime: [1 * HOUR, 6 * HOUR],
  },
  airlift: {
    roles: ['airlift'],
    loadout: 'cargo',
    station: 'land',
    low: false,
    stationTime: [30 * MINUTE, 45 * MINUTE],
  },
  airdrop: {
    roles: ['airlift'],
    loadout: 'cargo',
    station: 'pass',
    low: true,
    stationTime: [3 * MINUTE, 5 * MINUTE],
  },
  'sling-load': {
    roles: ['heavy-helicopter'],
    loadout: 'sling',
    station: 'land',
    low: true,
    stationTime: [15 * MINUTE, 20 * MINUTE],
  },
};

/** A home base: an airbase (Infrastructure.airbases id) or a carrier group (Cast.carriers id). */
export interface BaseRef {
  kind: 'airbase' | 'carrier';
  id: number;
}

export type TargetKind = 'site' | 'airbase' | 'station' | 'front';

export interface MissionTarget {
  kind: TargetKind;
  /** Target site or airbase id; −1 for stations and front points. */
  id: number;
  name: string;
  point: Dir;
}

export interface Mission {
  id: number;
  type: MissionType;
  side: Side;
  /** Theater it serves (Cast.theaters index), or −1. */
  theater: number;
  /** Package id: missions planned together for one need share it. */
  package: number;
  /** Squadron (AirOps.squadrons index), aircraft type and aircraft in the flight. */
  squadron: number;
  /** The squadron's name, for the mission panel. */
  unit: string;
  aircraftType: string;
  aircraft: number;
  loadout: string;
  callsign: string;
  base: BaseRef;
  target: MissionTarget;
  /** The need it serves, in words, its key and its priority score (decision 50). */
  need: string;
  needKey: string;
  score: number;
  /** Seed for promotion: the flight's aircraft expand from it (uint32). */
  seed: number;
  route: Route;
  /** Start time of each phase, in MISSION_PHASES order; the last entry is 'complete'. */
  timeline: { phase: MissionPhase; time: GameTime }[];
}

/** The phase a mission is in at game time t: 'planned' before departure. */
export function missionPhase(m: Mission, t: GameTime): MissionPhase | 'planned' {
  let phase: MissionPhase | 'planned' = 'planned';
  for (const e of m.timeline) {
    if (e.time <= t) phase = e.phase;
    else break;
  }
  return phase;
}

/** Time the mission starts a phase, or NaN if its route skips it. */
export function phaseTime(m: Mission, phase: MissionPhase): GameTime {
  return m.timeline.find((e) => e.phase === phase)?.time ?? NaN;
}

export function missionStart(m: Mission): GameTime {
  return m.timeline[0]!.time;
}

export function missionEnd(m: Mission): GameTime {
  return m.timeline[m.timeline.length - 1]!.time;
}

/** True while the flight is off the ground (climb-out to approach). */
export function isAirborne(m: Mission, t: GameTime): boolean {
  const p = missionPhase(m, t);
  return p !== 'planned' && p !== 'departure' && p !== 'recovery' && p !== 'complete';
}
