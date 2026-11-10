/**
 * Casting (design, "Casting"; decisions 47, 51): turns the detected theaters
 * into a campaign. Reads the strategic graph only (decision 52) and draws
 * only from rng(seed, "casting") and its forks. It runs before the player
 * picks a side; nothing here depends on that choice.
 *
 * 1. Select every theater above its fit threshold (detection).
 * 2. Territory: a front's landmass is split along its start line, the Pact
 *    on the forward side (the front generator puts the larger share there
 *    when it can: mass and interior lines). The Alliance takes the rear base
 *    at the far end of each sea lane and the chokepoint islands guarding it.
 *    In an island campaign the cluster splits in two around its most distant
 *    pair of nodes; the Pact takes the larger group and assembles the armada,
 *    the Alliance holds the dispersed rest.
 * 3. Posture: the Pact attacks in every theater (open question: aggressor).
 * 4. Logistics links: lanes supply fronts, chokepoints protect lanes,
 *    industry feeds every theater.
 * 5. Range factor from the two reach targets (decision 51).
 * 6. Regions for industry, ports, bases and ground combat, which milestone 5
 *    turns into sites.
 * 7. Briefing.
 */
import { rng } from '../core/rng';
import type { Rng, WorldSeed } from '../core/rng';
import type { LandNode, Point, StrategicGraph } from '../worldgen/strategic/graph';
import {
  nodeDistance,
  polylinePoint,
  settlementPoint,
  sitePoint,
  surfaceDistance,
} from '../worldgen/strategic/graph';
import { writeBriefing } from './briefing';
import type {
  Cast,
  LogisticsLink,
  NodeOwner,
  RangeFactorTarget,
  Region,
  Side,
  Theater,
} from './cast';
import { NameGenerator } from './names';
import type { Detection, TheaterCandidate, TheaterKind } from './theaters';

export const RANGE_FACTOR_MIN = 0.35;
export const RANGE_FACTOR_MAX = 1;
/**
 * Reference combat radii (real, before the range factor) until the aircraft
 * tables of milestone 7 exist: a medium strike aircraft (Tornado IDS, Su-24
 * hi-lo-hi) and a long-range bomber (Tu-22M, B-52 with a war load).
 */
export const MEDIUM_STRIKE_RADIUS = 1300e3;
export const LONG_RANGE_BOMBER_RADIUS = 4000e3;
/** Rear bases sit this far behind a front, or at the defender's full depth if shallower (m). */
export const REAR_BASE_DEPTH = 250e3;

const THEATER_WEIGHT: Record<TheaterKind, number> = {
  'continental-front': 1,
  'island-campaign': 1,
  'sea-lane': 0.7,
  chokepoint: 0.5,
  strategic: 0.4,
};

const SIDES: readonly Side[] = ['alliance', 'pact'];

/** Side holding the land at signed offset `off` from a split node's line. */
function sideAt(owner: NodeOwner & { kind: 'split' }, off: number): Side {
  const lineSide = off < 0 ? 0 : 1;
  return lineSide === owner.pactSide ? 'pact' : 'alliance';
}

/** Settlements are summed within this radius to find industrial clusters (m). */
const INDUSTRY_CLUSTER_RADIUS = 80e3;

/** Settlements held by `side`, with their node and distance from the dividing line (0 for whole nodes). */
export function settlementsOf(
  graph: StrategicGraph,
  owners: NodeOwner[],
  side: Side,
): { index: number; node: number; depth: number }[] {
  const s = graph.settlements;
  const out: { index: number; node: number; depth: number }[] = [];
  for (let i = 0; i < s.cells.length; i++) {
    const node = s.node[i]!;
    if (node < 0) continue;
    const owner = owners[node]!;
    if (owner.kind === 'whole' && owner.side === side) out.push({ index: i, node, depth: 0 });
    else if (owner.kind === 'split') {
      const off = graph.barrierLines[owner.line]!.settlementOffset[i]!;
      if (Number.isFinite(off) && off !== 0 && sideAt(owner, off) === side)
        out.push({ index: i, node, depth: Math.abs(off) });
    }
  }
  return out;
}

/** Airbase site indices of a node held by `side`, with their distance from the dividing line (0 for whole nodes). */
function sitesOf(
  graph: StrategicGraph,
  owners: NodeOwner[],
  node: number,
  side: Side,
): { index: number; depth: number }[] {
  const owner = owners[node]!;
  const n = graph.nodes[node]!;
  const out: { index: number; depth: number }[] = [];
  if (owner.kind === 'whole' && owner.side === side) {
    for (let i = 0; i < n.airbases.cells.length; i++) out.push({ index: i, depth: 0 });
  } else if (owner.kind === 'split') {
    const off = graph.barrierLines[owner.line]!.airbaseOffset;
    for (let i = 0; i < off.length; i++) {
      if (off[i] !== 0 && sideAt(owner, off[i]!) === side)
        out.push({ index: i, depth: Math.abs(off[i]!) });
    }
  }
  return out;
}

function islandSplit(
  graph: StrategicGraph,
  nodes: number[],
): { pact: number[]; alliance: number[] } {
  let seedA = nodes[0]!;
  let seedB = nodes[1] ?? nodes[0]!;
  let best = -1;
  for (const a of nodes) {
    for (const b of nodes) {
      const d = nodeDistance(graph, a, b);
      if (a < b && Number.isFinite(d) && d > best) {
        best = d;
        seedA = a;
        seedB = b;
      }
    }
  }
  const groupA: number[] = [];
  const groupB: number[] = [];
  for (const id of nodes) {
    (nodeDistance(graph, id, seedA) <= nodeDistance(graph, id, seedB) ? groupA : groupB).push(id);
  }
  const area = (g: number[]) => g.reduce((s, id) => s + graph.nodes[id]!.area, 0);
  return area(groupA) >= area(groupB)
    ? { pact: groupA, alliance: groupB }
    : { pact: groupB, alliance: groupA };
}

/** Greedy pick by key (highest first), at least `spacing` apart. */
function pickSpaced<T>(
  items: T[],
  key: (t: T) => number,
  point: (t: T) => Point,
  spacing: number,
  limit: number,
  radius: number,
): T[] {
  const sorted = [...items].sort((a, b) => key(b) - key(a));
  const out: T[] = [];
  for (const it of sorted) {
    if (out.length >= limit) break;
    if (out.some((o) => surfaceDistance(point(o), point(it), radius) < spacing)) continue;
    out.push(it);
  }
  return out;
}

function nodeName(names: NameGenerator, n: LandNode): string {
  return n.kind === 'archipelago' ? `the ${names.short()} Islands` : names.land();
}

export function castCampaign(graph: StrategicGraph, detection: Detection, seed: WorldSeed): Cast {
  const r = rng(seed, 'casting');
  const names = new NameGenerator(r.fork('names'));
  const nodeNames = graph.nodes.map((n) => nodeName(names, n));

  // 1. Theaters.
  const theaters: Theater[] = detection.selected.map((c: TheaterCandidate, id) => ({
    id,
    kind: c.kind,
    key: c.key,
    name: theaterName(graph, c, nodeNames, names),
    fit: c.fit,
    nodes: c.nodes,
    front: c.front,
    lane: c.lane,
    chokepoint: c.chokepoint,
    attacker: c.kind === 'strategic' ? 'mutual' : 'pact',
    weight: THEATER_WEIGHT[c.kind] * (0.5 + 0.5 * Math.min(1, c.fit)),
  }));

  // 2. Territory.
  const owners: NodeOwner[] = graph.nodes.map(() => ({ kind: 'neutral' }));
  const islandGroups = new Map<number, { pact: number[]; alliance: number[] }>();
  for (const t of theaters) {
    if (t.kind === 'continental-front') {
      const f = graph.fronts[t.front!]!;
      owners[f.node] = { kind: 'split', line: f.start, pactSide: f.forwardSide };
    } else if (t.kind === 'island-campaign') {
      const split = islandSplit(graph, t.nodes);
      islandGroups.set(t.id, split);
      for (const id of split.pact) owners[id] = { kind: 'whole', side: 'pact' };
      for (const id of split.alliance) owners[id] = { kind: 'whole', side: 'alliance' };
    }
  }
  for (const t of theaters) {
    const claim = (id: number) => {
      if (owners[id]!.kind === 'neutral') owners[id] = { kind: 'whole', side: 'alliance' };
    };
    if (t.kind === 'sea-lane') claim(t.nodes[0]!);
    if (t.kind === 'chokepoint' && t.nodes.length > 0) claim(t.nodes[0]!);
  }

  const airbases: Record<Side, number> = { alliance: 0, pact: 0 };
  for (const side of SIDES) {
    for (let id = 0; id < graph.nodes.length; id++)
      airbases[side] += sitesOf(graph, owners, id, side).length;
  }

  // 4. Logistics links.
  const links: LogisticsLink[] = [];
  for (const t of theaters) {
    if (t.kind === 'sea-lane') {
      const front = theaters.find((x) => x.kind === 'continental-front' && x.front === t.front);
      if (front) links.push({ from: t.id, to: front.id, kind: 'supplies' });
    } else if (t.kind === 'chokepoint') {
      const lane = theaters.find((x) => x.kind === 'sea-lane' && x.lane === t.lane);
      if (lane) links.push({ from: t.id, to: lane.id, kind: 'protects' });
    } else if (t.kind === 'strategic') {
      for (const x of theaters) {
        if (x.kind === 'continental-front' || x.kind === 'island-campaign') {
          links.push({ from: t.id, to: x.id, kind: 'industry' });
        }
      }
    }
  }

  // 5. Range factor.
  const rangeTargets: RangeFactorTarget[] = [];
  for (const t of theaters) {
    if (t.kind === 'continental-front') {
      const f = graph.fronts[t.front!]!;
      const line = graph.barrierLines[f.start]!;
      const pact = line.sides[f.forwardSide];
      const alliance = line.sides[f.forwardSide === 1 ? 0 : 1];
      const required = Math.max(
        Math.min(REAR_BASE_DEPTH, alliance.depth) + pact.depth,
        Math.min(REAR_BASE_DEPTH, pact.depth) + alliance.depth,
      );
      rangeTargets.push({
        label: `${t.name}: strike depth`,
        required,
        reference: MEDIUM_STRIKE_RADIUS,
      });
    } else if (t.kind === 'sea-lane') {
      const lane = graph.lanes[t.lane!]!;
      rangeTargets.push({
        label: `${t.name}: bomber reach`,
        required: lane.length,
        reference: LONG_RANGE_BOMBER_RADIUS,
      });
    } else if (t.kind === 'island-campaign') {
      const g = islandGroups.get(t.id)!;
      let required = 0;
      for (const a of g.pact) {
        for (const b of g.alliance) {
          const d = nodeDistance(graph, a, b) + graph.nodes[b]!.extent;
          if (Number.isFinite(d)) required = Math.max(required, d);
        }
      }
      rangeTargets.push({
        label: `${t.name}: strike reach`,
        required,
        reference: MEDIUM_STRIKE_RADIUS,
      });
    }
  }
  const needed = rangeTargets.reduce((m, x) => Math.max(m, x.required / x.reference), 0);
  const rangeFactor = Math.min(RANGE_FACTOR_MAX, Math.max(RANGE_FACTOR_MIN, needed));

  // 6. Regions.
  const regions = castRegions(graph, theaters, owners, r.fork('regions'));

  const cast: Cast = {
    theaters,
    owners,
    links,
    rangeFactor,
    rangeTargets,
    regions,
    airbases,
    nodeNames,
    briefing: '',
  };
  cast.briefing = writeBriefing(graph, cast, names);
  return cast;
}

function theaterName(
  graph: StrategicGraph,
  c: TheaterCandidate,
  nodeNames: string[],
  names: NameGenerator,
): string {
  switch (c.kind) {
    case 'continental-front':
      return `${nodeNames[c.nodes[0]!]} front`;
    case 'sea-lane':
      return `${nodeNames[c.nodes[0]!]}–${nodeNames[c.nodes[1]!]} sea lane`.replace(/the /g, '');
    case 'chokepoint': {
      const cp = graph.chokepoints[c.chokepoint!]!;
      return cp.kind === 'strait' ? `${names.short()} Strait` : `${names.short()} Island`;
    }
    case 'island-campaign':
      return `${names.short()} Sea campaign`;
    case 'strategic':
      return 'Strategic theater';
  }
}

function castRegions(
  graph: StrategicGraph,
  theaters: Theater[],
  owners: NodeOwner[],
  r: Rng,
): Region[] {
  const R = graph.radius;
  const regions: Region[] = [];
  const nodes = graph.nodes;

  // Industry: up to three per side, deep in its territory, on its largest urban clusters.
  for (const side of SIDES) {
    const rs = r.fork(`industry-${side}`);
    const towns = settlementsOf(graph, owners, side);
    const pts = graph.settlements;
    const cands: { point: Point; key: number }[] = [];
    if (towns.length > 0) {
      const deepest = new Map<number, number>();
      for (const t of towns) deepest.set(t.node, Math.max(deepest.get(t.node) ?? 0, t.depth));
      let maxMass = 0;
      const mass = towns.map((t) => {
        const p = settlementPoint(pts, t.index);
        let m = 0;
        for (const o of towns) {
          if (surfaceDistance(p, settlementPoint(pts, o.index), R) <= INDUSTRY_CLUSTER_RADIUS)
            m += pts.population[o.index]!;
        }
        maxMass = Math.max(maxMass, m);
        return m;
      });
      const all = towns.map((t, i) => ({
        deep: !(
          owners[t.node]!.kind === 'split' && t.depth < Math.min(400e3, 0.6 * deepest.get(t.node)!)
        ),
        point: settlementPoint(pts, t.index),
        key: Math.sqrt(mass[i]! / maxMass) * (0.75 + 0.5 * rs.nextFloat()),
      }));
      // Deep in the territory where possible; anywhere it holds towns otherwise.
      const deep = all.filter((c) => c.deep);
      cands.push(...(deep.length > 0 ? deep : all));
    } else {
      // No settlements (synthetic worlds): flat lowland sites, as before milestone 5.
      for (let id = 0; id < nodes.length; id++) {
        const sites = sitesOf(graph, owners, id, side);
        const deepest = sites.reduce((m, x) => Math.max(m, x.depth), 0);
        for (const x of sites) {
          const u = rs.nextFloat();
          if (owners[id]!.kind === 'split' && x.depth < Math.min(400e3, 0.6 * deepest)) continue;
          cands.push({
            point: sitePoint(nodes[id]!.airbases, x.index),
            key: nodes[id]!.airbases.scores[x.index]! * 0.5 + u * 0.5,
          });
        }
      }
    }
    const pick = pickSpaced(
      cands,
      (c) => c.key,
      (c) => c.point,
      250e3,
      3,
      R,
    );
    for (const p of pick) {
      regions.push({ kind: 'industry', side, point: p.point, radius: 60e3, theater: -1 });
    }
  }

  for (const t of theaters) {
    if (t.kind === 'continental-front') {
      const f = graph.fronts[t.front!]!;
      const owner = owners[f.node] as NodeOwner & { kind: 'split' };
      const node = nodes[f.node]!;
      // Bases: densest 100–400 km behind the start line, up to four regions per side.
      for (const side of SIDES) {
        const band = sitesOf(graph, owners, f.node, side).filter(
          (s) => s.depth >= 100e3 && s.depth <= 400e3,
        );
        const pick = pickSpaced(
          band,
          (s) => node.airbases.scores[s.index]! - s.depth / 1e7,
          (s) => sitePoint(node.airbases, s.index),
          150e3,
          4,
          R,
        );
        for (const p of pick) {
          regions.push({
            kind: 'base',
            side,
            point: sitePoint(node.airbases, p.index),
            radius: 100e3,
            theater: t.id,
          });
        }
        // Best port on each side.
        const off = graph.barrierLines[owner.line]!.portOffset;
        for (let i = 0; i < off.length; i++) {
          if (off[i] !== 0 && sideAt(owner, off[i]!) === side) {
            regions.push({
              kind: 'port',
              side,
              point: sitePoint(node.ports, i),
              radius: 30e3,
              theater: t.id,
            });
            break;
          }
        }
      }
      // Ground combat: along the start line every ~150 km, and the corridors.
      const line = graph.barrierLines[f.start]!;
      const count = line.points.length / 3;
      let last: Point | null = null;
      for (let i = 0; i < count; i++) {
        const p = polylinePoint(line.points, i);
        if (last && surfaceDistance(last, p, R) < 150e3 && i < count - 1) continue;
        regions.push({ kind: 'ground', side: 'pact', point: p, radius: 60e3, theater: t.id });
        last = p;
      }
      for (const c of f.corridors) {
        if (c.line === f.start)
          regions.push({
            kind: 'ground',
            side: 'pact',
            point: c.point,
            radius: 100e3,
            theater: t.id,
          });
      }
    } else if (t.kind === 'sea-lane') {
      const lane = graph.lanes[t.lane!]!;
      for (const [node, port] of [
        [lane.a, lane.portA],
        [lane.b, lane.portB],
      ] as const) {
        regions.push({
          kind: 'port',
          side: 'alliance',
          point: sitePoint(nodes[node]!.ports, port),
          radius: 30e3,
          theater: t.id,
        });
      }
      const rear = nodes[t.nodes[0]!]!;
      if (rear.airbases.cells.length > 0) {
        regions.push({
          kind: 'base',
          side: 'alliance',
          point: sitePoint(rear.airbases, 0),
          radius: Math.min(300e3, rear.extent),
          theater: t.id,
        });
      }
    } else if (t.kind === 'chokepoint') {
      const cp = graph.chokepoints[t.chokepoint!]!;
      if (cp.kind === 'island') {
        regions.push({
          kind: 'base',
          side: 'alliance',
          point: cp.point,
          radius: 40e3,
          theater: t.id,
        });
        regions.push({
          kind: 'ground',
          side: 'alliance',
          point: cp.point,
          radius: 40e3,
          theater: t.id,
        });
      }
    } else if (t.kind === 'island-campaign') {
      for (const id of t.nodes) {
        const owner = owners[id]!;
        if (owner.kind !== 'whole') continue;
        const n = nodes[id]!;
        const radius = Math.min(300e3, Math.max(40e3, n.extent));
        if (n.airbases.cells.length > 0) {
          regions.push({
            kind: 'base',
            side: owner.side,
            point: sitePoint(n.airbases, 0),
            radius,
            theater: t.id,
          });
        }
        if (n.ports.cells.length > 0) {
          regions.push({
            kind: 'port',
            side: owner.side,
            point: sitePoint(n.ports, 0),
            radius: 30e3,
            theater: t.id,
          });
        }
        if (owner.side === 'alliance') {
          regions.push({
            kind: 'ground',
            side: 'alliance',
            point: n.centroid,
            radius: Math.min(150e3, radius),
            theater: t.id,
          });
        }
      }
    }
  }
  return regions;
}
