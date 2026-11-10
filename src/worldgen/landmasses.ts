/**
 * Landmass labeling: connected land components on the tectonic grid.
 *
 * Minimal for now (decision 46): area and a most-inland cell per landmass,
 * enough to anchor the calendar, previews and tests. Milestone 4 extends it
 * with the statistics the strategic graph needs.
 */
import type { CubeGrid } from '../core/cubeGrid';

export interface Landmass {
  /** Label in `LandmassLabels.label`. */
  id: number;
  /** Area in m². */
  area: number;
  cellCount: number;
  /** The cell farthest from the coast (in 4-neighbor steps); ties go to the lowest index. */
  interiorCell: number;
}

export interface LandmassLabels {
  /** Landmass id per cell, −1 at sea. */
  label: Int32Array;
  /** Sorted by area, largest first; ids are positions in this array. */
  landmasses: Landmass[];
}

/** Labels the connected components of `height > 0` over 4-neighbors. */
export function labelLandmasses(
  grid: CubeGrid,
  height: Float32Array,
  radius: number,
): LandmassLabels {
  const n = grid.cellCount;
  const raw = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const found: Landmass[] = [];
  for (let start = 0; start < n; start++) {
    if (height[start] <= 0 || raw[start] >= 0) continue;
    const id = found.length;
    let sp = 0;
    let area = 0;
    let count = 0;
    raw[start] = id;
    stack[sp++] = start;
    while (sp > 0) {
      const c = stack[--sp]!;
      area += grid.areas[c];
      count++;
      for (let k = 0; k < 4; k++) {
        const nb = grid.neighbors4[c * 4 + k]!;
        if (height[nb] > 0 && raw[nb] < 0) {
          raw[nb] = id;
          stack[sp++] = nb;
        }
      }
    }
    found.push({ id, area: area * radius * radius, cellCount: count, interiorCell: start });
  }

  // Distance from the coast by multi-source BFS from land cells next to the sea.
  const depth = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let c = 0; c < n; c++) {
    if (raw[c] < 0) continue;
    for (let k = 0; k < 4; k++) {
      if (raw[grid.neighbors4[c * 4 + k]!]! < 0) {
        depth[c] = 0;
        queue[tail++] = c;
        break;
      }
    }
  }
  while (head < tail) {
    const c = queue[head++]!;
    for (let k = 0; k < 4; k++) {
      const nb = grid.neighbors4[c * 4 + k]!;
      if (raw[nb] >= 0 && depth[nb] < 0) {
        depth[nb] = depth[c] + 1;
        queue[tail++] = nb;
      }
    }
  }
  const best = new Int32Array(found.length).fill(-1);
  for (let c = 0; c < n; c++) {
    const id = raw[c];
    if (id < 0) continue;
    // A landmass with no coast covers the whole planet; any cell will do.
    if (best[id] < 0 || depth[c] > depth[best[id]!]!) best[id] = c;
  }
  for (const m of found) m.interiorCell = best[m.id]!;

  // Sort largest first (ties by first cell, which is deterministic) and relabel.
  const sorted = [...found].sort((a, b) => b.area - a.area || a.id - b.id);
  const remap = new Int32Array(found.length);
  sorted.forEach((m, i) => {
    remap[m.id] = i;
    m.id = i;
  });
  const label = new Int32Array(n);
  for (let c = 0; c < n; c++) label[c] = raw[c] < 0 ? -1 : remap[raw[c]]!;
  return { label, landmasses: sorted };
}
