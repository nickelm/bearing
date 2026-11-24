/**
 * Combat search and rescue (roadmap R2.9): the owning side always tasks a rescue for
 * every survivor down (sim/air/survivors.ts). Three plug-ins make the package:
 *
 * - **CSAR** (the lead): a pair of utility helicopters flies in low, lands at the
 *   survivor for the pickup and brings the crew home. Its planner rule is urgent: it
 *   runs at every hourly tick of the order, not only at revisions, and the airborne cap
 *   and the apportionment never refuse it. Survivors within GROUP_RANGE of each other
 *   are one rescue.
 * - **Rescue escort:** a pair of attack helicopters circles the pickup low while the
 *   rescue is on the ground, where the enemy is near (the capture hazard there).
 * - **Rescue cover (RESCAP):** a pair of attack aircraft holds over the survivor from
 *   COVER_LEAD before the landing until the helicopters leave, where the survivor is in
 *   the enemy's territory or near the front.
 *
 * The aggregate resolver (`csarResolver`) decides the pickup for a rescue no one
 * watches; the survivors it picks up are aboard until the rescue lands home, and then
 * back on their squadron's roster (AirOps).
 */
import {
  csarBriefing,
  rescapBriefing,
  rescueEscortBriefing,
} from '../../../campaign/missionBriefings';
import { HOUR, MINUTE } from '../../../core/units';
import { HELICOPTER_JUMP_IN, DEFAULT_JUMP_IN } from '../../air/mission';
import { capResolver, casResolver, csarResolver } from '../../air/resolvers';
import type { Survivor } from '../../air/survivors';
import { phases, STREAM_FORMATIONS, TACTICAL_FORMATIONS, the } from './common';
import { routeBehavior } from './plugin';
import type { Minimums } from '../environment';
import type { MissionPlugin, Need, PlanContext } from './plugin';

/** The cover is over the survivor this long before the rescue lands (s), the escort this long. */
export const COVER_LEAD = 10 * MINUTE;
export const ESCORT_LEAD = 2 * MINUTE;
/** A capture hazard (per hour) above which the rescue takes an escort, and its cover. */
export const ESCORT_THREAT = 0.05;
export const COVER_THREAT = 0.02;
/** The rescue's score: above every other need, so it takes the nearest helicopters first. */
export const CSAR_SCORE = 2;

const ANY: Minimums = { daylight: 'any', target: { ceiling: 0, visibility: 0 } };

/** Survivors of the side down and not on a live rescue's list. */
function untasked(ctx: PlanContext): Survivor[] {
  const tasked = new Set<number>();
  for (const m of ctx.air.missions.values()) {
    if (m.side !== ctx.side || m.type !== 'csar' || m.aborted || m.resolved) continue;
    for (const id of m.survivors ?? []) tasked.add(id);
  }
  return ctx.air.survivors.filter(
    (s) => s.side === ctx.side && s.state === 'down' && !tasked.has(s.id),
  );
}

/** One rescue need per group of untasked survivors, the lowest id naming it. */
function needs(ctx: PlanContext): Need[] {
  const left = untasked(ctx);
  const ids = new Set(left.map((s) => s.id));
  const out: Need[] = [];
  for (const s of left) {
    if (!ids.has(s.id)) continue;
    const group = ctx.air.rescueGroup(s.id).filter((g) => ids.has(g.id));
    for (const g of group) ids.delete(g.id);
    const theater = s.theater;
    const name = ctx.theaterName(theater);
    const town = ctx.town(s.point);
    const crew = group.length === 1 ? `${s.pilot}` : `${s.pilot} and ${group.length - 1} more`;
    const threat = (ctx.air.survivorThreat?.(ctx.side, s.point) ?? 0) * HOUR;
    out.push({
      // A new attempt after a failed rescue is a new need (its request is filled once).
      key: `csar:${s.id}:${s.attempts}`,
      type: 'csar',
      label: `Rescue of ${crew}${town ? ` near ${town}` : ''}`,
      theater,
      score: CSAR_SCORE,
      target: { kind: 'survivor', id: s.id, name: `Survivors, ${crew}`, point: [...s.point] },
      places: { theater: the(name), target: crew, town },
      survivors: group.map((g) => g.id),
      tots: [ctx.now],
      slip: Infinity,
      // The package template reads it: an escort and cover where the enemy is near.
      threat,
    });
  }
  return out;
}

export const CSAR: MissionPlugin = {
  type: 'csar',
  status: 'demo',
  category: 'support',
  engagement: 'target',
  urgent: true,
  formations: STREAM_FORMATIONS,
  planner: needs,
  // The pair, its escort near the enemy and its cover in the enemy's ground or near the front.
  package: (n) => [
    { role: 'lead', type: 'csar', offset: 0 },
    ...((n.threat ?? 0) > ESCORT_THREAT
      ? [{ role: 'escort' as const, type: 'csar-escort' as const, offset: -ESCORT_LEAD }]
      : []),
    ...((n.threat ?? 0) > COVER_THREAT
      ? [{ role: 'cover' as const, type: 'rescap' as const, offset: -COVER_LEAD }]
      : []),
  ],
  resolver: csarResolver,
  // The route there and home; on the ground at the survivor through the pickup.
  behavior: {
    phases: {
      departure: { lead: 'route', wingmen: 'slots', weapons: 'hold' },
      'climb-out': { lead: 'route', wingmen: 'slots', weapons: 'hold' },
      ingress: { lead: 'route', wingmen: 'slots', weapons: 'hold' },
      'fence-in': { lead: 'land', wingmen: 'slots', weapons: 'hold' },
      'on-target': { lead: 'land', wingmen: 'slots', weapons: 'hold' },
      egress: { lead: 'route', wingmen: 'slots', weapons: 'hold' },
      approach: { lead: 'route', wingmen: 'slots', weapons: 'hold' },
      recovery: { lead: 'route', wingmen: 'slots', weapons: 'hold' },
    },
  },
  jumpIn: HELICOPTER_JUMP_IN,
  success: {
    text: 'Picks up at least one survivor and brings the crew home.',
    success: (_m, o) => (o.rescued?.length ?? 0) > 0,
    consequences: (_m, o) =>
      o.rescued && o.rescued.length > 0 ? [{ kind: 'rescue', survivors: [...o.rescued] }] : [],
  },
  briefing: csarBriefing,
  // The helicopter's hover mode with the landing zone on the HUD from the fence-in.
  interface: phases({
    departure: { masterMode: 'hover', formats: { leftMfd: ['moving-map'] }, hud: [] },
    'fence-in': {
      masterMode: 'navigation',
      formats: { leftMfd: ['moving-map'] },
      hud: ['steering', 'landing-zone'],
    },
    'on-target': {
      masterMode: 'hover',
      formats: { leftMfd: ['moving-map'] },
      hud: ['landing-zone'],
    },
    approach: { masterMode: 'hover', formats: { leftMfd: ['moving-map'] }, hud: ['steering'] },
    recovery: { masterMode: 'hover', formats: { leftMfd: ['moving-map'] }, hud: [] },
  }),
  minimums: ANY,
};

export const RESCUE_ESCORT: MissionPlugin = {
  type: 'csar-escort',
  status: 'demo',
  category: 'support',
  engagement: 'escort',
  urgent: true,
  formations: { ...TACTICAL_FORMATIONS, 'fence-in': 'trail', 'on-target': 'trail' },
  // Flown only in a rescue's package.
  planner: () => [],
  package: () => [{ role: 'lead', type: 'csar-escort', offset: 0 }],
  // Its work counts as fire on the enemy near the pickup, as CAS's does.
  resolver: casResolver,
  behavior: routeBehavior({ 'on-target': 'air-to-ground' }),
  jumpIn: HELICOPTER_JUMP_IN,
  success: {
    text: 'Over the pickup while the rescue is on the ground.',
    success: (_m, o) => o.onStation > 0,
    consequences: () => [],
  },
  briefing: rescueEscortBriefing,
  interface: phases({
    'on-target': {
      masterMode: 'air-to-ground',
      formats: { leftMfd: ['moving-map', 'stores'] },
      hud: ['station', 'ccip'],
    },
  }),
  minimums: ANY,
};

export const RESCAP: MissionPlugin = {
  type: 'rescap',
  status: 'demo',
  category: 'support',
  // It fights for the rescue when the enemy's fighters come for it, as an escort does.
  engagement: 'escort',
  urgent: true,
  formations: { ...TACTICAL_FORMATIONS, 'on-target': 'trail' },
  planner: () => [],
  package: () => [{ role: 'lead', type: 'rescap', offset: 0 }],
  resolver: capResolver,
  behavior: routeBehavior({ 'on-target': 'air-to-ground' }, 'air-to-air'),
  jumpIn: DEFAULT_JUMP_IN,
  success: {
    text: 'Holds over the survivor through the rescue.',
    success: (_m, o) => o.onStation > 0,
    consequences: () => [],
  },
  briefing: rescapBriefing,
  interface: phases({
    'on-target': {
      masterMode: 'air-to-ground',
      formats: { leftMfd: ['moving-map', 'stores'], rightMfd: ['targeting-pod', 'radar-ag'] },
      hud: ['station', 'ccip'],
    },
  }),
  minimums: ANY,
};
