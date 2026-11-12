/**
 * Routes (decision 103): road polylines chained into the roads a map names.
 *
 * - **Chains.** Within each road class, polylines join end to end where they
 *   continue nearly straight: at every cell where two or more polylines of the
 *   class end, the pairs that turn least (by the direction ROUTE_PROBE cells into
 *   each) join first, if they turn less than MAX_TURN. Following the joins gives
 *   the chains.
 * - **Numbers.** Motorway and trunk chains of at least ROUTE_MIN_LENGTH get route
 *   numbers, longest first: "M1", "M2", … for motorways, "R1", … for trunk roads.
 * - **Pass roads.** A chain whose highest cell lies in a mountain range and climbs
 *   at least PASS_MIN_HEIGHT (reference m) and PASS_MIN_CLIMB above both of its ends
 *   is a pass road; each range keeps its busiest pass road (widest class, then
 *   longest).
 * - **Coast roads.** A chain of at least COAST_MIN_LENGTH with COAST_MIN_SHARE of
 *   its cells on the coast is a coast road; each land node keeps its
 *   COAST_ROADS_PER_NODE longest.
 *
 * Names come later, from the toponymy stage (names/index.ts). Deterministic: no
 * random numbers; ties break by polyline index.
 */
import { FeatureKind, RoadClass, RouteKind } from './graph';
import type { FeatureList, RoadNetwork, RouteList } from './graph';
import type { StrategicContext } from './input';

/** Cells into a polyline that set its direction at a junction. */
const ROUTE_PROBE = 3;
/** Most a route may turn where two polylines join (rad). */
const MAX_TURN = (70 * Math.PI) / 180;
/** Shortest numbered route (m). */
export const ROUTE_MIN_LENGTH = 30e3;
/** A pass road's highest point (reference m) and its climb above both ends (m). */
export const PASS_MIN_HEIGHT = 900;
export const PASS_MIN_CLIMB = 400;
/** Shortest coast road (m), and the share of its cells on the coast. */
export const COAST_MIN_LENGTH = 80e3;
export const COAST_MIN_SHARE = 0.6;
const COAST_ROADS_PER_NODE = 2;

interface Chain {
  roads: number[];
  cls: number;
  cells: number[];
  length: number;
}

/** Unit vector from cell a toward cell b, in the plane of the grid's centers. */
function direction(c3: Float64Array, a: number, b: number): [number, number, number] {
  const x = c3[b * 3]! - c3[a * 3]!;
  const y = c3[b * 3 + 1]! - c3[a * 3 + 1]!;
  const z = c3[b * 3 + 2]! - c3[a * 3 + 2]!;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Chains of same-class polylines (see the module comment). */
export function roadChains(ctx: StrategicContext, roads: RoadNetwork): Chain[] {
  const c3 = ctx.grid.centers;
  const R = ctx.radius;
  const first = (k: number) => roads.cells[roads.offsets[k]!]!;
  const last = (k: number) => roads.cells[roads.offsets[k + 1]! - 1]!;
  const size = (k: number) => roads.offsets[k + 1]! - roads.offsets[k]!;
  // Direction leaving the end cell into the polyline.
  const probe = (k: number, end: 0 | 1) => {
    const o = roads.offsets[k]!;
    const n = size(k);
    const step = Math.min(ROUTE_PROBE, n - 1);
    const a = end === 0 ? roads.cells[o]! : roads.cells[o + n - 1]!;
    const b = end === 0 ? roads.cells[o + step]! : roads.cells[o + n - 1 - step]!;
    return direction(c3, a, b);
  };
  const ends = new Map<string, { k: number; end: 0 | 1 }[]>();
  for (let k = 0; k < roads.count; k++) {
    if (size(k) < 2 || first(k) === last(k)) continue;
    for (const end of [0, 1] as const) {
      const key = `${roads.roadClass[k]}:${end === 0 ? first(k) : last(k)}`;
      let l = ends.get(key);
      if (!l) ends.set(key, (l = []));
      l.push({ k, end });
    }
  }
  // Join the straightest pairs at each cell. partner[2k + end] = 2k' + end'.
  const partner = new Int32Array(roads.count * 2).fill(-1);
  const maxDot = -Math.cos(MAX_TURN);
  for (const key of [...ends.keys()].sort()) {
    const l = ends.get(key)!;
    if (l.length < 2) continue;
    const pairs: { i: number; j: number; dot: number }[] = [];
    const dirs = l.map((e) => probe(e.k, e.end));
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        if (l[i]!.k === l[j]!.k) continue;
        const a = dirs[i]!;
        const b = dirs[j]!;
        const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        if (dot < maxDot) pairs.push({ i, j, dot });
      }
    }
    pairs.sort((x, y) => x.dot - y.dot || x.i - y.i || x.j - y.j);
    const used = new Set<number>();
    for (const p of pairs) {
      if (used.has(p.i) || used.has(p.j)) continue;
      used.add(p.i);
      used.add(p.j);
      const a = l[p.i]!;
      const b = l[p.j]!;
      partner[a.k * 2 + a.end] = b.k * 2 + b.end;
      partner[b.k * 2 + b.end] = a.k * 2 + a.end;
    }
  }
  const seen = new Uint8Array(roads.count);
  const chains: Chain[] = [];
  const follow = (start: number, startEnd: 0 | 1) => {
    const chain: Chain = { roads: [], cls: roads.roadClass[start]!, cells: [], length: 0 };
    let k = start;
    let end = startEnd;
    while (k >= 0 && !seen[k]) {
      seen[k] = 1;
      chain.roads.push(k);
      const o = roads.offsets[k]!;
      const n = size(k);
      const cells = Array.from(roads.cells.subarray(o, o + n));
      if (end === 1) cells.reverse();
      for (let i = chain.cells.length ? 1 : 0; i < n; i++) chain.cells.push(cells[i]!);
      for (let i = 1; i < n; i++)
        chain.length += ctx.grid.angleBetween(cells[i - 1]!, cells[i]!) * R;
      const next = partner[k * 2 + (1 - end)]!;
      if (next < 0) break;
      k = next >> 1;
      end = (next & 1) as 0 | 1;
    }
    chains.push(chain);
  };
  // Open chains from their free ends, then closed loops.
  for (let k = 0; k < roads.count; k++) {
    if (seen[k]) continue;
    if (partner[k * 2]! < 0) follow(k, 0);
    else if (partner[k * 2 + 1]! < 0) follow(k, 1);
  }
  for (let k = 0; k < roads.count; k++) if (!seen[k]) follow(k, 0);
  return chains;
}

/**
 * Numbered, pass and coast routes over a finished road network; sets
 * `roads.route`. `nodeOfLandmass` maps landmass labels to land nodes (regions).
 */
export function buildRoutes(
  ctx: StrategicContext,
  roads: RoadNetwork,
  features: FeatureList,
  nodeOfLandmass: Int32Array,
): RouteList {
  const { grid, reliefScale } = ctx;
  const label = ctx.labels.label;
  const chains = roadChains(ctx, roads);
  const ref = (c: number) => ctx.height[c]! / reliefScale;
  const regionOf = (ch: Chain) => {
    const l = label[ch.cells[0]!]!;
    return l >= 0 ? (nodeOfLandmass[l] ?? -1) : -1;
  };
  const kind = new Map<Chain, number>();
  // Pass roads: the best per range.
  const bestPass = new Map<number, Chain>();
  for (const ch of chains) {
    let top = ch.cells[0]!;
    for (const c of ch.cells) if (ref(c) > ref(top)) top = c;
    const f = features.layers.relief[top]!;
    if (f < 0 || features.kind[f] !== FeatureKind.Range) continue;
    const ends = Math.max(ref(ch.cells[0]!), ref(ch.cells[ch.cells.length - 1]!));
    if (ref(top) < PASS_MIN_HEIGHT || ref(top) - ends < PASS_MIN_CLIMB) continue;
    const cur = bestPass.get(f);
    if (!cur || ch.cls < cur.cls || (ch.cls === cur.cls && ch.length > cur.length))
      bestPass.set(f, ch);
  }
  for (const ch of bestPass.values()) kind.set(ch, RouteKind.Pass);
  // Coast roads: the longest per node.
  const coastByNode = new Map<number, Chain[]>();
  for (const ch of chains) {
    if (kind.has(ch) || ch.length < COAST_MIN_LENGTH) continue;
    let coast = 0;
    for (const c of ch.cells) {
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[c * 8 + k]!;
        if (nb >= 0 && label[nb]! < 0) {
          coast++;
          break;
        }
      }
    }
    if (coast < COAST_MIN_SHARE * ch.cells.length) continue;
    const r = regionOf(ch);
    let l = coastByNode.get(r);
    if (!l) coastByNode.set(r, (l = []));
    l.push(ch);
  }
  for (const l of coastByNode.values()) {
    l.sort((a, b) => b.length - a.length || a.roads[0]! - b.roads[0]!);
    for (const ch of l.slice(0, COAST_ROADS_PER_NODE)) kind.set(ch, RouteKind.Coast);
  }
  // Numbers: motorways, then trunk roads, longest first.
  const numbers = new Map<Chain, string>();
  for (const [cls, prefix] of [
    [RoadClass.Motorway, 'M'],
    [RoadClass.Trunk, 'R'],
  ] as const) {
    const list = chains
      .filter((ch) => ch.cls === cls && ch.length >= ROUTE_MIN_LENGTH)
      .sort((a, b) => b.length - a.length || a.roads[0]! - b.roads[0]!);
    list.forEach((ch, i) => numbers.set(ch, `${prefix}${i + 1}`));
    for (const ch of list) if (!kind.has(ch)) kind.set(ch, RouteKind.Numbered);
  }
  // Store in chain order (which follows polyline order).
  const kept = chains.filter((ch) => kind.has(ch));
  const count = kept.length;
  const out: RouteList = {
    count,
    offsets: new Uint32Array(count + 1),
    roads: new Int32Array(kept.reduce((s, ch) => s + ch.roads.length, 0)),
    roadClass: Uint8Array.from(kept, (ch) => ch.cls),
    kind: Uint8Array.from(kept, (ch) => kind.get(ch)!),
    length: Float32Array.from(kept, (ch) => ch.length),
    region: Int32Array.from(kept, regionOf),
    numbers: kept.map((ch) => numbers.get(ch) ?? ''),
    names: kept.map(() => ''),
  };
  let o = 0;
  kept.forEach((ch, i) => {
    out.offsets[i] = o;
    for (const k of ch.roads) {
      out.roads[o++] = k;
      roads.route[k] = i;
    }
  });
  out.offsets[count] = o;
  return out;
}

/** The text a map shows for a route: its name, its number, or both ("the Kessar Pass Road (R4)"). */
export function routeLabel(routes: RouteList, i: number): string {
  const name = routes.names[i]!;
  const number = routes.numbers[i]!;
  if (name && number) return `${name} (${number})`;
  return name || number;
}
