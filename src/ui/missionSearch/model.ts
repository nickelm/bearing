/**
 * Mission search (roadmap R1.4, Proposal 0008): the viewing side's ongoing and
 * upcoming missions as rows, filtered and sorted by the time until action. A
 * pure display model (rule 14's pattern): no DOM, so tests drive it and the
 * panel only draws it.
 *
 * - **Action** is the on-target phase: a mission in it sorts first (time 0),
 *   then those still to reach it by how soon, then those past it, most recent
 *   first.
 * - **Threat** is an interim level per mission type until the intelligence
 *   picture (R3) can say what a mission flies into.
 * - **Jump-in**: the window in game time and whether it is open now.
 */
import type { Side } from '../../campaign/cast';
import { MINUTE } from '../../core/units';
import type { GameTime } from '../../core/units';
import { aircraftType } from '../../sim/air/aircraft';
import {
  jumpInWindow,
  missionLabel,
  MISSION_PHASES,
  missionPhase,
  phaseTime,
} from '../../sim/air/mission';
import type { Mission, MissionPhase, MissionType } from '../../sim/air/mission';
import type { MissionQuery } from '../../sim/air/subscriptions';

export type ThreatLevel = 'low' | 'medium' | 'high';
export const THREAT_LEVELS: readonly ThreatLevel[] = ['low', 'medium', 'high'];

/** Interim threat by mission type (R1.4), until R3's intelligence picture. */
export const MISSION_THREAT: Record<MissionType, ThreatLevel> = {
  cap: 'medium',
  sweep: 'high',
  escort: 'high',
  interdiction: 'high',
  'deep-strike': 'high',
  'stealth-strike': 'medium',
  sead: 'high',
  cas: 'high',
  'helo-cas': 'high',
  'anti-shipping': 'high',
  'strategic-bombing': 'medium',
  recon: 'medium',
  support: 'low',
  airlift: 'low',
  airdrop: 'medium',
  'sling-load': 'low',
};

export type PhaseFilter = MissionPhase | 'planned';

export const PHASE_LABELS: Record<PhaseFilter, string> = {
  planned: 'planned',
  departure: 'departing',
  'climb-out': 'climbing out',
  ingress: 'ingress',
  'fence-in': 'fence-in',
  'on-target': 'on target',
  egress: 'egress',
  approach: 'approach',
  recovery: 'recovering',
  complete: 'complete',
};

/** Filters; an empty list takes everything. */
export interface MissionFilters {
  types: MissionType[];
  /** Aircraft type ids. */
  aircraft: string[];
  /** Cast theater indices. */
  theaters: number[];
  phases: PhaseFilter[];
  threats: ThreatLevel[];
  /** Largest time until action (s); Infinity for any. Missions past their action pass only without a limit. */
  within: number;
}

export const NO_FILTERS: MissionFilters = {
  types: [],
  aircraft: [],
  theaters: [],
  phases: [],
  threats: [],
  within: Infinity,
};

export interface MissionRow {
  id: number;
  /** The map's selection key. */
  key: string;
  callsign: string;
  type: MissionType;
  typeLabel: string;
  /** Aircraft type name and count, e.g. "F-21 Kestrel × 4". */
  aircraft: string;
  unit: string;
  theater: string;
  phase: PhaseFilter;
  phaseLabel: string;
  threat: ThreatLevel;
  /** Seconds until action: 0 in it, below 0 past it. */
  timeToAction: number;
  /** "on target", "in 12 min", "3 min ago". */
  action: string;
  jumpIn: { from: GameTime; to: GameTime } | null;
  /** Whether the jump-in window is open now. */
  jumpable: boolean;
  /** Whether the flight can be followed now: it has started and not ended (R2.4). */
  followable: boolean;
}

function minutes(s: number): string {
  const m = Math.max(0, Math.round(s / MINUTE));
  return m >= 90 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** Seconds until the mission's action at time t: 0 during it, negative after. */
export function timeToAction(m: Mission, t: GameTime): number {
  const start = phaseTime(m, 'on-target');
  if (!Number.isFinite(start)) return -Infinity;
  if (t < start) return start - t;
  const i = MISSION_PHASES.indexOf('on-target');
  let end = Infinity;
  for (const p of MISSION_PHASES.slice(i + 1)) {
    const x = phaseTime(m, p);
    if (Number.isFinite(x)) {
      end = x;
      break;
    }
  }
  return t < end ? 0 : end - t;
}

const take = <T>(list: readonly T[], x: T) => list.length === 0 || list.includes(x);

/** The rows for `side` ('both' in the developer view) at time t, filtered and sorted. */
export function missionRows(
  missions: readonly Mission[],
  side: Side | 'both',
  t: GameTime,
  filters: MissionFilters,
  theaterNames: readonly string[],
): MissionRow[] {
  const rows: MissionRow[] = [];
  for (const m of missions) {
    if (side !== 'both' && m.side !== side) continue;
    const phase = missionPhase(m, t);
    if (phase === 'complete') continue;
    const threat = MISSION_THREAT[m.type];
    const toAction = timeToAction(m, t);
    if (!take(filters.types, m.type) || !take(filters.aircraft, m.aircraftType)) continue;
    if (!take(filters.theaters, m.theater) || !take(filters.phases, phase)) continue;
    if (!take(filters.threats, threat)) continue;
    if (Number.isFinite(filters.within) && !(toAction >= 0 && toAction <= filters.within)) continue;
    const window = jumpInWindow(m);
    rows.push({
      id: m.id,
      key: `mission:${m.id}`,
      callsign: m.callsign,
      type: m.type,
      typeLabel: missionLabel(m.type, aircraftType(m.aircraftType).role),
      aircraft: `${aircraftType(m.aircraftType).name} × ${m.aircraft}`,
      unit: m.unit,
      theater: theaterNames[m.theater] ?? 'strategic',
      phase,
      phaseLabel: PHASE_LABELS[phase],
      threat,
      timeToAction: toAction,
      // A route rebuilt after its action (a handback in the egress, an abort) keeps no time
      // on target: the action is past, its time unknown (decision 312).
      action: !Number.isFinite(toAction)
        ? 'action past'
        : toAction === 0
          ? 'on target'
          : toAction > 0
            ? `in ${minutes(toAction)}`
            : `${minutes(-toAction)} ago`,
      jumpIn: window,
      jumpable: window !== null && t >= window.from && t < window.to,
      followable: phase !== 'planned' && m.aircraft > 0,
    });
  }
  const rank = (r: MissionRow) => (r.timeToAction === 0 ? 0 : r.timeToAction > 0 ? 1 : 2);
  // An unknown past action sorts after every known one (−Infinity − −Infinity is NaN).
  const tta = (r: MissionRow) => (Number.isFinite(r.timeToAction) ? r.timeToAction : -1e15);
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) || (rank(a) === 2 ? tta(b) - tta(a) : tta(a) - tta(b)) || a.id - b.id,
  );
  return rows;
}

/** What the filters can choose among, from the side's missions: types, aircraft, theaters in use. */
export function filterChoices(
  missions: readonly Mission[],
  side: Side | 'both',
): { types: MissionType[]; aircraft: string[]; theaters: number[] } {
  const mine = missions.filter((m) => side === 'both' || m.side === side);
  const uniq = <T>(xs: T[]) => [...new Set(xs)];
  return {
    types: uniq(mine.map((m) => m.type)).sort(),
    aircraft: uniq(mine.map((m) => m.aircraftType)).sort(),
    theaters: uniq(mine.map((m) => m.theater)).sort((a, b) => a - b),
  };
}

/** The subscription query of the current filters (what the sim can match: side, type, aircraft, theater). */
export function queryOf(filters: MissionFilters, side: Side | 'both'): MissionQuery {
  return {
    ...(side === 'both' ? {} : { side }),
    ...(filters.types.length ? { types: [...filters.types] } : {}),
    ...(filters.aircraft.length ? { aircraft: [...filters.aircraft] } : {}),
    ...(filters.theaters.length ? { theaters: [...filters.theaters] } : {}),
  };
}
