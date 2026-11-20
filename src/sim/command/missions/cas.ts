/**
 * Close air support, fixed-wing (demo type; roadmap R2.1). Each front gets
 * CAS_PER_DAY sorties a day from the attacker and fewer from the defender,
 * split over its segments by pressure (front.ts) and spread through the
 * day's light; each flies an orbit CAS_SETBACK behind the line at its segment.
 * The ground war (R2.3) will give the pressure; until then the corridors do.
 */
import { casBriefing } from '../../../campaign/missionBriefings';
import { DEFAULT_JUMP_IN } from '../../air/mission';
import { casResolver } from '../../air/resolvers';
import { bySegment, phases, plannedStation, TACTICAL_FORMATIONS, the } from './common';
import type { MissionPlugin, Need, PlanContext } from './plugin';

export const CAS_PER_DAY: Record<'attacker' | 'defender', number> = { attacker: 24, defender: 12 };
export const CAS_SETBACK = 5e3;
export const CAS_SLIP = 20 * 60;

function needs(ctx: PlanContext): Need[] {
  const out: Need[] = [];
  for (const f of ctx.input.fronts) {
    const role = f.attacker === ctx.side ? 'attacker' : 'defender';
    const w = ctx.theaterWeight(f.theater);
    const name = ctx.theaterName(f.theater);
    const segments = ctx.segments.filter((s) => s.theater === f.theater);
    const counts = bySegment(segments, CAS_PER_DAY[role]);
    segments.forEach((seg, i) => {
      const n = counts[i]!;
      if (n === 0) return;
      const p = ctx.frontPoint(f.theater, (seg.from + seg.to) / 2, CAS_SETBACK);
      if (!p) return;
      const key = `cas:${f.theater}:${seg.index}`;
      const window = ctx.window(p.point, 'day');
      if (!window) return;
      const where = seg.corridor ?? `sector ${seg.index + 1} of ${the(name)}`;
      out.push({
        key,
        type: 'cas',
        label: `Close air support at ${where}`,
        theater: f.theater,
        score: (role === 'attacker' ? 0.75 : 0.55) * w * (0.6 + 0.4 * seg.pressure),
        target: { kind: 'front', id: -1, name: `Front, ${where}`, point: p.point },
        places: {
          theater: the(name),
          target: where,
          front: the(name),
          corridor: seg.corridor ?? undefined,
          town: ctx.town(p.point),
        },
        orbitHeading: p.heading,
        tots: ctx.schedule('spread', n, window, key),
        slip: CAS_SLIP,
      });
    });
  }
  return out;
}

export const CAS: MissionPlugin = {
  type: 'cas',
  status: 'demo',
  category: 'ground-support',
  engagement: 'target',
  // Working the front in trail: one aircraft attacks while the next sets up.
  formations: {
    ...TACTICAL_FORMATIONS,
    'fence-in': 'route',
    'on-target': 'trail',
    egress: 'route',
  },
  planner: needs,
  package: () => [{ role: 'lead', type: 'cas', offset: 0 }],
  resolver: casResolver,
  behavior: { pending: 'R2.5' },
  jumpIn: DEFAULT_JUMP_IN,
  success: {
    text: 'On call for at least half the planned time, with an effect on the enemy troops.',
    success: (m, o) => o.onStation >= 0.5 * plannedStation(m) && o.effect > 0,
    consequences: (m, o) =>
      o.effect > 0
        ? [{ kind: 'ground-attack', theater: m.theater, point: m.target.point, amount: o.effect }]
        : [],
  },
  briefing: casBriefing,
  interface: phases({
    'on-target': {
      masterMode: 'air-to-ground',
      formats: { leftMfd: ['moving-map', 'stores'], rightMfd: ['targeting-pod', 'radar-ag'] },
      hud: ['station', 'ccip'],
    },
  }),
  minimums: { daylight: 'day', target: { ceiling: 600, visibility: 5000 } },
};
