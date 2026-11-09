/** Shared grid-field helpers for generation stages. */
import type { CubeGrid } from '../core/cubeGrid';
import { MinHeap } from '../core/heap';

const angleCache = new WeakMap<CubeGrid, Float32Array>();

/** Angle (radians) to each of the 8 neighbors per cell; 0 where the neighbor is missing. Cached per grid. */
export function neighborAngles8(grid: CubeGrid): Float32Array {
  let a = angleCache.get(grid);
  if (!a) {
    a = new Float32Array(grid.cellCount * 8);
    for (let c = 0; c < grid.cellCount; c++) {
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[c * 8 + k];
        a[c * 8 + k] = nb >= 0 ? grid.angleBetween(c, nb) : 0;
      }
    }
    angleCache.set(grid, a);
  }
  return a;
}

export interface DistanceField {
  /** Great-circle angle to the nearest source; Infinity if unreached. */
  angle: Float64Array;
  /** Nearest source cell; −1 if unreached. */
  nearest: Int32Array;
}

/**
 * Multi-source geodesic distance over the 8-neighbor graph (Dijkstra).
 * `passable`, if given, limits which cells the front may enter (sources are always included).
 * Search stops beyond `maxAngle`.
 */
export function distanceFromSources(
  grid: CubeGrid,
  sources: Uint8Array,
  maxAngle = Infinity,
  passable?: Uint8Array,
): DistanceField {
  const n = grid.cellCount;
  const angle = new Float64Array(n).fill(Infinity);
  const nearest = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(1024);
  const edges = neighborAngles8(grid);
  for (let c = 0; c < n; c++) {
    if (sources[c]) {
      angle[c] = 0;
      nearest[c] = c;
      heap.push(0, c);
    }
  }
  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    const d = angle[c];
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k];
      if (nb < 0 || done[nb]) continue;
      if (passable && !passable[nb]) continue;
      const nd = d + edges[c * 8 + k];
      if (nd < angle[nb] && nd <= maxAngle) {
        angle[nb] = nd;
        nearest[nb] = nearest[c];
        heap.push(nd, nb);
      }
    }
  }
  return { angle, nearest };
}

/** Area-weighted q-quantile (q in [0, 1]) of `values`. */
export function weightedQuantile(
  values: ArrayLike<number>,
  weights: ArrayLike<number>,
  q: number,
): number {
  const n = values.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => values[a] - values[b] || a - b);
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i];
  const target = q * total;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    acc += weights[i];
    if (acc >= target) return values[i];
  }
  return values[order[n - 1]];
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
