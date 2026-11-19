/**
 * Road and rail networks as node-and-edge graphs for the sim (roadmap R1.8):
 * what interdiction plans against (R2.1), what strikes cut (R2.2) and what
 * supply and movement run over (R2.3).
 *
 * Built on the main thread from the strategic graph's polylines (campaignInput)
 * and sent to the worker as plain typed arrays:
 *
 * - **Nodes** are the cells where polylines meet or end (a junction), the cells
 *   that carry a bridge, and the cells next to a bridge.
 * - **Edges** are the chains of cells between two nodes, with their length on
 *   the sphere, road class (the best of the polylines that run there) and points.
 * - **Bridges** are cut by disabling every edge that touches the bridge's
 *   cell, which is what the worldgen's detour does (bridges.ts removes the cell),
 *   so a detour found here equals the bridge's recorded detour.
 *
 * Polyline points are cell centers, and lengths use CubeGrid.angleBetween's
 * formula, so distances agree with the worldgen's to the bit.
 */
import type { Dir } from '../../core/greatCircle';
import { MinHeap } from '../../core/heap';
import type { BridgeList, RoadNetwork } from '../../worldgen/strategic/graph';

export type NetworkKind = 'road' | 'rail';

/** A network as the worker receives it (structured-cloneable). */
export interface NetworkInput {
  kind: NetworkKind;
  radius: number;
  /** Coarse cell and unit direction (xyz interleaved) of each node. */
  nodeCell: Int32Array;
  nodePoint: Float64Array;
  /** Edge endpoints (node indices), length (m), road class (railways: 0). */
  edgeA: Int32Array;
  edgeB: Int32Array;
  edgeLength: Float64Array;
  edgeClass: Uint8Array;
  /** Bridge carried (index into `bridges`) by an edge that touches a bridge cell, or −1. */
  edgeBridge: Int32Array;
  /** Edge points, unit directions xyz interleaved, from A to B: [pointOffsets[e], pointOffsets[e + 1]). */
  pointOffsets: Uint32Array;
  points: Float64Array;
  /**
   * The network's bridges, in the order of the source bridge lists: each one's
   * node, source list (0, 1, … in the order given to `buildNetworkInput`), index
   * in it, and recorded detour (m, or DETOUR_NONE).
   */
  bridgeNode: Int32Array;
  bridgeSource: Uint8Array;
  bridgeIndex: Int32Array;
  bridgeDetour: Float32Array;
}

/** Angle between unit directions i and j of `p`, as CubeGrid.angleBetween computes it. */
export function pointAngle(p: ArrayLike<number>, i: number, j: number): number {
  const ax = p[i * 3]!;
  const ay = p[i * 3 + 1]!;
  const az = p[i * 3 + 2]!;
  const bx = p[j * 3]!;
  const by = p[j * 3 + 1]!;
  const bz = p[j * 3 + 2]!;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz);
}

/**
 * The graph of one network: polyline sets (e.g. the civilian roads and the
 * airbase spurs) and their bridge lists, merged by cell.
 */
export function buildNetworkInput(
  kind: NetworkKind,
  radius: number,
  nets: readonly RoadNetwork[],
  bridgeLists: readonly BridgeList[],
): NetworkInput {
  // Cell adjacency with the best (lowest) class per cell link, and each cell's center.
  const adj = new Map<number, Map<number, number>>();
  const center = new Map<number, [number, number, number]>();
  const link = (x: number, y: number, cls: number) => {
    let l = adj.get(x);
    if (!l) adj.set(x, (l = new Map()));
    l.set(y, Math.min(l.get(y) ?? Infinity, cls));
  };
  for (const net of nets) {
    for (let k = 0; k < net.count; k++) {
      const cls = kind === 'rail' ? 0 : net.roadClass[k]!;
      for (let p = net.offsets[k]!; p < net.offsets[k + 1]!; p++) {
        const c = net.cells[p]!;
        if (!center.has(c)) {
          center.set(c, [net.points[p * 3]!, net.points[p * 3 + 1]!, net.points[p * 3 + 2]!]);
        }
        if (p > net.offsets[k]!) {
          const b = net.cells[p - 1]!;
          if (b !== c) {
            link(b, c, cls);
            link(c, b, cls);
          }
        }
      }
    }
  }
  // Bridges, in list order; a cell may carry more than one (a road and a spur).
  const bridgeCells: { cell: number; source: number; index: number; detour: number }[] = [];
  bridgeLists.forEach((b, source) => {
    for (let i = 0; i < b.cells.length; i++) {
      bridgeCells.push({ cell: b.cells[i]!, source, index: i, detour: b.detour[i]! });
    }
  });
  const isBridge = new Set(bridgeCells.map((b) => b.cell).filter((c) => adj.has(c)));
  const isNode = (c: number) => {
    if (isBridge.has(c)) return true;
    const l = adj.get(c)!;
    if (l.size !== 2) return true;
    for (const y of l.keys()) if (isBridge.has(y)) return true;
    return false;
  };
  const cells = [...adj.keys()].sort((a, b) => a - b);
  const nodeOf = new Map<number, number>();
  for (const c of cells) if (isNode(c)) nodeOf.set(c, nodeOf.size);
  // Closed loops without a node get one at their smallest cell.
  const reached = new Set<number>();
  const visitChain = (start: number) => {
    const stack = [start];
    reached.add(start);
    while (stack.length) {
      const x = stack.pop()!;
      for (const y of adj.get(x)!.keys()) {
        if (!reached.has(y)) {
          reached.add(y);
          stack.push(y);
        }
      }
    }
  };
  for (const c of nodeOf.keys()) if (!reached.has(c)) visitChain(c);
  for (const c of cells) {
    if (!reached.has(c)) {
      nodeOf.set(c, nodeOf.size);
      visitChain(c);
    }
  }

  // Edges: walk each chain from a node to the next node.
  const edges: { a: number; b: number; length: number; cls: number; cells: number[] }[] = [];
  const used = new Set<string>();
  const key = (x: number, y: number) => (x < y ? `${x},${y}` : `${y},${x}`);
  const angle = (x: number, y: number) => {
    const p = center.get(x)!;
    const q = center.get(y)!;
    return pointAngle([...p, ...q], 0, 1);
  };
  for (const start of [...nodeOf.keys()].sort((a, b) => nodeOf.get(a)! - nodeOf.get(b)!)) {
    const nbs = [...adj.get(start)!.keys()].sort((a, b) => a - b);
    for (const first of nbs) {
      if (used.has(key(start, first))) continue;
      const chain = [start];
      let prev = start;
      let cur = first;
      let length = 0;
      let cls = Infinity;
      for (;;) {
        used.add(key(prev, cur));
        length += angle(prev, cur) * radius;
        cls = Math.min(cls, adj.get(prev)!.get(cur)!);
        chain.push(cur);
        if (nodeOf.has(cur)) break;
        const l = [...adj.get(cur)!.keys()];
        const next = l[0] === prev ? l[1]! : l[0]!;
        prev = cur;
        cur = next;
      }
      edges.push({ a: nodeOf.get(start)!, b: nodeOf.get(cur)!, length, cls, cells: chain });
    }
  }

  const nodeCount = nodeOf.size;
  const nodeCell = new Int32Array(nodeCount);
  const nodePoint = new Float64Array(nodeCount * 3);
  for (const [c, i] of nodeOf) {
    nodeCell[i] = c;
    nodePoint.set(center.get(c)!, i * 3);
  }
  const bridgeOfCell = new Map<number, number>();
  const bridges = bridgeCells.filter((b) => nodeOf.has(b.cell));
  bridges.forEach((b, i) => {
    if (!bridgeOfCell.has(b.cell)) bridgeOfCell.set(b.cell, i);
  });
  const total = edges.reduce((s, e) => s + e.cells.length, 0);
  const out: NetworkInput = {
    kind,
    radius,
    nodeCell,
    nodePoint,
    edgeA: new Int32Array(edges.length),
    edgeB: new Int32Array(edges.length),
    edgeLength: new Float64Array(edges.length),
    edgeClass: new Uint8Array(edges.length),
    edgeBridge: new Int32Array(edges.length).fill(-1),
    pointOffsets: new Uint32Array(edges.length + 1),
    points: new Float64Array(total * 3),
    bridgeNode: new Int32Array(bridges.map((b) => nodeOf.get(b.cell)!)),
    bridgeSource: new Uint8Array(bridges.map((b) => b.source)),
    bridgeIndex: new Int32Array(bridges.map((b) => b.index)),
    bridgeDetour: new Float32Array(bridges.map((b) => b.detour)),
  };
  let o = 0;
  edges.forEach((e, i) => {
    out.edgeA[i] = e.a;
    out.edgeB[i] = e.b;
    out.edgeLength[i] = e.length;
    out.edgeClass[i] = e.cls;
    const ends = [nodeCell[e.a]!, nodeCell[e.b]!];
    for (const c of ends) {
      const b = bridgeOfCell.get(c);
      if (b !== undefined) out.edgeBridge[i] = b;
    }
    out.pointOffsets[i] = o;
    for (const c of e.cells) out.points.set(center.get(c)!, 3 * o++);
  });
  out.pointOffsets[edges.length] = o;
  return out;
}

/** Shortest paths over a network, with cut bridges and closed nodes left out. */
export class NetworkGraph {
  /** Edges at each node: [nodeOffsets[n], nodeOffsets[n + 1]) into `nodeEdges`. */
  private readonly nodeOffsets: Uint32Array;
  private readonly nodeEdges: Int32Array;

  constructor(readonly input: NetworkInput) {
    const n = input.nodeCell.length;
    const degree = new Uint32Array(n + 1);
    for (let e = 0; e < input.edgeA.length; e++) {
      degree[input.edgeA[e]!]!++;
      degree[input.edgeB[e]!]!++;
    }
    this.nodeOffsets = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.nodeOffsets[i + 1] = this.nodeOffsets[i]! + degree[i]!;
    this.nodeEdges = new Int32Array(this.nodeOffsets[n]!);
    const fill = this.nodeOffsets.slice(0, n);
    for (let e = 0; e < input.edgeA.length; e++) {
      this.nodeEdges[fill[input.edgeA[e]!]!++] = e;
      this.nodeEdges[fill[input.edgeB[e]!]!++] = e;
    }
  }

  get nodeCount(): number {
    return this.input.nodeCell.length;
  }

  get edgeCount(): number {
    return this.input.edgeA.length;
  }

  get bridgeCount(): number {
    return this.input.bridgeNode.length;
  }

  /** Nodes joined to node `n` by an edge, with the edge. */
  neighbors(n: number): { node: number; edge: number }[] {
    const out: { node: number; edge: number }[] = [];
    for (let k = this.nodeOffsets[n]!; k < this.nodeOffsets[n + 1]!; k++) {
      const e = this.nodeEdges[k]!;
      out.push({
        node: this.input.edgeA[e] === n ? this.input.edgeB[e]! : this.input.edgeA[e]!,
        edge: e,
      });
    }
    return out;
  }

  /**
   * Shortest distance (m) from node `from` to node `to`, or Infinity, with the
   * bridges in `cut` impassable, searched out to `reach` (m). The path's nodes
   * come back in `path` when it is given.
   */
  distance(
    from: number,
    to: number,
    cut: ReadonlySet<number> = new Set(),
    reach = Infinity,
    path?: number[],
  ): number {
    const n = this.nodeCount;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const heap = new MinHeap();
    dist[from] = 0;
    heap.push(0, from);
    const cutNodes = new Set([...cut].map((b) => this.input.bridgeNode[b]!));
    while (heap.size > 0) {
      const d = heap.peekKey();
      const x = heap.pop();
      if (d > dist[x]!) continue;
      if (x === to) break;
      if (d > reach) return Infinity;
      for (let k = this.nodeOffsets[x]!; k < this.nodeOffsets[x + 1]!; k++) {
        const e = this.nodeEdges[k]!;
        const y = this.input.edgeA[e] === x ? this.input.edgeB[e]! : this.input.edgeA[e]!;
        if (cutNodes.has(y) || cutNodes.has(x)) continue;
        const nd = d + this.input.edgeLength[e]!;
        if (nd < dist[y]!) {
          dist[y] = nd;
          prev[y] = x;
          heap.push(nd, y);
        }
      }
    }
    if (path && Number.isFinite(dist[to]!)) {
      path.length = 0;
      for (let x = to; x >= 0; x = prev[x]!) path.push(x);
      path.reverse();
    }
    return dist[to]!;
  }

  /**
   * Shortest-path tree from node `from` (R2.1's supply lines): distance to every
   * node (Infinity beyond `reach` or cut off), and each node's previous node and
   * the edge to it (−1 at the root and where unreached), with the bridges in
   * `cut` impassable.
   */
  tree(
    from: number,
    cut: ReadonlySet<number> = new Set(),
    reach = Infinity,
  ): { dist: Float64Array; prev: Int32Array; prevEdge: Int32Array } {
    const n = this.nodeCount;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const prevEdge = new Int32Array(n).fill(-1);
    const heap = new MinHeap();
    const cutNodes = new Set([...cut].map((b) => this.input.bridgeNode[b]!));
    dist[from] = 0;
    heap.push(0, from);
    while (heap.size > 0) {
      const d = heap.peekKey();
      const x = heap.pop();
      if (d > dist[x]!) continue;
      if (cutNodes.has(x)) continue;
      for (let k = this.nodeOffsets[x]!; k < this.nodeOffsets[x + 1]!; k++) {
        const e = this.nodeEdges[k]!;
        const y = this.input.edgeA[e] === x ? this.input.edgeB[e]! : this.input.edgeA[e]!;
        if (cutNodes.has(y)) continue;
        const nd = d + this.input.edgeLength[e]!;
        if (nd > reach) continue;
        if (nd < dist[y]!) {
          dist[y] = nd;
          prev[y] = x;
          prevEdge[y] = e;
          heap.push(nd, y);
        }
      }
    }
    return { dist, prev, prevEdge };
  }

  /** The node nearest a unit direction, and its distance (m); −1 for an empty network. */
  nearestNode(d: Readonly<Dir>): { node: number; distance: number } {
    const p = this.input.nodePoint;
    let best = -1;
    let bestDot = -2;
    for (let i = 0; i < this.nodeCount; i++) {
      const c = p[i * 3]! * d[0] + p[i * 3 + 1]! * d[1] + p[i * 3 + 2]! * d[2];
      if (c > bestDot) {
        bestDot = c;
        best = i;
      }
    }
    return {
      node: best,
      distance: best < 0 ? Infinity : Math.acos(Math.min(1, bestDot)) * this.input.radius,
    };
  }
}
