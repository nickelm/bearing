/**
 * Roads and bridges (milestone 5).
 *
 * - **Trunk links.** Within each landmass, towns and cities are linked along
 *   the edges of their relative neighborhood graph (pairs up to MAX_LINK
 *   apart) plus the minimum spanning tree, so every landmass's trunk network
 *   is connected and sparse, like a real road map.
 * - **Local links.** Every settlement then links to its Gabriel-graph
 *   neighbors up to LOCAL_LINK apart (decision 71), so roads pass through
 *   villages and form loops instead of ending at them. A feeder road joins any
 *   village group still off the trunk network.
 * - **Routing.** Links are routed most important first (√(pop_a · pop_b) /
 *   distance) by A* over the coarse grid's 8-neighbors. A step costs its
 *   length × the mean movement cost of its cells (movement.ts); entering a
 *   river that needs a bridge adds BRIDGE_PENALTY plus a term in the river's
 *   width; a diagonal step that would slip between two cells of such a river
 *   is not allowed. Steps along an existing road cost REUSE_FACTOR of that,
 *   so later links merge into earlier ones: trunk roads form where traffic
 *   concentrates.
 * - **Hierarchy** (decision 103). A gravity model sets each road's class: every
 *   pair of trunk settlements on a landmass exchanges P_a · P_b / d² (d the
 *   distance in km, at least TRAFFIC_MIN_DISTANCE), assigned to the shortest path
 *   over the finished network. The busiest edges making up MOTORWAY_SHARE of the
 *   network's length become motorways, the next TRUNK_SHARE trunk roads, the
 *   rest secondary roads. Polylines are cut at junctions, settlements and class
 *   changes.
 * - **Bridges.** A bridge is where the network crosses a river at least
 *   BRIDGE_MIN_WIDTH wide: a connected group of road cells on the river with
 *   road attached on both banks (RiverGeometry.side).
 *
 * Deterministic: no random numbers; ties break by cell and settlement index.
 */
import { MinHeap } from '../../core/heap';
import { RoadClass } from './graph';
import type { BridgeList, RoadNetwork, SettlementList } from './graph';
import type { StrategicContext } from './input';
import { RiverGeometry } from './movement';

/** Longest direct link between two settlements (m). */
export const MAX_LINK = 350e3;
/** Cost factor of steps along an existing road. */
export const REUSE_FACTOR = 0.3;
/** Fixed bridge cost, in cell lengths, plus one cell per BRIDGE_WIDTH_SCALE m of river. */
const BRIDGE_PENALTY = 1.5;
const BRIDGE_WIDTH_SCALE = 80;
/** Settlement pairs closer than this count as this far apart in the gravity model (km). */
export const TRAFFIC_MIN_DISTANCE = 20;
/** Shares of the network's length (busiest first) that become motorways and trunk roads. */
export const MOTORWAY_SHARE = 0.07;
export const TRUNK_SHARE = 0.2;

/** Grid edges of a road network with their traffic, keyed by `edgeKey`. */
export type RoadEdges = Map<number, number>;

export class RoadBuilder {
  readonly edges: RoadEdges = new Map();
  readonly rivers: RiverGeometry;
  private readonly g: Float64Array;
  private readonly prev: Int32Array;
  private readonly stamp: Int32Array;
  private readonly closed: Int32Array;
  private round = 0;
  private readonly heap = new MinHeap(4096);

  constructor(
    private readonly ctx: StrategicContext,
    readonly cost: Float32Array,
  ) {
    const n = ctx.grid.cellCount;
    this.rivers = new RiverGeometry(ctx);
    this.g = new Float64Array(n);
    this.prev = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.closed = new Int32Array(n);
  }

  get cellCount(): number {
    return this.ctx.grid.cellCount;
  }

  edgeKey(a: number, b: number): number {
    return a < b ? a * this.ctx.grid.cellCount + b : b * this.ctx.grid.cellCount + a;
  }

  /** True if the diagonal step a→b slips between two consecutive cells of a bridged river. */
  private crossesDiagonally(a: number, b: number): boolean {
    const n4 = this.ctx.grid.neighbors4;
    let p = -1;
    let q = -1;
    for (let i = 0; i < 4; i++) {
      const x = n4[a * 4 + i]!;
      if (x === b) return false; // not diagonal
      for (let j = 0; j < 4; j++) {
        if (n4[b * 4 + j] === x) {
          if (p < 0) p = x;
          else q = x;
        }
      }
    }
    return p >= 0 && q >= 0 && this.rivers.flowsBetween(p, q);
  }

  /** Cost of the step a→b (Infinity if not allowed). */
  stepCost(a: number, b: number): number {
    const { grid, radius } = this.ctx;
    const ca = this.cost[a]!;
    const cb = this.cost[b]!;
    if (!Number.isFinite(ca) || !Number.isFinite(cb)) return Infinity;
    const len = grid.angleBetween(a, b) * radius;
    if (this.edges.has(this.edgeKey(a, b))) return len * 0.5 * (ca + cb) * REUSE_FACTOR;
    if (this.crossesDiagonally(a, b)) return Infinity;
    let c = len * 0.5 * (ca + cb);
    if (this.rivers.isBridged(b)) {
      c += this.ctx.cellSize * (BRIDGE_PENALTY + this.rivers.width(b) / BRIDGE_WIDTH_SCALE);
    }
    return c;
  }

  /**
   * Least-cost path from `from` to `to` (A*), or to the first cell passing
   * `isTarget` when `to` is −1 (Dijkstra). Gives up beyond `maxCost`.
   * Returns the cells from `from` to the target, or null.
   */
  route(
    from: number,
    to: number,
    isTarget: ((c: number) => boolean) | null = null,
    maxCost = Infinity,
  ): number[] | null {
    const { grid, radius } = this.ctx;
    const r = ++this.round;
    const g = this.g;
    const heap = this.heap;
    heap.clear();
    const c3 = grid.centers;
    const h = (c: number): number => {
      if (to < 0) return 0;
      const dx = c3[c * 3]! - c3[to * 3]!;
      const dy = c3[c * 3 + 1]! - c3[to * 3 + 1]!;
      const dz = c3[c * 3 + 2]! - c3[to * 3 + 2]!;
      // Chord ≤ arc, and no step costs less than REUSE_FACTOR per meter: admissible.
      return Math.sqrt(dx * dx + dy * dy + dz * dz) * radius * REUSE_FACTOR;
    };
    this.stamp[from] = r;
    g[from] = 0;
    this.prev[from] = -1;
    heap.push(h(from), from);
    let end = -1;
    while (heap.size > 0) {
      const c = heap.pop();
      if (this.closed[c] === r) continue;
      this.closed[c] = r;
      if (c === to || (to < 0 && c !== from && isTarget?.(c))) {
        end = c;
        break;
      }
      const gc = g[c]!;
      if (gc > maxCost) break;
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[c * 8 + k]!;
        if (nb < 0 || this.closed[nb] === r) continue;
        const step = this.stepCost(c, nb);
        if (!Number.isFinite(step)) continue;
        const ng = gc + step;
        if (this.stamp[nb] !== r || ng < g[nb]!) {
          this.stamp[nb] = r;
          g[nb] = ng;
          this.prev[nb] = c;
          heap.push(ng + h(nb), nb);
        }
      }
    }
    if (end < 0) return null;
    const path: number[] = [];
    for (let c = end; c >= 0; c = this.prev[c]!) path.push(c);
    return path.reverse();
  }

  /** Adds a routed path's edges with `traffic`. */
  addPath(path: readonly number[], traffic: number): void {
    for (let i = 1; i < path.length; i++) {
      const k = this.edgeKey(path[i - 1]!, path[i]!);
      this.edges.set(k, (this.edges.get(k) ?? 0) + traffic);
    }
  }

  /** True if any road edge touches cell c. */
  hasRoadAt(c: number): boolean {
    return this.cellsOnRoad().has(c);
  }

  private cellCache: { size: number; cells: Set<number> } | null = null;

  /** Cells the network touches (cached until edges change). */
  cellsOnRoad(): Set<number> {
    if (this.cellCache?.size === this.edges.size) return this.cellCache.cells;
    const n = this.ctx.grid.cellCount;
    const cells = new Set<number>();
    for (const k of this.edges.keys()) {
      cells.add(Math.floor(k / n));
      cells.add(k % n);
    }
    this.cellCache = { size: this.edges.size, cells };
    return cells;
  }
}

/** Links between settlements: relative neighborhood graph (≤ MAX_LINK) ∪ minimum spanning tree, per landmass. */
export function settlementLinks(
  ctx: StrategicContext,
  s: SettlementList,
  include: (i: number) => boolean = () => true,
): { a: number; b: number; d: number }[] {
  const label = ctx.labels.label;
  const R = ctx.radius;
  const groups = new Map<number, number[]>();
  for (let i = 0; i < s.cells.length; i++) {
    if (!include(i)) continue;
    const id = label[s.cells[i]!]!;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = []));
    g.push(i);
  }
  const P = s.points;
  const dist = (i: number, j: number) => {
    const dot =
      P[i * 3]! * P[j * 3]! + P[i * 3 + 1]! * P[j * 3 + 1]! + P[i * 3 + 2]! * P[j * 3 + 2]!;
    return R * Math.acos(Math.max(-1, Math.min(1, dot)));
  };
  const links: { a: number; b: number; d: number }[] = [];
  for (const id of [...groups.keys()].sort((x, y) => x - y)) {
    const m = groups.get(id)!;
    const n = m.length;
    if (n < 2) continue;
    const D = new Float64Array(n * n);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) D[i * n + j] = D[j * n + i] = dist(m[i]!, m[j]!);
    const keep = new Set<number>();
    // Relative neighborhood graph: no third settlement closer to both ends.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dij = D[i * n + j]!;
        if (dij > MAX_LINK) continue;
        let ok = true;
        for (let k = 0; k < n && ok; k++) {
          if (k !== i && k !== j && Math.max(D[i * n + k]!, D[j * n + k]!) < dij) ok = false;
        }
        if (ok) keep.add(i * n + j);
      }
    }
    // Prim's minimum spanning tree, so far-apart clusters still connect.
    const inTree = new Uint8Array(n);
    const best = new Float64Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    best[0] = 0;
    for (let it = 0; it < n; it++) {
      let u = -1;
      for (let v = 0; v < n; v++) if (!inTree[v] && (u < 0 || best[v]! < best[u]!)) u = v;
      inTree[u] = 1;
      if (from[u]! >= 0) keep.add(Math.min(u, from[u]!) * n + Math.max(u, from[u]!));
      for (let v = 0; v < n; v++) {
        if (!inTree[v] && D[u * n + v]! < best[v]!) {
          best[v] = D[u * n + v]!;
          from[v] = u;
        }
      }
    }
    for (const k of [...keep].sort((x, y) => x - y)) {
      const i = Math.floor(k / n);
      const j = k % n;
      links.push({ a: m[i]!, b: m[j]!, d: D[k]! });
    }
  }
  return links;
}

/** Routes every settlement link into `builder`, most important first. */
export function routeSettlementLinks(
  builder: RoadBuilder,
  s: SettlementList,
  links: { a: number; b: number; d: number }[],
): void {
  const order = links
    .map((l, i) => ({
      ...l,
      i,
      traffic: Math.sqrt(s.population[l.a]! * s.population[l.b]!) / 1000,
    }))
    .sort((x, y) => y.traffic / y.d - x.traffic / x.d || x.i - y.i);
  for (const l of order) {
    const path = builder.route(s.cells[l.a]!, s.cells[l.b]!);
    if (path) builder.addPath(path, l.traffic);
  }
}

/**
 * Polylines from grid edges: cut at junctions (degree ≠ 2), at `breaks`
 * cells and where the road class changes. `edges` maps each edge to its
 * traffic; `classes` gives each edge's class (secondary where missing).
 * Deterministic in cell order.
 */
export function roadPolylines(
  ctx: StrategicContext,
  edges: RoadEdges,
  breaks: ReadonlySet<number> = new Set(),
  classes: ReadonlyMap<number, RoadClass> = new Map(),
): RoadNetwork {
  const n = ctx.grid.cellCount;
  const adj = new Map<number, number[]>();
  const keys = [...edges.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    const a = Math.floor(k / n);
    const b = k % n;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      let l = adj.get(x);
      if (!l) adj.set(x, (l = []));
      l.push(y);
    }
  }
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const cls = (a: number, b: number) => classes.get(key(a, b)) ?? RoadClass.Secondary;
  const isBreak = (c: number) => {
    const l = adj.get(c)!;
    return l.length !== 2 || breaks.has(c) || cls(c, l[0]!) !== cls(c, l[1]!);
  };
  const seen = new Set<number>();
  const lines: { cells: number[]; cls: number; traffic: number }[] = [];
  const walk = (start: number, next: number) => {
    const cells = [start];
    let prev = start;
    let cur = next;
    let traffic = 0;
    for (;;) {
      seen.add(key(prev, cur));
      traffic = Math.max(traffic, edges.get(key(prev, cur))!);
      cells.push(cur);
      if (cur === start || isBreak(cur)) break;
      const l = adj.get(cur)!;
      const nx = l[0] === prev ? l[1]! : l[0]!;
      if (seen.has(key(cur, nx))) break;
      prev = cur;
      cur = nx;
    }
    lines.push({ cells, cls: cls(cells[0]!, cells[1]!), traffic });
  };
  const cellsSorted = [...adj.keys()].sort((a, b) => a - b);
  for (const c of cellsSorted) {
    if (!isBreak(c)) continue;
    for (const nb of adj.get(c)!) if (!seen.has(key(c, nb))) walk(c, nb);
  }
  // Closed loops without a break: start at their smallest cell.
  for (const c of cellsSorted) {
    for (const nb of adj.get(c)!) if (!seen.has(key(c, nb))) walk(c, nb);
  }
  const count = lines.length;
  const total = lines.reduce((s, l) => s + l.cells.length, 0);
  const net: RoadNetwork = {
    count,
    offsets: new Uint32Array(count + 1),
    cells: new Int32Array(total),
    points: new Float64Array(total * 3),
    roadClass: new Uint8Array(count),
    traffic: new Float32Array(count),
    route: new Int32Array(count).fill(-1),
  };
  let o = 0;
  const g = ctx.grid.centers;
  lines.forEach((l, k) => {
    net.offsets[k] = o;
    net.roadClass[k] = l.cls;
    net.traffic[k] = l.traffic;
    for (const c of l.cells) {
      net.cells[o] = c;
      net.points.set([g[c * 3]!, g[c * 3 + 1]!, g[c * 3 + 2]!], o * 3);
      o++;
    }
  });
  net.offsets[count] = o;
  return net;
}

/** Bridges where `edges` cross bridged rivers; `net` gives each bridge its road polyline. */
export function findBridges(
  ctx: StrategicContext,
  rivers: RiverGeometry,
  edges: RoadEdges,
  net: RoadNetwork,
): BridgeList {
  const n = ctx.grid.cellCount;
  const adj = new Map<number, number[]>();
  for (const k of [...edges.keys()].sort((a, b) => a - b)) {
    const a = Math.floor(k / n);
    const b = k % n;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      let l = adj.get(x);
      if (!l) adj.set(x, (l = []));
      l.push(y);
    }
  }
  // Best (widest-class) polyline touching each cell.
  const roadOf = new Map<number, number>();
  for (let k = 0; k < net.count; k++) {
    for (let p = net.offsets[k]!; p < net.offsets[k + 1]!; p++) {
      const c = net.cells[p]!;
      const cur = roadOf.get(c);
      if (cur === undefined || net.roadClass[k]! < net.roadClass[cur]!) roadOf.set(c, k);
    }
  }
  const wet = [...adj.keys()].filter((c) => rivers.isBridged(c)).sort((a, b) => a - b);
  const wetSet = new Set(wet);
  const done = new Set<number>();
  const out: { cell: number; width: number; road: number }[] = [];
  for (const start of wet) {
    if (done.has(start)) continue;
    // Connected road cells on rivers.
    const comp: number[] = [];
    const stack = [start];
    done.add(start);
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      for (const x of adj.get(c)!) {
        if (wetSet.has(x) && !done.has(x)) {
          done.add(x);
          stack.push(x);
        }
      }
    }
    let plus = false;
    let minus = false;
    for (const c of comp) {
      for (const x of adj.get(c)!) {
        if (wetSet.has(x)) continue;
        const s = rivers.side(c, x);
        if (s > 0) plus = true;
        else if (s < 0) minus = true;
      }
    }
    if (!plus || !minus) continue;
    let best = comp[0]!;
    for (const c of comp) {
      const w = rivers.width(c);
      const bw = rivers.width(best);
      if (w > bw || (w === bw && c < best)) best = c;
    }
    out.push({ cell: best, width: rivers.width(best), road: roadOf.get(best) ?? -1 });
  }
  out.sort((a, b) => a.cell - b.cell);
  const g = ctx.grid.centers;
  const b: BridgeList = {
    cells: Int32Array.from(out, (x) => x.cell),
    points: new Float64Array(out.length * 3),
    riverWidth: Float32Array.from(out, (x) => x.width),
    road: Int32Array.from(out, (x) => x.road),
    roadClass: Uint8Array.from(out, (x) =>
      x.road >= 0 ? net.roadClass[x.road]! : RoadClass.Secondary,
    ),
  };
  out.forEach((x, i) =>
    b.points.set([g[x.cell * 3]!, g[x.cell * 3 + 1]!, g[x.cell * 3 + 2]!], i * 3),
  );
  return b;
}

/** Settlements on the trunk network: towns and cities, or the TRUNK_MIN_COUNT largest per landmass. */
export const TRUNK_MIN_POPULATION = 20_000;
const TRUNK_MIN_COUNT = 3;

/**
 * Gravity-model traffic per edge of `edges` (decision 103): every pair of
 * `origins` settlements on the same road component exchanges
 * P_a · P_b / max(d, TRAFFIC_MIN_DISTANCE)² (d in km, great circle), carried on the
 * cheapest path over the network (step cost: length × mean movement cost). One
 * Dijkstra per origin; flows to the later origins accumulate up its shortest-path
 * tree. Edges no flow uses get 0.
 */
export function gravityTraffic(
  ctx: StrategicContext,
  edges: RoadEdges,
  cost: Float32Array,
  s: SettlementList,
  origins: readonly number[],
): Map<number, number> {
  const { grid, radius } = ctx;
  const n = grid.cellCount;
  const keys = [...edges.keys()].sort((a, b) => a - b);
  // Compact road graph.
  const index = new Map<number, number>();
  const cellOf: number[] = [];
  const id = (c: number) => {
    let i = index.get(c);
    if (i === undefined) {
      i = cellOf.length;
      index.set(c, i);
      cellOf.push(c);
    }
    return i;
  };
  const adj: { to: number; w: number; key: number }[][] = [];
  for (const k of keys) {
    const a = id(Math.floor(k / n));
    const b = id(k % n);
    const ca = cellOf[a]!;
    const cb = cellOf[b]!;
    const w = grid.angleBetween(ca, cb) * radius * 0.5 * (cost[ca]! + cost[cb]!);
    (adj[a] ??= []).push({ to: b, w, key: k });
    (adj[b] ??= []).push({ to: a, w, key: k });
  }
  const m = cellOf.length;
  const out = new Map<number, number>();
  for (const k of keys) out.set(k, 0);
  const order = [...origins].filter((i) => index.has(s.cells[i]!)).sort((a, b) => a - b);
  const dist = new Float64Array(m);
  const prev = new Int32Array(m);
  const prevKey = new Float64Array(m);
  const load = new Float64Array(m);
  const done = new Uint8Array(m);
  const heap = new MinHeap(1024);
  const P = s.points;
  for (let oi = 0; oi < order.length; oi++) {
    const a = order[oi]!;
    const src = index.get(s.cells[a]!)!;
    dist.fill(Infinity);
    done.fill(0);
    load.fill(0);
    prev.fill(-1);
    heap.clear();
    dist[src] = 0;
    heap.push(0, src);
    const settled: number[] = [];
    while (heap.size > 0) {
      const u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      settled.push(u);
      for (const e of adj[u] ?? []) {
        const nd = dist[u]! + e.w;
        if (nd < dist[e.to]!) {
          dist[e.to] = nd;
          prev[e.to] = u;
          prevKey[e.to] = e.key;
          heap.push(nd, e.to);
        }
      }
    }
    // Flows from a to every later origin it reaches.
    for (let oj = oi + 1; oj < order.length; oj++) {
      const b = order[oj]!;
      const t = index.get(s.cells[b]!)!;
      if (!done[t]) continue;
      const dot =
        P[a * 3]! * P[b * 3]! + P[a * 3 + 1]! * P[b * 3 + 1]! + P[a * 3 + 2]! * P[b * 3 + 2]!;
      const km = (radius * Math.acos(Math.max(-1, Math.min(1, dot)))) / 1000;
      const d = Math.max(TRAFFIC_MIN_DISTANCE, km);
      load[t] = load[t]! + (s.population[a]! * s.population[b]!) / (d * d);
    }
    // Accumulate up the shortest-path tree, farthest first.
    for (let i = settled.length - 1; i > 0; i--) {
      const u = settled[i]!;
      const l = load[u]!;
      if (l === 0) continue;
      const p = prev[u]!;
      load[p] = load[p]! + l;
      const k = prevKey[u]!;
      out.set(k, out.get(k)! + l);
    }
  }
  return out;
}

/**
 * Road classes from traffic (decision 103): edges in order of traffic, busiest
 * first (ties by edge key); motorways until MOTORWAY_SHARE of the total length,
 * trunk roads until MOTORWAY_SHARE + TRUNK_SHARE, then secondary roads. Edges
 * with no traffic are always secondary.
 */
export function classifyRoads(
  ctx: StrategicContext,
  traffic: ReadonlyMap<number, number>,
): Map<number, RoadClass> {
  const n = ctx.grid.cellCount;
  const items = [...traffic].map(([k, t]) => ({
    k,
    t,
    len: ctx.grid.angleBetween(Math.floor(k / n), k % n),
  }));
  const total = items.reduce((sum, x) => sum + x.len, 0);
  items.sort((a, b) => b.t - a.t || a.k - b.k);
  const out = new Map<number, RoadClass>();
  let cum = 0;
  for (const x of items) {
    const share = cum / Math.max(total, 1e-12);
    out.set(
      x.k,
      x.t <= 0
        ? RoadClass.Secondary
        : share < MOTORWAY_SHARE
          ? RoadClass.Motorway
          : share < MOTORWAY_SHARE + TRUNK_SHARE
            ? RoadClass.Trunk
            : RoadClass.Secondary,
    );
    cum += x.len;
  }
  return out;
}
/** Longest local link between neighboring settlements (m). */
export const LOCAL_LINK = 70e3;
/** A local link is dropped if its route costs more than this × its length (a detour round a mountain or a bay). */
const LOCAL_DETOUR = 2.5;
/** Feeder roads give up beyond this route cost (m of flat road). */
const FEEDER_MAX_COST = 120e3;

function trunkSettlements(s: SettlementList): Set<number> {
  const out = new Set<number>();
  const byNode = new Map<number, number[]>();
  for (let i = 0; i < s.cells.length; i++) {
    if (s.population[i]! >= TRUNK_MIN_POPULATION) out.add(i);
    const key = s.node[i]!;
    let l = byNode.get(key);
    if (!l) byNode.set(key, (l = []));
    l.push(i);
  }
  for (const l of byNode.values()) {
    l.sort((a, b) => s.population[b]! - s.population[a]! || a - b);
    for (const i of l.slice(0, TRUNK_MIN_COUNT)) out.add(i);
  }
  return out;
}

/**
 * Local links: the Gabriel graph of all settlements on a
 * landmass, restricted to pairs at most LOCAL_LINK apart. Each village gets
 * links to its natural neighbors, so roads run through villages to the next
 * one instead of ending at them; the graph has loops, as real country roads
 * do. Neighbors come from a bucket grid, so this is near-linear.
 */
export function localLinks(
  ctx: StrategicContext,
  s: SettlementList,
): { a: number; b: number; d: number }[] {
  const label = ctx.labels.label;
  const R = ctx.radius;
  const P = s.points;
  const n = s.cells.length;
  const reach = LOCAL_LINK / R;
  const bucket = (i: number) => [0, 1, 2].map((k) => Math.floor(P[i * 3 + k]! / reach));
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = bucket(i).join(',');
    let l = grid.get(key);
    if (!l) grid.set(key, (l = []));
    l.push(i);
  }
  const dist = (i: number, j: number) => {
    const dot =
      P[i * 3]! * P[j * 3]! + P[i * 3 + 1]! * P[j * 3 + 1]! + P[i * 3 + 2]! * P[j * 3 + 2]!;
    return R * Math.acos(Math.max(-1, Math.min(1, dot)));
  };
  // Neighbors within LOCAL_LINK on the same landmass, with distances.
  const near: { j: number; d: number }[][] = [];
  for (let i = 0; i < n; i++) {
    const [x, y, z] = bucket(i) as [number, number, number];
    const l: { j: number; d: number }[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
            if (j === i || label[s.cells[j]!] !== label[s.cells[i]!]) continue;
            const d = dist(i, j);
            if (d <= LOCAL_LINK) l.push({ j, d });
          }
        }
    l.sort((a, b) => a.d - b.d || a.j - b.j);
    near.push(l);
  }
  const links: { a: number; b: number; d: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (const { j, d } of near[i]!) {
      if (j <= i) continue;
      // Gabriel graph: no witness inside the circle on ij as diameter
      // (d_ik² + d_jk² < d²). Such a witness lies within d of i, so among i's neighbors.
      let ok = true;
      for (const { j: k, d: dik } of near[i]!) {
        if (dik >= d) break;
        const djk = dist(j, k);
        if (k !== j && dik * dik + djk * djk < d * d) {
          ok = false;
          break;
        }
      }
      if (ok) links.push({ a: i, b: j, d });
    }
  }
  return links;
}

/** Routes local links, most important first; a link whose route detours too far is dropped. */
function routeLocalLinks(
  builder: RoadBuilder,
  s: SettlementList,
  links: { a: number; b: number; d: number }[],
): void {
  const order = links
    .map((l, i) => ({
      ...l,
      i,
      traffic: Math.sqrt(s.population[l.a]! * s.population[l.b]!) / 1000,
    }))
    .sort((x, y) => y.traffic / y.d - x.traffic / x.d || x.i - y.i);
  for (const l of order) {
    const path = builder.route(s.cells[l.a]!, s.cells[l.b]!, null, l.d * LOCAL_DETOUR);
    if (path) builder.addPath(path, l.traffic);
  }
}

/**
 * Feeder roads, the fallback for settlements that local links left off the
 * trunk network: each road component without a trunk settlement, and each
 * settlement on no road, largest first, takes the cheapest route from its
 * largest settlement to the trunk network (or failing that any road) within
 * FEEDER_MAX_COST.
 */
function routeFeeders(builder: RoadBuilder, s: SettlementList, trunk: Set<number>): void {
  // Union-find over road cells.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    while (parent.get(x)! !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  const cellCount = builder.cellCount;
  for (const k of [...builder.edges.keys()].sort((a, b) => a - b)) {
    union(Math.floor(k / cellCount), k % cellCount);
  }
  for (const c of s.cells) if (!parent.has(c)) parent.set(c, c);
  const mainRoots = new Set<number>();
  for (const i of trunk) mainRoots.add(find(s.cells[i]!));
  const order = [...s.cells.keys()].sort((a, b) => s.population[b]! - s.population[a]! || a - b);
  for (const i of order) {
    const c = s.cells[i]!;
    if (mainRoots.has(find(c))) continue;
    const own = find(c);
    let path = builder.route(
      c,
      -1,
      (x) => parent.has(x) && mainRoots.has(find(x)),
      FEEDER_MAX_COST,
    );
    // No trunk in reach (an island of villages): join any other road.
    path ??= builder.route(c, -1, (x) => builder.hasRoadAt(x) && find(x) !== own, FEEDER_MAX_COST);
    if (!path) continue;
    builder.addPath(path, s.population[i]! / 1000);
    const joinsMain = mainRoots.has(find(path[path.length - 1]!));
    for (let k = 1; k < path.length; k++) union(path[k - 1]!, path[k]!);
    if (joinsMain) mainRoots.add(find(c));
  }
}

export interface RoadResult {
  builder: RoadBuilder;
  network: RoadNetwork;
  bridges: BridgeList;
}

/** The civilian road network between settlements, and its bridges. */
export function buildRoads(
  ctx: StrategicContext,
  settlements: SettlementList,
  cost: Float32Array,
): RoadResult {
  const builder = new RoadBuilder(ctx, cost);
  // Trunk roads between towns, then local roads between neighboring
  // settlements, then feeders for anything still off the network.
  const trunk = trunkSettlements(settlements);
  routeSettlementLinks(
    builder,
    settlements,
    settlementLinks(ctx, settlements, (i) => trunk.has(i)),
  );
  routeLocalLinks(builder, settlements, localLinks(ctx, settlements));
  routeFeeders(builder, settlements, trunk);
  const traffic = gravityTraffic(ctx, builder.edges, cost, settlements, [...trunk]);
  const network = roadPolylines(
    ctx,
    traffic,
    new Set(settlements.cells),
    classifyRoads(ctx, traffic),
  );
  const bridges = findBridges(ctx, builder.rivers, builder.edges, network);
  return { builder, network, bridges };
}
