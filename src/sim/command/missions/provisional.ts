/**
 * Mission types the interim tasker flew beyond the tech demo's four (decision
 * 132), ported as provisional plug-ins so the war keeps its AEW and tankers,
 * escorts, SEAD, deep strikes, bombers, reconnaissance and attack helicopters.
 * Their planner rules and package templates follow the interim tasker's; their
 * resolvers, behaviors, success criteria and interface defaults are pending
 * until the mission catalog (R4.2), and they share a plain briefing.
 */
import { plainBriefing } from '../../../campaign/missionBriefings';
import { DEFAULT_JUMP_IN, HELICOPTER_JUMP_IN } from '../../air/mission';
import type { MissionTarget, MissionType } from '../../air/mission';
import { AEW_SETBACK } from './cap';
import { STREAM_FORMATIONS, TACTICAL_FORMATIONS, bySegment, restrike, the } from './common';
import type { Category } from '../doctrine';
import type { Minimums } from '../environment';
import type { Engagement } from '../../air/outcome';
import type { MissionPlugin, Need, PackageTemplate, PlanContext, PlannerRule } from './plugin';

export const TANKER_SETBACK = 220e3;
export const DEEP_STRIKES_PER_DAY = 6;
export const BOMBING_PER_DAY = 4;
export const RECON_PER_DAY = 6;
export const HELO_CAS_PER_DAY = 12;
/** The Pact's SEAD flies ahead of its package (s). */
export const SEAD_LEAD = 5 * 60;

const ANY: Minimums = { daylight: 'any', target: { ceiling: 0, visibility: 0 } };

function provisional(
  type: MissionType,
  planner: PlannerRule,
  pkg: PackageTemplate,
  minimums: Minimums,
  category: Category,
  engagement: Engagement,
  helicopter = false,
): MissionPlugin {
  return {
    type,
    status: 'provisional',
    category,
    engagement,
    // Support aircraft and bombers fly in a stream; the rest as fighters do.
    formations:
      category === 'support' || type === 'strategic-bombing'
        ? STREAM_FORMATIONS
        : TACTICAL_FORMATIONS,
    planner,
    package: pkg,
    resolver: { pending: 'R4.2' },
    behavior: { pending: 'R4.2' },
    jumpIn: helicopter ? HELICOPTER_JUMP_IN : DEFAULT_JUMP_IN,
    success: { pending: 'R4.2' },
    briefing: plainBriefing,
    interface: { pending: 'R4.2' },
    minimums,
  };
}

const lead =
  (type: MissionType): PackageTemplate =>
  () => [{ role: 'lead', type, offset: 0 }];

/** A strike's package: the lead, an escort when defended, SEAD against an airbase. */
const strikePackage =
  (type: MissionType): PackageTemplate =>
  (n) => [
    { role: 'lead', type, offset: 0 },
    ...(n.defended ? [{ role: 'escort' as const, type: 'escort' as const, offset: 0 }] : []),
    ...(n.target.kind === 'airbase'
      ? [{ role: 'sead' as const, type: 'sead' as const, offset: -SEAD_LEAD }]
      : []),
  ];

function support(ctx: PlanContext): Need[] {
  const out: Need[] = [];
  for (const f of ctx.input.fronts) {
    const w = ctx.theaterWeight(f.theater);
    const name = the(ctx.theaterName(f.theater));
    const aew = ctx.frontPoint(f.theater, 0.5, AEW_SETBACK);
    if (aew) {
      out.push({
        key: `support:aew:${f.theater}`,
        type: 'support',
        roles: ['aew'],
        label: `Airborne early warning behind ${name}`,
        theater: f.theater,
        score: 0.85 * w,
        target: { kind: 'station', id: -1, name: `AEW orbit, ${name}`, point: aew.point },
        places: { theater: name, target: 'the AEW orbit', front: name },
        orbitHeading: aew.heading,
        standing: true,
      });
    }
    const tanker = ctx.frontPoint(f.theater, 0.4, TANKER_SETBACK);
    if (tanker) {
      out.push({
        key: `support:tanker:${f.theater}`,
        type: 'support',
        roles: ['tanker'],
        label: `Tanker track behind ${name}`,
        theater: f.theater,
        score: 0.6 * w,
        target: { kind: 'station', id: -1, name: `Tanker track, ${name}`, point: tanker.point },
        places: { theater: name, target: 'the tanker track', front: name },
        orbitHeading: tanker.heading,
        standing: true,
      });
    }
  }
  return out;
}

interface Site {
  key: string;
  target: MissionTarget;
  theater: number;
  score: number;
  value: number;
}

function enemyAirbases(ctx: PlanContext): Site[] {
  return ctx.input.airbases
    .filter((a) => a.side === ctx.enemy)
    .map((a) => {
      const value =
        a.kind === 'forward' || a.kind === 'island' ? 0.8 : a.kind === 'bomber' ? 0.7 : 0.6;
      const key = `airbase:${a.id}`;
      return {
        key,
        target: { kind: 'airbase', id: a.id, name: a.name, point: [...a.point] },
        theater: a.theater,
        value,
        score: value * ctx.theaterWeight(a.theater) * restrike(ctx, key),
      };
    });
}

function enemySites(ctx: PlanContext, kinds: readonly string[]): Site[] {
  return ctx.input.targets
    .filter((x) => x.side === ctx.enemy && kinds.includes(x.kind))
    .map((x) => {
      const key = `site:${x.id}`;
      return {
        key,
        target: { kind: 'site', id: x.id, name: x.name, point: [...x.point] },
        theater: x.theater,
        value: x.value,
        score: x.value * ctx.theaterWeight(x.theater) * restrike(ctx, key),
      };
    });
}

/** The top `count` of `pool` (jittered per day), each one strike timed by doctrine in `light`. */
function strikes(
  ctx: PlanContext,
  type: MissionType,
  pool: Site[],
  count: number,
  light: 'day' | 'night' | 'any',
  word: string,
): Need[] {
  for (const p of pool) p.score *= 0.9 + 0.2 * ctx.rng(`${type}:${p.key}`).nextFloat();
  pool.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const picks = pool.slice(0, count);
  if (picks.length === 0) return [];
  const p0 = picks[0]!.target.point;
  const window = ctx.window(p0, light) ?? ctx.window(p0, 'any');
  if (!window) return [];
  const tots = ctx.schedule('strike', picks.length, window, type);
  return picks.map((p, i) => ({
    key: `${type}:${p.key}`,
    type,
    label: `${word} ${p.target.name}`,
    theater: p.theater,
    score: p.score,
    target: p.target,
    places: {
      theater: the(ctx.theaterName(p.theater)),
      target: p.target.name,
      town: ctx.town(p.target.point),
    },
    tots: [tots[i]!],
    slip: 30 * 60,
    defended: p.target.kind === 'airbase' || p.score > 0.6,
  }));
}

function recon(ctx: PlanContext): Need[] {
  const pool = [
    ...enemySites(ctx, ['rail-yard', 'supply-depot', 'fuel-depot']),
    ...enemyAirbases(ctx),
  ];
  pool.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const top = pool.slice(0, 12);
  if (top.length === 0) return [];
  const r = ctx.rng('recon');
  const picks: Site[] = [];
  for (let i = 0; i < RECON_PER_DAY && top.length > 0; i++)
    picks.push(top.splice(r.int(top.length), 1)[0]!);
  const window = ctx.window(picks[0]!.target.point, 'day');
  if (!window) return [];
  const tots = ctx.schedule('spread', picks.length, window, 'recon');
  return picks.map((p, i) => ({
    key: `recon:${p.key}`,
    type: 'recon' as const,
    label: `Reconnaissance of ${p.target.name}`,
    theater: p.theater,
    score: 0.4,
    target: p.target,
    places: { theater: the(ctx.theaterName(p.theater)), target: p.target.name },
    tots: [tots[i]!],
    slip: 60 * 60,
  }));
}

function heloCas(ctx: PlanContext): Need[] {
  const out: Need[] = [];
  for (const f of ctx.input.fronts) {
    if (f.attacker !== ctx.side) continue;
    const name = ctx.theaterName(f.theater);
    const segments = ctx.segments.filter((s) => s.theater === f.theater);
    const counts = bySegment(segments, HELO_CAS_PER_DAY);
    segments.forEach((seg, i) => {
      if (counts[i] === 0) return;
      const p = ctx.frontPoint(f.theater, (seg.from + seg.to) / 2, 3e3);
      if (!p) return;
      const key = `helo-cas:${f.theater}:${seg.index}`;
      const window = ctx.window(p.point, 'any');
      if (!window) return;
      const where = seg.corridor ?? `sector ${seg.index + 1} of ${the(name)}`;
      out.push({
        key,
        type: 'helo-cas',
        label: `Attack helicopters at ${where}`,
        theater: f.theater,
        score: 0.7 * ctx.theaterWeight(f.theater) * (0.6 + 0.4 * seg.pressure),
        target: { kind: 'front', id: -1, name: `Front, ${where}`, point: p.point },
        places: { theater: the(name), target: where, front: the(name) },
        orbitHeading: p.heading,
        tots: ctx.schedule('spread', counts[i]!, window, key),
        slip: 30 * 60,
      });
    });
  }
  return out;
}

export const PROVISIONAL: MissionPlugin[] = [
  provisional('support', support, lead('support'), ANY, 'support', 'none'),
  provisional('escort', () => [], lead('escort'), ANY, 'counter-air', 'escort'),
  provisional('sead', () => [], lead('sead'), ANY, 'strike', 'suppression'),
  provisional(
    'deep-strike',
    (ctx) =>
      strikes(ctx, 'deep-strike', enemyAirbases(ctx), DEEP_STRIKES_PER_DAY, 'night', 'Strike on'),
    strikePackage('deep-strike'),
    ANY,
    'strike',
    'target',
  ),
  provisional(
    'strategic-bombing',
    (ctx) =>
      strikes(
        ctx,
        'strategic-bombing',
        enemySites(ctx, ['factory', 'power-plant', 'refinery']),
        BOMBING_PER_DAY,
        'any',
        'Bombing of',
      ),
    strikePackage('strategic-bombing'),
    ANY,
    'strike',
    'target',
  ),
  provisional(
    'recon',
    recon,
    lead('recon'),
    { daylight: 'day', target: { ceiling: 1500, visibility: 8000 } },
    'strike',
    'target',
  ),
  provisional(
    'helo-cas',
    heloCas,
    lead('helo-cas'),
    { daylight: 'any', target: { ceiling: 150, visibility: 1500 } },
    'ground-support',
    'target',
    true,
  ),
];
