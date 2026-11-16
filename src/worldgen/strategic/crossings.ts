/**
 * Crossing sites (decision 175; proposal 0005, generation step 2): where a
 * river is easiest to bridge or ford, on the coarse grid, before settlements
 * and roads. A river cell that needs a bridge scores by:
 *
 * - **a straight reach:** its upstream and downstream directions aligned (a
 *   bend's outer bank erodes and its inner bank is soft bar);
 * - **firm banks:** ground on both sides neither flat floodplain or marsh nor
 *   cliff; gorges still score half, since an arch spans them;
 * - **one river:** not at a confluence (two bridges) or a mouth (an estuary);
 * - **a narrower river:** the widest rivers score less.
 *
 * Sites are the cells scoring at least `minScore`, best first, each keeping
 * other sites `spacing` cells away up- and downstream (ties to the lower cell
 * index), so each reach has its best crossing. Settlements are pulled toward them
 * (settlements.ts) and the road search discounts bridges there (roads.ts).
 * No random numbers.
 */
import type { CrossingList } from './graph';
import { smoothstep } from './input';
import type { StrategicContext } from './input';
import { RiverGeometry } from './movement';

export const CROSSING_TUNING = {
  minScore: 0.45,
  /** Sites are at least this many cells apart along a river. */
  spacing: 3,
  /** Habitability's water term gains this much at a site and its neighbors (settlements.ts). */
  pull: 0.35,
  /** The road search's bridge cost falls by this share at a site of score 1 (roads.ts). */
  discount: 0.5,
};

/** Crossing score per cell, 0..1 (0 where no river needs a bridge). */
export function crossingScores(ctx: StrategicContext, rivers: RiverGeometry): Float32Array {
  const { grid, receiver, slope, lakeDepth } = ctx;
  const label = ctx.labels.label;
  const g = grid.centers;
  const out = new Float32Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    if (!rivers.isBridged(c)) continue;
    const d = receiver[c]!;
    if (d < 0 || label[d]! < 0) continue; // a mouth: an estuary
    const u = rivers.upstream[c]!;
    // Straightness: cosine between the reach in and the reach out.
    let straight = 1;
    if (u >= 0) {
      const ix = g[c * 3]! - g[u * 3]!;
      const iy = g[c * 3 + 1]! - g[u * 3 + 1]!;
      const iz = g[c * 3 + 2]! - g[u * 3 + 2]!;
      const ox = g[d * 3]! - g[c * 3]!;
      const oy = g[d * 3 + 1]! - g[c * 3 + 1]!;
      const oz = g[d * 3 + 2]! - g[c * 3 + 2]!;
      const cos =
        (ix * ox + iy * oy + iz * oz) /
        Math.sqrt((ix * ix + iy * iy + iz * iz) * (ox * ox + oy * oy + oz * oz));
      straight = smoothstep(0.3, 0.95, cos);
    }
    // Banks: the cells either side of the river, by side.
    let left = 0;
    let right = 0;
    let nl = 0;
    let nr = 0;
    let donors = 0;
    let wet = false;
    for (let k = 0; k < 8; k++) {
      const x = grid.neighbors8[c * 8 + k]!;
      if (x < 0) continue;
      if (label[x]! < 0 || lakeDepth[x]! > 0) wet = true;
      if (receiver[x] === c && rivers.isBridged(x)) donors++;
      const s = rivers.side(c, x);
      if (s > 0) {
        left += slope[x]!;
        nl++;
      } else if (s < 0) {
        right += slope[x]!;
        nr++;
      }
    }
    if (wet || nl === 0 || nr === 0) continue;
    const bank = (sl: number) =>
      smoothstep(0.002, 0.012, sl) * (1 - 0.5 * smoothstep(0.12, 0.35, sl));
    const banks = Math.sqrt(bank(left / nl) * bank(right / nr));
    const single = donors >= 2 ? 0.3 : 1;
    const narrow = 1 - 0.3 * smoothstep(100, 600, rivers.width(c));
    out[c] = straight * banks * single * narrow;
  }
  return out;
}

/** The best crossing of each reach (see the module comment). */
export function crossingSites(
  ctx: StrategicContext,
  rivers: RiverGeometry,
  scores: Float32Array,
  t = CROSSING_TUNING,
): CrossingList {
  const { grid, receiver } = ctx;
  // Greedy suppression: the best candidates first (ties to the lower cell), each
  // claiming `spacing` cells up- and downstream, so straight reaches with equal
  // scores still get a site every few cells.
  const cand: number[] = [];
  for (let c = 0; c < grid.cellCount; c++) if (scores[c]! >= t.minScore) cand.push(c);
  cand.sort((a, b) => scores[b]! - scores[a]! || a - b);
  const taken = new Uint8Array(grid.cellCount);
  const cells: number[] = [];
  for (const c of cand) {
    if (taken[c]) continue;
    cells.push(c);
    taken[c] = 1;
    let x = c;
    for (let k = 0; k < t.spacing; k++) {
      x = receiver[x]!;
      if (x < 0) break;
      taken[x] = 1;
    }
    x = c;
    for (let k = 0; k < t.spacing; k++) {
      x = rivers.upstream[x]!;
      if (x < 0) break;
      taken[x] = 1;
    }
  }
  cells.sort((a, b) => a - b);
  const points = new Float64Array(cells.length * 3);
  cells.forEach((c, i) => points.set(grid.centers.subarray(c * 3, c * 3 + 3), i * 3));
  return {
    cells: Int32Array.from(cells),
    points,
    score: Float32Array.from(cells.map((c) => scores[c]!)),
    riverWidth: Float32Array.from(cells.map((c) => rivers.width(c))),
  };
}

/** Per cell, the score of a crossing site at or next to it (0 elsewhere): the settlement pull. */
export function crossingNearness(ctx: StrategicContext, sites: CrossingList): Float32Array {
  const { grid } = ctx;
  const out = new Float32Array(grid.cellCount);
  for (let i = 0; i < sites.cells.length; i++) {
    const c = sites.cells[i]!;
    const s = sites.score[i]!;
    out[c] = Math.max(out[c]!, s);
    for (let k = 0; k < 8; k++) {
      const x = grid.neighbors8[c * 8 + k]!;
      if (x >= 0) out[x] = Math.max(out[x]!, s);
    }
  }
  return out;
}
