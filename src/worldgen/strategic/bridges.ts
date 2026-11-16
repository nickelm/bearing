/**
 * What each bridge is (decision 179): its kind and span from the river, the
 * valley and what it carries; the traffic over it; and the detour if it falls.
 * Bridges are found where roads and railways cross rivers that need one
 * (`findBridges` in roads.ts); every one is a target (decision 163). No random
 * numbers.
 *
 * - **Kind.** A suspension bridge over rivers wider than `suspensionWidth`; a
 *   viaduct where a railway, or a motorway or trunk road, crosses a valley
 *   deeper than `viaductDepth` (railways) or `viaductDepthRoad`; an arch where
 *   the banks are steeper than `archSlope` and the span short; a truss for
 *   railways and long spans; otherwise a beam.
 * - **Span.** The river's width plus abutments; a viaduct spans its valley
 *   (`valleySpan` × its depth); a suspension bridge most of the river.
 * - **Detour.** The shortest way round on the same network with the bridge's
 *   cell removed, between its neighbors on opposite banks, less the way across,
 *   searched out to `detourReach`.
 */
import { MinHeap } from '../../core/heap';
import { BridgeKind, DETOUR_NONE, RoadClass } from './graph';
import type { BridgeList, RoadNetwork } from './graph';
import type { StrategicContext } from './input';
import type { RiverGeometry } from './movement';

export const BRIDGE_TUNING = {
  suspensionWidth: 500,
  viaductDepth: 60,
  viaductDepthRoad: 80,
  valleySpan: 4,
  archSlope: 0.12,
  archMaxSpan: 250,
  trussSpan: 120,
  /** Abutments: span = river width × `riverSpan` + `abutments` m. */
  riverSpan: 1.4,
  abutments: 20,
  /** Longest detour searched (m); beyond it there is none. */
  detourReach: 400e3,
};

/** Empty description arrays for a bridge list of `n` (filled by `describeBridges`). */
export function bridgeFields(
  n: number,
): Pick<BridgeList, 'kind' | 'span' | 'traffic' | 'detour' | 'names'> {
  return {
    kind: new Uint8Array(n),
    span: new Float32Array(n),
    traffic: new Float32Array(n),
    detour: new Float32Array(n),
    names: Array.from({ length: n }, () => ''),
  };
}

/** Fills kind, span, traffic and detour of every bridge of `b` on network `net`. */
export function describeBridges(
  ctx: StrategicContext,
  rivers: RiverGeometry,
  b: BridgeList,
  net: RoadNetwork,
  rail: boolean,
  t = BRIDGE_TUNING,
): void {
  const { grid, height, slope } = ctx;
  const R = ctx.radius;
  // The network as cell adjacency, from its polylines.
  const adj = new Map<number, Set<number>>();
  const link = (x: number, y: number) => {
    let l = adj.get(x);
    if (!l) adj.set(x, (l = new Set()));
    l.add(y);
  };
  for (let k = 0; k < net.count; k++)
    for (let p = net.offsets[k]! + 1; p < net.offsets[k + 1]!; p++) {
      link(net.cells[p - 1]!, net.cells[p]!);
      link(net.cells[p]!, net.cells[p - 1]!);
    }
  // Lines per cell, for railways' traffic.
  const lines = new Map<number, number>();
  if (rail)
    for (let k = 0; k < net.count; k++)
      for (let p = net.offsets[k]!; p < net.offsets[k + 1]!; p++)
        lines.set(net.cells[p]!, (lines.get(net.cells[p]!) ?? 0) + 1);
  const length = (x: number, y: number) => grid.angleBetween(x, y) * R;

  for (let i = 0; i < b.cells.length; i++) {
    const c = b.cells[i]!;
    const w = b.riverWidth[i]!;
    // The valley: banks either side of the river, their height over the river and steepness.
    let rise = 0;
    let steep = 0;
    let banks = 0;
    for (let k = 0; k < 8; k++) {
      const x = grid.neighbors8[c * 8 + k]!;
      if (x < 0 || rivers.side(c, x) === 0 || rivers.isBridged(x)) continue;
      rise += Math.max(0, height[x]! - height[c]!);
      steep += slope[x]!;
      banks++;
    }
    const depth = banks > 0 ? rise / banks : 0;
    const bankSlope = banks > 0 ? steep / banks : 0;
    let span = t.riverSpan * w + t.abutments;
    const roadClass = b.roadClass[i]!;
    const major = rail || roadClass <= RoadClass.Trunk;
    let kind: BridgeKind;
    if (w > t.suspensionWidth) {
      kind = BridgeKind.Suspension;
      span = 1.2 * w;
    } else if (major && depth > (rail ? t.viaductDepth : t.viaductDepthRoad)) {
      kind = BridgeKind.Viaduct;
      span = Math.max(span, t.valleySpan * depth);
    } else if (bankSlope > t.archSlope && span < t.archMaxSpan) kind = BridgeKind.Arch;
    else if (rail || span > t.trussSpan) kind = BridgeKind.Truss;
    else kind = BridgeKind.Beam;
    b.kind[i] = kind;
    b.span[i] = span;
    b.traffic[i] = rail ? (lines.get(c) ?? 1) : b.road[i]! >= 0 ? net.traffic[b.road[i]!]! : 0;

    // Detour: remove the bridge's cell from the network, then the shortest path between
    // its network neighbors on opposite banks (a road along the valley keeps its other
    // river cells: only the crossing goes).
    const gone = new Set<number>([c]);
    const near = [...(adj.get(c) ?? [])].sort((p, q) => p - q);
    const left = near.filter((y) => rivers.side(c, y) > 0);
    const right = near.filter((y) => rivers.side(c, y) < 0);
    let from = -1;
    let to = -1;
    if (left.length > 0 && right.length > 0) {
      from = left[0]!;
      to = right[0]!;
    } else if (near.length >= 2) {
      // Along the river's line on both sides: the two neighbors farthest apart.
      let far = -1;
      for (let a = 0; a < near.length; a++)
        for (let q = a + 1; q < near.length; q++) {
          const dd = length(near[a]!, near[q]!);
          if (dd > far) {
            far = dd;
            from = near[a]!;
            to = near[q]!;
          }
        }
    }
    if (from < 0 || to < 0) {
      b.detour[i] = DETOUR_NONE;
      continue;
    }
    const across = length(from, c) + length(c, to);
    const dist = new Map<number, number>([[from, 0]]);
    const heap = new MinHeap();
    heap.push(0, from);
    let found = -1;
    while (heap.size > 0) {
      const x = heap.pop();
      const dx = dist.get(x)!;
      if (x === to) {
        found = dx;
        break;
      }
      if (dx > t.detourReach + across) break;
      for (const y of adj.get(x) ?? []) {
        if (gone.has(y)) continue;
        const nd = dx + length(x, y);
        if (nd < (dist.get(y) ?? Infinity)) {
          dist.set(y, nd);
          heap.push(nd, y);
        }
      }
    }
    b.detour[i] = found < 0 ? DETOUR_NONE : Math.max(0, found - across);
  }
}
