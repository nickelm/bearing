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
  // Filters list the type; rows name AEW and tankers (missionLabel).
  support: 'Support (AEW, tanker)',
  airlift: 'Airlift resupply',
  airdrop: 'Combat airdrop',
  'sling-load': 'Sling-load resupply',
};

/**
 * A mission's name for people: its type's label, except that a support mission is
 * named by what its aircraft does (an AEW orbit or a tanker track); "Support" alone
 * read like close air support in mission search (decision 248).
 */
export function missionLabel(type: MissionType, role: AircraftRole): string {
  if (type === 'support') {
    if (role === 'aew') return 'Airborne early warning';
    if (role === 'tanker') return 'Tanker';
  }
  return MISSION_LABELS[type];
}

/**
 * How a mission type flies.
 * - `roles`: aircraft roles that fly it, in order of preference.
 * - `loadout`: the loadout id it carries (the type's first loadout if absent).
 * - `station`: 'orbit' holds a racetrack on station; 'pass' flies through the
 *   target point; 'land' lands there and takes off again (airlift).
 * - `low`: descends to low level for the fence-in, on target and the first part of egress.
 * - `stationTime`: [least, wanted] time on target or on station (s); fuel decides between them.
 */
/** Phases between which the player may take over a flight: from the start of `from` to the start of `to`. */
export interface JumpInWindow {
  from: MissionPhase;
  to: MissionPhase;
}

/**
 * Fixed-wing jump-in runs from climb-out to approach (decision 231): no takeoff
 * or landing is forced on the player.
 */
export const DEFAULT_JUMP_IN: JumpInWindow = { from: 'climb-out', to: 'approach' };

/** Helicopters' window spans their ground phases: landing is their mission (decision 149). */
export const HELICOPTER_JUMP_IN: JumpInWindow = { from: 'departure', to: 'complete' };

export interface MissionProfile {
  roles: readonly AircraftRole[];
  loadout?: string;
  station: 'orbit' | 'pass' | 'land';
  low: boolean;
  stationTime: readonly [number, number];
  /** The jump-in window (R1.4); DEFAULT_JUMP_IN when absent. */
  jumpIn?: JumpInWindow;
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
    jumpIn: HELICOPTER_JUMP_IN,
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
    jumpIn: HELICOPTER_JUMP_IN,
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

/** A target site, an airbase, an orbit station, a point on a front, or a road graph edge (R2.1). */
export type TargetKind = 'site' | 'airbase' | 'station' | 'front' | 'road';

/** Named places of a mission, for its label, the mission panel and the briefing (R2.1). */
export interface Places {
  theater: string;
  target: string;
  /** The front's name ("the Lynvania front"), on fronts. */
  front?: string;
  /** The corridor in a front segment ("the Kessar Gap"). */
  corridor?: string;
  /** The nearest town to the target or station. */
  town?: string;
}

export interface MissionTarget {
  kind: TargetKind;
  /** Target site, airbase or road edge id; −1 for stations and front points. */
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
  /** Named places for the briefing (R2.1); absent on missions planned before the ATO. */
  places?: Places;
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

/**
 * Game times between which the player may take over the mission's flight
 * (R1.4, decision 231): its profile's window on its timeline, or null when the
 * route skips a phase of it.
 */
export function jumpInWindow(m: Mission): { from: GameTime; to: GameTime } | null {
  const w = MISSION_PROFILES[m.type].jumpIn ?? DEFAULT_JUMP_IN;
  const from = phaseTime(m, w.from);
  const to = phaseTime(m, w.to);
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null;
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
