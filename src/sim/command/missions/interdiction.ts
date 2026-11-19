/**
 * Interdiction (demo type; roadmap R2.1): strikes on the fixed targets that
 * carry the enemy's supply to the front (owner decision 10): bridges, depots,
 * rail yards and road segments, ranked by the supply each carries (supply.ts)
 * and its value, discounted when struck recently and dropped when out of use.
 * The top INTERDICTION_PER_DAY targets get one strike each, timed in the day's
 * light by doctrine (Alliance spread, Pact waves). Defended sites (depots and
 * rail yards) get an escort in the package.
 */
import { interdictionBriefing } from '../../../campaign/missionBriefings';
import { arcDistance } from '../../../core/greatCircle';
import { DEFAULT_JUMP_IN } from '../../air/mission';
import { strikeResolver } from '../../air/resolvers';
import type { MissionTarget, Places } from '../../air/mission';
import { phases, restrike, standing, the } from './common';
import type { MissionPlugin, Need, PlanContext } from './plugin';

export const INTERDICTION_PER_DAY = 24;
/** Escorted from this score up, if the target is a site with defenses. */
export const ESCORT_SCORE = 0.45;

interface Candidate {
  key: string;
  target: MissionTarget;
  theater: number;
  score: number;
  escort: boolean;
  places: Places;
}

function needs(ctx: PlanContext): Need[] {
  const R = ctx.input.radius;
  const pool: Candidate[] = [];
  for (const [id, usage] of ctx.enemySupply.sites) {
    if (!standing(ctx, id)) continue;
    const x = ctx.input.targets[id]!;
    const key = `site:${id}`;
    const theater = ctx.theaterName(x.theater);
    pool.push({
      key,
      target: { kind: 'site', id, name: x.name, point: [...x.point] },
      theater: x.theater,
      score: ctx.theaterWeight(x.theater) * (0.4 * x.value + 0.6 * usage) * restrike(ctx, key),
      escort: x.kind !== 'bridge',
      places: { theater: the(theater), target: x.name, town: ctx.town(x.point) },
    });
  }
  for (const road of ctx.enemySupply.roads) {
    const key = `road:${road.edge}`;
    let theater = -1;
    let best = Infinity;
    for (const s of ctx.segments) {
      const d = arcDistance(s.point, road.point, R);
      if (d < best) {
        best = d;
        theater = s.theater;
      }
    }
    const town = ctx.town(road.point);
    const name = town ? `Road near ${town}` : 'Supply road';
    const tname = ctx.theaterName(theater);
    pool.push({
      key,
      target: { kind: 'road', id: road.edge, name, point: road.point },
      theater,
      score: ctx.theaterWeight(theater) * 0.6 * road.usage * restrike(ctx, key),
      escort: false,
      places: { theater: the(tname), target: name, town },
    });
  }
  for (const c of pool) c.score *= 0.9 + 0.2 * ctx.rng(`interdiction:${c.key}`).nextFloat();
  pool.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const picks = pool.slice(0, INTERDICTION_PER_DAY);
  if (picks.length === 0) return [];
  const window = ctx.window(picks[0]!.target.point, 'day');
  if (!window) return [];
  const tots = ctx.schedule('strike', picks.length, window, 'interdiction');
  // Higher scores take the earlier times, so the day's first strikes are its most important.
  return picks.map((c, i): Need => {
    const front = ctx.input.fronts.find((f) => f.theater === c.theater);
    return {
      key: `interdiction:${c.key}`,
      type: 'interdiction',
      label: `Interdiction of ${c.target.name}`,
      theater: c.theater,
      score: c.score,
      target: c.target,
      places: { ...c.places, front: front ? the(ctx.theaterName(front.theater)) : undefined },
      tots: [tots[i]!],
      slip: 30 * 60,
      defended: c.escort && c.score >= ESCORT_SCORE,
    };
  });
}

export const INTERDICTION: MissionPlugin = {
  type: 'interdiction',
  status: 'demo',
  category: 'strike',
  engagement: 'target',
  planner: needs,
  package: (n) => [
    { role: 'lead', type: 'interdiction', offset: 0 },
    ...(n.defended ? [{ role: 'escort' as const, type: 'escort' as const, offset: 0 }] : []),
  ],
  resolver: strikeResolver,
  behavior: { pending: 'R2.5' },
  jumpIn: DEFAULT_JUMP_IN,
  success: {
    text: 'The target is out of use: a bridge cut, a depot, rail yard or road at half damage or more.',
    success: (_m, o) => o.effect >= 0.5,
    consequences: (m, o) => {
      if (o.effect <= 0) return [];
      if (m.target.kind === 'road') return [{ kind: 'road', edge: m.target.id, amount: o.effect }];
      return [{ kind: 'damage', target: m.target.id, amount: o.effect }];
    },
  },
  briefing: interdictionBriefing,
  interface: phases({
    'fence-in': {
      masterMode: 'air-to-ground',
      formats: { leftMfd: ['stores', 'moving-map'], rightMfd: ['targeting-pod', 'radar-ag'] },
      hud: ['target'],
    },
    'on-target': {
      masterMode: 'air-to-ground',
      formats: { leftMfd: ['stores', 'moving-map'], rightMfd: ['targeting-pod', 'radar-ag'] },
      hud: ['target', 'ccip'],
    },
  }),
  minimums: { daylight: 'day', target: { ceiling: 900, visibility: 5000 } },
};
