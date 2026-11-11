/**
 * What feature extraction reads (decision 95): the strategic builder's context and
 * the graph stages it follows, plus fields shared by several extraction stages.
 */
import type { CubeGrid } from '../../core/cubeGrid';
import { MinHeap } from '../../core/heap';
import type { Chokepoint, LandNode } from '../strategic/graph';
import type { StrategicContext } from '../strategic/input';

export interface GeographyInput {
  ctx: StrategicContext;
  nodes: LandNode[];
  /** Node id per landmass label, −1 for islands in no node. */
  nodeOfLandmass: Int32Array;
  /** Landmass labels per node. */
  members: number[][];
  chokepoints: Chokepoint[];
  /** Per-stage timings are appended here when given. */
  timings?: { stage: string; ms: number }[];
}

/**
 * Multi-source Dijkstra over 8-neighbors from every cell with `source[c] ≥ 0`:
 * surface distance (m) to the nearest source and that source's value.
 */
export function nearestSource(
  grid: CubeGrid,
  source: Int32Array,
  radius: number,
): { distance: Float64Array; value: Int32Array } {
  // Float64: a float32 store would round below the heap key and skip the cell.
  const distance = new Float64Array(grid.cellCount).fill(Infinity);
  const value = new Int32Array(grid.cellCount).fill(-1);
  const heap = new MinHeap(4096);
  for (let c = 0; c < grid.cellCount; c++) {
    if (source[c]! >= 0) {
      distance[c] = 0;
      value[c] = source[c]!;
      heap.push(0, c);
    }
  }
  const p = grid.centers;
  while (heap.size > 0) {
    const d = heap.peekKey();
    const c = heap.pop();
    if (d > distance[c]!) continue;
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      if (nb < 0) continue;
      // Chord length: equal to the arc to 1e-5 between neighbors, and cheaper.
      const dx = p[c * 3]! - p[nb * 3]!;
      const dy = p[c * 3 + 1]! - p[nb * 3 + 1]!;
      const dz = p[c * 3 + 2]! - p[nb * 3 + 2]!;
      const nd = d + Math.sqrt(dx * dx + dy * dy + dz * dz) * radius;
      if (nd < distance[nb]!) {
        distance[nb] = nd;
        value[nb] = value[c]!;
        heap.push(nd, nb);
      }
    }
  }
  return { distance, value };
}

/** Naming region per cell: the land node whose land is nearest (decision 96). */
export function regionField(input: GeographyInput): Int32Array {
  const { grid, labels, radius } = input.ctx;
  const src = new Int32Array(grid.cellCount).fill(-1);
  for (let c = 0; c < grid.cellCount; c++) {
    const l = labels.label[c]!;
    if (l >= 0) src[c] = input.nodeOfLandmass[l]!;
  }
  return nearestSource(grid, src, radius).value;
}
