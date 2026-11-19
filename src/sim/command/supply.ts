/**
 * Supply lines behind the fronts (roadmap R2.1): what interdiction plans
 * against. Each side supplies each of its front segments (front.ts) from its
 * depots and its largest rear cities over the road graph and from its rail
 * yards over the railway graph (R1.8), by the shortest way with cut bridges
 * left out. The cities (REAR_SOURCES, R2.2) are where supply enters the
 * theater; they carry it but are no targets themselves. Every bridge, depot,
 * rail yard and road edge on those ways carries the supply of the segments it
 * serves, weighted by their pressure; the most used element of a side carries 1.
 *
 * The ground war (R2.3) will move supply over the same ways; until then the
 * lines only rank targets. Planning reads the campaign input and the damage
 * state, never the terrain (rule 9).
 */
import type { Side } from '../../campaign/cast';
import { arcDistance } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import type { NetworkGraph } from '../ground/network';
import type { CampaignInput } from './campaignInput';
import { frontPoint } from './front';
import type { FrontSegment } from './front';
import { polylineStations } from '../../core/greatCircle';

/** How far behind its segment a side's supply arrives (m). */
export const SUPPLY_SETBACK = 30e3;
/** A depot, rail yard or segment further than this from the network is off it (m). */
export const NETWORK_SNAP = 40e3;
/** Longest supply way searched (m). */
export const SUPPLY_REACH = 600e3;
/** Rear cities that feed the front: the largest REAR_SOURCES of a side between these distances from it (m). */
export const REAR_SOURCES = 3;
export const REAR_DEPTH: readonly [number, number] = [100e3, 500e3];
/** Road edges worth striking lie this far behind the front (m). */
export const ROAD_DEPTH: readonly [number, number] = [15e3, 120e3];
/** At most this many road edges per side, at least ROAD_SPACING apart. */
export const ROAD_TARGETS = 6;
export const ROAD_SPACING = 40e3;

export interface RoadTarget {
  /** Edge of the road graph. */
  edge: number;
  usage: number;
  /** The edge's middle point. */
  point: Dir;
}

export interface SupplyLines {
  side: Side;
  /** Supply carried by target site id (depots, rail yards, bridges), 0..1. */
  sites: Map<number, number>;
  /** The road edges that carry the most, most used first. */
  roads: RoadTarget[];
}

export interface SupplyNetworks {
  road: NetworkGraph;
  rail: NetworkGraph;
  /** Cut bridges, as indices into each network's bridges. */
  cutRoad: ReadonlySet<number>;
  cutRail: ReadonlySet<number>;
}

const ROAD_LISTS = ['road', 'spur'] as const;
const RAIL_LISTS = ['rail'] as const;

/** Index of a target's bridge in a network's bridge arrays, or −1. */
function bridgeOf(
  g: NetworkGraph,
  lists: readonly string[],
  ref: { list: string; index: number },
): number {
  const source = lists.indexOf(ref.list);
  if (source < 0) return -1;
  const inp = g.input;
  for (let b = 0; b < inp.bridgeNode.length; b++) {
    if (inp.bridgeSource[b] === source && inp.bridgeIndex[b] === ref.index) return b;
  }
  return -1;
}

function edgeMiddle(g: NetworkGraph, e: number): Dir {
  const inp = g.input;
  const a = inp.pointOffsets[e]!;
  const b = inp.pointOffsets[e + 1]!;
  const i = a + Math.floor((b - a - 1) / 2);
  return [inp.points[i * 3]!, inp.points[i * 3 + 1]!, inp.points[i * 3 + 2]!];
}

/** A side's supply lines to its segments of every front. */
export function supplyLines(
  input: CampaignInput,
  side: Side,
  segments: readonly FrontSegment[],
  nets: SupplyNetworks,
): SupplyLines {
  const R = input.radius;
  const roadUse = new Float64Array(nets.road.edgeCount);
  const roadNodeUse = new Float64Array(nets.road.nodeCount);
  const railNodeUse = new Float64Array(nets.rail.nodeCount);
  const siteUse = new Map<number, number>();
  const sources = input.targets.filter(
    (x) =>
      x.side === side &&
      (x.kind === 'supply-depot' || x.kind === 'fuel-depot' || x.kind === 'rail-yard'),
  );
  const snap = (g: NetworkGraph, p: Readonly<Dir>): number => {
    if (g.nodeCount === 0) return -1;
    const n = g.nearestNode(p);
    return n.distance <= NETWORK_SNAP ? n.node : -1;
  };
  const sourceNodes = sources.map((x) =>
    snap(x.kind === 'rail-yard' ? nets.rail : nets.road, x.point),
  );
  const depth = (p: Readonly<Dir>) => {
    let d = Infinity;
    for (const s of segments) d = Math.min(d, arcDistance(p, s.point, R));
    return d;
  };
  const rear = input.places
    .filter((p) => p.side === side)
    .map((p) => ({ p, d: depth(p.point) }))
    .filter((x) => x.d >= REAR_DEPTH[0] && x.d <= REAR_DEPTH[1])
    .sort((a, b) => b.p.population - a.p.population || a.d - b.d)
    .slice(0, REAR_SOURCES)
    .map((x) => snap(nets.road, x.p.point))
    .filter((n) => n >= 0);
  const stations = new Map<number, Float64Array>();
  const sinks: Dir[] = [];
  for (const seg of segments) {
    const f = input.fronts.find((x) => x.theater === seg.theater);
    if (!f) continue;
    let st = stations.get(f.theater);
    if (!st) stations.set(f.theater, (st = polylineStations(f.points, R)));
    const sink = frontPoint(f, st, (seg.from + seg.to) / 2, side, SUPPLY_SETBACK, R).point;
    sinks.push(sink);
    for (const [g, nodeUse, rail] of [
      [nets.road, roadNodeUse, false],
      [nets.rail, railNodeUse, true],
    ] as const) {
      const root = snap(g, sink);
      if (root < 0) continue;
      const tree = g.tree(root, rail ? nets.cutRail : nets.cutRoad, SUPPLY_REACH);
      const walk = (n: number): boolean => {
        if (n < 0 || !Number.isFinite(tree.dist[n]!)) return false;
        for (let y = n; y >= 0; y = tree.prev[y]!) {
          nodeUse[y]! += seg.pressure;
          const e = tree.prevEdge[y]!;
          if (e >= 0 && !rail) roadUse[e]! += seg.pressure;
        }
        return true;
      };
      sources.forEach((x, i) => {
        if ((x.kind === 'rail-yard') !== rail) return;
        if (walk(sourceNodes[i]!)) siteUse.set(x.id, (siteUse.get(x.id) ?? 0) + seg.pressure);
      });
      if (!rail) for (const n of rear) walk(n);
    }
  }
  // Bridges carry what passes their node.
  for (const x of input.targets) {
    if (x.side !== side || !x.bridge) continue;
    const rail = x.bridge.list === 'rail';
    const g = rail ? nets.rail : nets.road;
    const b = bridgeOf(g, rail ? RAIL_LISTS : ROAD_LISTS, x.bridge);
    if (b < 0) continue;
    const u = (rail ? railNodeUse : roadNodeUse)[g.input.bridgeNode[b]!]!;
    if (u > 0) siteUse.set(x.id, u);
  }
  // Road edges behind the front, away from bridges, spaced apart.
  const roads: RoadTarget[] = [];
  const order = [...roadUse.keys()]
    .filter((e) => roadUse[e]! > 0 && nets.road.input.edgeBridge[e]! < 0)
    .sort((a, b) => roadUse[b]! - roadUse[a]! || a - b);
  for (const e of order) {
    if (roads.length >= ROAD_TARGETS) break;
    const point = edgeMiddle(nets.road, e);
    let depth = Infinity;
    for (const s of segments) depth = Math.min(depth, arcDistance(point, s.point, R));
    if (depth < ROAD_DEPTH[0] || depth > ROAD_DEPTH[1]) continue;
    if (roads.some((r) => arcDistance(r.point, point, R) < ROAD_SPACING)) continue;
    roads.push({ edge: e, usage: roadUse[e]!, point });
  }
  let max = 0;
  for (const u of siteUse.values()) max = Math.max(max, u);
  for (const r of roads) max = Math.max(max, r.usage);
  if (max > 0) {
    for (const [k, u] of siteUse) siteUse.set(k, u / max);
    for (const r of roads) r.usage /= max;
  }
  return { side, sites: siteUse, roads };
}
