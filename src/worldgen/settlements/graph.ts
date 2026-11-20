/**
 * The street graph (proposal 0009, decision 262): polylines of every street class
 * become a planar graph, whose bounded faces are the blocks.
 *
 * 1. **Snapping.** Free street ends are extended by `snap` m, so a street that stops
 *    just short of another meets it; what overshoots is trimmed in step 4.
 * 2. **Splitting.** Every crossing of two pieces becomes a node.
 * 3. **Merging.** Nodes within `merge` m become one; parallel edges between the same
 *    nodes collapse to the widest class.
 * 4. **Trimming.** Dead ends shorter than the overshoot are removed (repeatedly).
 * 5. **Faces.** With each node's edges sorted by angle, walking every half-edge and
 *    turning to the previous edge counterclockwise traces the faces; counterclockwise
 *    ones (positive area) are bounded. Dead ends are pruned for this walk only.
 */
import { polyArea, segIntersect, SpatialHash } from './geom';
import type { Poly } from './geom';

export interface GraphLine {
  kind: number;
  points: number[];
  /** Whether its ends may be extended to meet other lines. */
  extend: boolean;
}

export interface GraphEdge {
  a: number;
  b: number;
  kind: number;
  /** All points from node a to node b. */
  points: number[];
}

export interface StreetGraph {
  nodes: number[];
  edges: GraphEdge[];
}

export function buildGraph(lines: GraphLine[], snap: number, merge = 3): StreetGraph {
  // 1. Extend free ends.
  const polys = lines.map((l) => {
    const p = l.points.slice();
    if (l.extend && p.length >= 4) {
      const n = p.length;
      const ext = (ix: number, jx: number) => {
        const dx = p[ix]! - p[jx]!;
        const dy = p[ix + 1]! - p[jx + 1]!;
        const d = Math.hypot(dx, dy) || 1;
        return [p[ix]! + (dx / d) * snap, p[ix + 1]! + (dy / d) * snap];
      };
      const head = ext(0, 2);
      const tail = ext(n - 2, n - 4);
      p.unshift(head[0]!, head[1]!);
      p.push(tail[0]!, tail[1]!);
    }
    return p;
  });
  // 2. Crossings: per polyline, cuts at (segment, t).
  const segs = new SpatialHash<[number, number]>(60);
  polys.forEach((p, li) => {
    for (let i = 0; i + 3 < p.length; i += 2) {
      segs.addBox(
        Math.min(p[i]!, p[i + 2]!),
        Math.min(p[i + 1]!, p[i + 3]!),
        Math.max(p[i]!, p[i + 2]!),
        Math.max(p[i + 1]!, p[i + 3]!),
        [li, i / 2],
      );
    }
  });
  const cuts: Map<number, number[]>[] = polys.map(() => new Map());
  const addCut = (li: number, si: number, t: number) => {
    let l = cuts[li]!.get(si);
    if (!l) cuts[li]!.set(si, (l = []));
    l.push(t);
  };
  const seen = new Set<string>();
  polys.forEach((p, li) => {
    for (let i = 0; i + 3 < p.length; i += 2) {
      const si = i / 2;
      const x0 = Math.min(p[i]!, p[i + 2]!);
      const y0 = Math.min(p[i + 1]!, p[i + 3]!);
      const x1 = Math.max(p[i]!, p[i + 2]!);
      const y1 = Math.max(p[i + 1]!, p[i + 3]!);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const r = Math.hypot(x1 - x0, y1 - y0) / 2 + 1;
      segs.near(cx, cy, r, ([lj, sj]) => {
        if (lj < li || (lj === li && Math.abs(sj - si) <= 1)) return;
        const key = `${li},${si},${lj},${sj}`;
        if (seen.has(key)) return;
        seen.add(key);
        const q = polys[lj]!;
        const hit = segIntersect(
          p[i]!,
          p[i + 1]!,
          p[i + 2]!,
          p[i + 3]!,
          q[sj * 2]!,
          q[sj * 2 + 1]!,
          q[sj * 2 + 2]!,
          q[sj * 2 + 3]!,
        );
        if (!hit) return;
        addCut(li, si, hit[0]);
        addCut(lj, sj, hit[1]);
      });
    }
  });
  // 3. Nodes, merged within `merge` m.
  const nodes: number[] = [];
  const nodeHash = new SpatialHash<number>(merge * 2);
  const nodeAt = (x: number, y: number): number => {
    let found = -1;
    nodeHash.near(x, y, merge, (n) => {
      if ((nodes[n * 2]! - x) ** 2 + (nodes[n * 2 + 1]! - y) ** 2 <= merge * merge) {
        found = n;
        return true;
      }
      return false;
    });
    if (found >= 0) return found;
    const id = nodes.length / 2;
    nodes.push(x, y);
    nodeHash.add(x, y, id);
    return id;
  };
  const edgeMap = new Map<string, GraphEdge>();
  polys.forEach((p, li) => {
    const n = p.length / 2;
    if (n < 2) return;
    // Vertices with node flags.
    const verts: [number, number, boolean][] = [];
    for (let i = 0; i < n; i++) {
      verts.push([p[i * 2]!, p[i * 2 + 1]!, i === 0 || i === n - 1]);
      const ts = cuts[li]!.get(i);
      if (ts && i < n - 1) {
        ts.sort((a, b) => a - b);
        for (const t of ts) {
          verts.push([
            p[i * 2]! + (p[i * 2 + 2]! - p[i * 2]!) * t,
            p[i * 2 + 1]! + (p[i * 2 + 3]! - p[i * 2 + 1]!) * t,
            true,
          ]);
        }
      }
    }
    let startNode = nodeAt(verts[0]![0], verts[0]![1]);
    let pts: number[] = [verts[0]![0], verts[0]![1]];
    for (let k = 1; k < verts.length; k++) {
      const [x, y, isNode] = verts[k]!;
      pts.push(x, y);
      if (!isNode) continue;
      const end = nodeAt(x, y);
      if (end !== startNode) {
        pts[0] = nodes[startNode * 2]!;
        pts[1] = nodes[startNode * 2 + 1]!;
        pts[pts.length - 2] = nodes[end * 2]!;
        pts[pts.length - 1] = nodes[end * 2 + 1]!;
        const key = startNode < end ? `${startNode},${end}` : `${end},${startNode}`;
        const old = edgeMap.get(key);
        if (!old || lines[li]!.kind < old.kind) {
          edgeMap.set(key, { a: startNode, b: end, kind: lines[li]!.kind, points: pts });
        }
      }
      startNode = end;
      pts = [x, y];
    }
  });
  let edges = [...edgeMap.values()];
  // 4. Trim overshoots: dead ends no longer than the extension.
  for (let round = 0; round < 3; round++) {
    const degree = new Map<number, number>();
    for (const e of edges) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const before = edges.length;
    edges = edges.filter((e) => {
      const dead = degree.get(e.a) === 1 || degree.get(e.b) === 1;
      return !(dead && edgeLength(e) <= snap * 1.05 + merge);
    });
    if (edges.length === before) break;
  }
  return { nodes, edges };
}

export function edgeLength(e: GraphEdge): number {
  let s = 0;
  for (let i = 0; i + 3 < e.points.length; i += 2) {
    s += Math.hypot(e.points[i + 2]! - e.points[i]!, e.points[i + 3]! - e.points[i + 1]!);
  }
  return s;
}

export interface Face {
  polygon: Poly;
  /** Per polygon vertex: the class of the edge that leaves it. */
  kinds: number[];
}

/** Bounded faces of the graph, counterclockwise, dead ends pruned. */
export function faces(g: StreetGraph, maxSteps = 4000): Face[] {
  // Prune dead ends for the walk.
  let live = g.edges.slice();
  for (;;) {
    const degree = new Map<number, number>();
    for (const e of live) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const next = live.filter((e) => degree.get(e.a)! > 1 && degree.get(e.b)! > 1 && e.a !== e.b);
    if (next.length === live.length) break;
    live = next;
  }
  // Each node's half-edges by angle.
  const out = new Map<number, { to: number; edge: number; angle: number }[]>();
  live.forEach((e, k) => {
    const p = e.points;
    const n = p.length;
    const a0 = Math.atan2(p[3]! - p[1]!, p[2]! - p[0]!);
    const a1 = Math.atan2(p[n - 3]! - p[n - 1]!, p[n - 4]! - p[n - 2]!);
    let la = out.get(e.a);
    if (!la) out.set(e.a, (la = []));
    la.push({ to: e.b, edge: k, angle: a0 });
    let lb = out.get(e.b);
    if (!lb) out.set(e.b, (lb = []));
    lb.push({ to: e.a, edge: k, angle: a1 });
  });
  for (const l of out.values()) l.sort((x, y) => x.angle - y.angle);
  const used = new Set<string>();
  const result: Face[] = [];
  for (let k = 0; k < live.length; k++) {
    for (const forward of [true, false]) {
      const key0 = `${k},${forward ? 1 : 0}`;
      if (used.has(key0)) continue;
      const poly: number[] = [];
      const kinds: number[] = [];
      let edge = k;
      let fwd = forward;
      let ok = false;
      for (let step = 0; step < maxSteps; step++) {
        const key = `${edge},${fwd ? 1 : 0}`;
        if (used.has(key)) {
          ok = key === key0 && step > 0;
          break;
        }
        used.add(key);
        const e = live[edge]!;
        const p = e.points;
        const n = p.length / 2;
        // Points from the start node, leaving out the end node (the next edge adds it).
        for (let i = 0; i < n - 1; i++) {
          const j = fwd ? i : n - 1 - i;
          poly.push(p[j * 2]!, p[j * 2 + 1]!);
          kinds.push(e.kind);
        }
        const v = fwd ? e.b : e.a;
        const from = fwd ? e.a : e.b;
        const list = out.get(v)!;
        let pos = list.findIndex((h) => h.edge === edge && h.to === from);
        if (pos < 0) pos = 0;
        const nxt = list[(pos - 1 + list.length) % list.length]!;
        edge = nxt.edge;
        fwd = live[edge]!.a === v && (live[edge]!.b === nxt.to || live[edge]!.a !== live[edge]!.b);
      }
      if (ok && poly.length >= 6 && polyArea(poly) > 0) result.push({ polygon: poly, kinds });
    }
  }
  return result;
}
