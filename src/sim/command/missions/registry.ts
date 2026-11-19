/**
 * The mission registry (rule 16; roadmap R2.1): every mission type the air
 * tasking order plans, in planning order. `tests/missions.test.ts` checks that
 * each has its eight parts, or a marker naming the milestone that builds a
 * missing one, and pins the list of markers.
 */
import { aircraftType } from '../../air/aircraft';
import type { Mission, MissionType } from '../../air/mission';
import type { CampaignInput } from '../campaignInput';
import { plannedStation } from './common';
import { AIRLIFT } from './airlift';
import { CAP } from './cap';
import { CAS } from './cas';
import { INTERDICTION } from './interdiction';
import { isPending, PLUGIN_PARTS } from './plugin';
import type { BriefingInput, MissionPlugin } from './plugin';
import { PROVISIONAL } from './provisional';

export const MISSION_PLUGINS: readonly MissionPlugin[] = [
  CAP,
  INTERDICTION,
  CAS,
  AIRLIFT,
  ...PROVISIONAL,
];

const BY_TYPE = new Map<MissionType, MissionPlugin>(MISSION_PLUGINS.map((p) => [p.type, p]));

/** The plug-in of a mission type; throws for a type nothing registered. */
export function missionPlugin(type: MissionType): MissionPlugin {
  const p = BY_TYPE.get(type);
  if (!p) throw new Error(`No mission plug-in for ${type}`);
  return p;
}

export function hasMissionPlugin(type: MissionType): boolean {
  return BY_TYPE.has(type);
}

/** Each registered type's parts still pending, as "type.part: milestone". */
export function pendingParts(): string[] {
  const out: string[] = [];
  for (const p of MISSION_PLUGINS) {
    for (const part of PLUGIN_PARTS) {
      const v = p[part];
      if (isPending(v)) out.push(`${p.type}.${part}: ${v.pending}`);
    }
  }
  return out;
}

/**
 * A mission's briefing from its type's template (R2.1), with its named places;
 * `when` is the local time on target, written by the caller (it knows the
 * calendar and the viewing longitude).
 */
export function missionBriefing(m: Mission, input: CampaignInput, when?: string): string {
  const p = missionPlugin(m.type);
  const t = aircraftType(m.aircraftType);
  const base =
    m.base.kind === 'airbase'
      ? (input.airbases[m.base.id]?.name ?? 'base')
      : (input.carriers[m.base.id]?.name ?? 'the carrier');
  const b: BriefingInput = {
    type: m.type,
    callsign: m.callsign,
    unit: m.unit,
    aircraftName: t.name,
    aircraft: m.aircraft,
    base,
    places: m.places ?? {
      theater: input.theaters[m.theater]?.name ?? 'the theater',
      target: m.target.name,
    },
    need: m.need,
    when,
    stationTime: plannedStation(m),
    stores: t.loadouts.find((l) => l.id === m.loadout)?.stores,
  };
  return isPending(p.briefing) ? `${m.callsign}: ${m.need}.` : p.briefing(b);
}
