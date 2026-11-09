/**
 * Stage: flow directions, drainage accumulation and lakes on the global grid,
 * on the CPU (decision 23). It runs on the eroded height read back from the
 * GPU and is exact and deterministic, because rivers, the barrier map and
 * the front generator depend on it.
 *
 *  1. Priority-Flood+ε (Barnes et al. 2014) from the coast inland. It fills
 *     closed depressions to their spill level and gives every filled flat a
 *     tiny gradient toward its outlet, so every land cell has a strictly lower
 *     neighbor.
 *  2. D8 receivers: the steepest descent on the filled surface over the 8
 *     seam-aware neighbors. Coastal cells drain into the sea (receiver = the
 *     ocean cell). Ocean cells have receiver −1.
 *  3. Discharge: runoff (mm/yr) × cell area, accumulated downstream in
 *     topological order (Kahn), in m³/s.
 *  4. Lakes: where the filled surface stands above the terrain.
 *
 * Memory is lean typed arrays, about 21 bytes per cell plus the heap.
 */
import { MinHeap } from '../core/heap';
import { wrapCell } from '../core/faceAdjacency';
import { NEIGHBOR_OFFSETS } from '../core/cubeGrid';
import { DAY } from '../core/units';

export interface Drainage {
  /** Downstream cell, or −1 for ocean cells. Land cells always have one. */
  receiver: Int32Array;
  /** Mean discharge (m³/s) leaving each land cell; 0 in the ocean. */
  discharge: Float32Array;
  /** Water depth of lakes in closed depressions (m); 0 elsewhere. */
  lakeDepth: Float32Array;
}

/** Climate maps give rates per 365-day year (mm/yr). */
const CLIMATE_YEAR = 365 * DAY;
/** Height gradient given to filled flats (m per cell step). Small next to real slopes. */
const FLAT_EPSILON = 1e-5;
/**
 * Filled-minus-terrain depth below which a cell does not count as lake (m,
 * physical; about 20 m in reference terms). Shallower hollows are marsh or noise.
 */
const MIN_LAKE_DEPTH = 3;

/** Writes the 8 neighbors of `cell` (NEIGHBOR_OFFSETS order, −1 past a cube corner) into `out`. */
export function neighbors8(n: number, cell: number, out: Int32Array): void {
  const nn = n * n;
  const face = Math.floor(cell / nn);
  const r = cell - face * nn;
  const j = Math.floor(r / n);
  const i = r - j * n;
  for (let k = 0; k < 8; k++) {
    const [di, dj] = NEIGHBOR_OFFSETS[k]!;
    const ii = i + di;
    const jj = j + dj;
    out[k] =
      ii >= 0 && ii < n && jj >= 0 && jj < n ? (face * n + jj) * n + ii : wrapCell(n, face, ii, jj);
  }
}

/**
 * @param n cells per face edge
 * @param height physical height above sea level (m); ≤ 0 is ocean
 * @param runoff runoff (mm/yr) per cell
 * @param radius planet radius (m)
 */
export function computeDrainage(
  n: number,
  height: Float32Array,
  runoff: Float32Array,
  radius: number,
): Drainage {
  const count = 6 * n * n;
  if (height.length !== count || runoff.length !== count) {
    throw new RangeError(`computeDrainage: expected ${count} cells`);
  }
  const nb = new Int32Array(8);
  const filled = new Float64Array(count);
  const closed = new Uint8Array(count);
  const heap = new MinHeap(1 << 16);
  const pit = new Int32Array(count);
  let pitHead = 0;
  let pitTail = 0;

  // 1. Priority-Flood+ε, seeded with every ocean cell that touches land.
  for (let c = 0; c < count; c++) {
    filled[c] = height[c]!;
    if (height[c]! > 0) continue;
    closed[c] = 1;
    neighbors8(n, c, nb);
    for (let k = 0; k < 8; k++) {
      if (nb[k]! >= 0 && height[nb[k]!]! > 0) {
        heap.push(filled[c]!, c);
        break;
      }
    }
  }
  while (heap.size > 0 || pitHead < pitTail) {
    const c = pitHead < pitTail ? pit[pitHead++]! : heap.pop();
    const fc = filled[c]!;
    neighbors8(n, c, nb);
    for (let k = 0; k < 8; k++) {
      const m = nb[k]!;
      if (m < 0 || closed[m]) continue;
      closed[m] = 1;
      if (filled[m]! <= fc) {
        filled[m] = fc + FLAT_EPSILON;
        pit[pitTail++] = m;
      } else {
        heap.push(filled[m]!, m);
      }
    }
  }

  // 2. D8 receivers on the filled surface.
  const receiver = new Int32Array(count).fill(-1);
  const donors = new Uint8Array(count);
  for (let c = 0; c < count; c++) {
    if (height[c]! <= 0) continue;
    neighbors8(n, c, nb);
    let best = -1;
    let bestSlope = 0;
    for (let k = 0; k < 8; k++) {
      const m = nb[k]!;
      if (m < 0) continue;
      const s = (filled[c]! - filled[m]!) / (k < 4 ? 1 : Math.SQRT2);
      if (s > bestSlope) {
        bestSlope = s;
        best = m;
      }
    }
    if (best < 0) throw new Error(`Drainage: land cell ${c} has no lower neighbor`);
    receiver[c] = best;
    if (height[best]! > 0) donors[best]!++;
  }

  // 3. Discharge, accumulated from sources downstream (Kahn's topological order).
  const cellArea = (4 * Math.PI * radius * radius) / count;
  const q = new Float64Array(count);
  const stack = new Int32Array(count);
  let top = 0;
  for (let c = 0; c < count; c++) {
    if (height[c]! <= 0) continue;
    q[c] = (Math.max(0, runoff[c]!) / 1000) * (cellArea / CLIMATE_YEAR);
    if (donors[c] === 0) stack[top++] = c;
  }
  while (top > 0) {
    const c = stack[--top]!;
    const r = receiver[c]!;
    if (r < 0 || height[r]! <= 0) continue;
    q[r] += q[c]!;
    if (--donors[r]! === 0) stack[top++] = r;
  }
  const discharge = new Float32Array(count);
  for (let c = 0; c < count; c++) discharge[c] = q[c]!;

  // 4. Lakes.
  const lakeDepth = new Float32Array(count);
  for (let c = 0; c < count; c++) {
    if (height[c]! <= 0) continue;
    const d = filled[c]! - height[c]!;
    if (d >= MIN_LAKE_DEPTH) lakeDepth[c] = d;
  }
  return { receiver, discharge, lakeDepth };
}
