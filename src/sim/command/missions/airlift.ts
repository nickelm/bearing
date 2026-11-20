/**
 * Airlift resupply (demo type; roadmap R2.1): transports carry fuel and
 * munitions from the airlift squadrons' bases to the side's forward and island
 * fields. Each such field asks for one landing a day, a second below
 * LOW_STOCK of its stocks at the outbreak and a third below VERY_LOW_STOCK,
 * spread through the day. Routine resupply ranks with CAS (decision 250); the
 * lower its stocks, the higher the score.
 */
import { airliftBriefing } from '../../../campaign/missionBriefings';
import { DEFAULT_JUMP_IN } from '../../air/mission';
import { airliftResolver } from '../../air/resolvers';
import { phases, STREAM_FORMATIONS, the } from './common';
import { routeBehavior } from './plugin';
import type { MissionPlugin, Need, PlanContext } from './plugin';

export const LOW_STOCK = 0.8;
export const VERY_LOW_STOCK = 0.5;
/** Cargo per transport (R2.2's resolver delivers it): fuel (kg) and munition loads. */
export const AIRLIFT_CARGO = { fuel: 15_000, munitions: 4 } as const;

function needs(ctx: PlanContext): Need[] {
  const out: Need[] = [];
  if (!ctx.hasRole('airlift')) return out;
  for (const a of ctx.input.airbases) {
    if (a.side !== ctx.side || (a.kind !== 'forward' && a.kind !== 'island')) continue;
    const ref = { kind: 'airbase' as const, id: a.id };
    const now = ctx.air.base(ref).stocks;
    const full = ctx.initialStocks(ref);
    const share = Math.min(
      full.fuel > 0 ? now.fuel / full.fuel : 1,
      full.munitions > 0 ? now.munitions / full.munitions : 1,
    );
    const n = 1 + (share < LOW_STOCK ? 1 : 0) + (share < VERY_LOW_STOCK ? 1 : 0);
    const key = `airlift:${a.id}`;
    const window = ctx.window(a.point, 'any');
    if (!window) continue;
    const theater = ctx.theaterName(a.theater);
    out.push({
      key,
      type: 'airlift',
      label: `Airlift to ${a.name}`,
      theater: a.theater,
      score: (0.6 + 0.35 * (1 - share)) * Math.max(0.5, ctx.theaterWeight(a.theater)),
      target: { kind: 'airbase', id: a.id, name: a.name, point: [...a.point] },
      places: { theater: the(theater), target: a.name, town: ctx.town(a.point) },
      notFrom: ref,
      tots: ctx.schedule('spread', n, window, key),
      slip: 60 * 60,
    });
  }
  return out;
}

export const AIRLIFT: MissionPlugin = {
  type: 'airlift',
  status: 'demo',
  category: 'airlift',
  engagement: 'target',
  formations: STREAM_FORMATIONS,
  planner: needs,
  package: () => [{ role: 'lead', type: 'airlift', offset: 0 }],
  resolver: airliftResolver,
  // Transports fly the route and carry no weapons (decision 282).
  behavior: routeBehavior({}),
  jumpIn: DEFAULT_JUMP_IN,
  success: {
    text: 'At least 90% of the cargo delivered at the destination.',
    success: (_m, o) => o.delivered >= 0.9,
    consequences: (m, o) => {
      if (o.delivered <= 0 || m.target.kind !== 'airbase') return [];
      const fuel = AIRLIFT_CARGO.fuel * m.aircraft;
      const munitions = AIRLIFT_CARGO.munitions * m.aircraft;
      // The cargo leaves the origin's stocks and arrives in the destination's.
      return [
        { kind: 'stocks', base: { kind: 'airbase', id: m.target.id }, fuel, munitions },
        { kind: 'stocks', base: m.base, fuel: -fuel, munitions: -munitions },
      ];
    },
  },
  briefing: airliftBriefing,
  interface: phases({
    'fence-in': {
      masterMode: 'approach',
      formats: { leftMfd: ['moving-map'] },
      hud: ['glidepath'],
    },
    'on-target': { masterMode: 'ground', formats: { leftMfd: ['moving-map'] }, hud: [] },
  }),
  minimums: { daylight: 'any', target: { ceiling: 60, visibility: 800 } },
};
