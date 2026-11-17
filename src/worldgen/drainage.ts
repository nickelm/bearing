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
 *  5. Closed basins (decision 210), given the climate: a depression whose
 *     lake would evaporate more at its spill level than flows in is closed.
 *     Its lake stands at the balance level, where evaporation meets inflow,
 *     as a salt lake, or dries to a playa; steps 1–3 run again with the
 *     basin's floor as a sink, so its rivers end there and nothing leaves it.
 *
 * Memory is lean typed arrays, about 21 bytes per cell plus the heap.
 */
import { MinHeap } from '../core/heap';
import { wrapCell } from '../core/faceAdjacency';
import { NEIGHBOR_OFFSETS } from '../core/cubeGrid';
import { DAY } from '../core/units';

export interface Drainage {
  /**
   * Downstream cell, or −1 for ocean cells. Land cells always have one, except
   * the sinks of closed basins (decision 210), which end their rivers like a mouth.
   */
  receiver: Int32Array;
  /** Mean discharge (m³/s) leaving each land cell; 0 in the ocean. */
  discharge: Float32Array;
  /** Water depth of lakes in closed depressions (m); 0 elsewhere. */
  lakeDepth: Float32Array;
  /** `BasinCell` per cell, with climate (decision 210); absent without. */
  basinCell?: Uint8Array;
  /** The salt lake's or playa's level on its cells (m), 0 elsewhere (decision 210). */
  basinLevel?: Float32Array;
  /** Closed basins, with climate (decision 210). */
  basins?: ClosedBasin[];
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

/** Per-cell closed-basin class (decision 210). */
export const BasinCell = {
  None: 0,
  /** Water of a closed basin's terminal lake: salt. */
  SaltLake: 1,
  /** Dry floor of a closed basin whose lake has evaporated: a playa. */
  Playa: 2,
} as const;

/** A closed (endorheic) basin's terminal lake or playa (decision 210). */
export interface ClosedBasin {
  /** Lowest cell of the basin's floor. */
  lowest: number;
  /** The balance level: where evaporation meets inflow (m). */
  level: number;
  /** The level at which the basin would spill (m). */
  spill: number;
  /** Inflow (m³/s) over evaporation at the spill level, 0..1: lower is saltier. */
  fill: number;
  /** True when the balance leaves no standing water. */
  playa: boolean;
  /** Cells of the lake or playa. */
  cells: number;
}

/** Climate at each cell, for the closed basins' water balance (decision 210). */
export interface DrainageClimate {
  /** Annual mean temperature at the cell (°C). */
  temperature: Float32Array;
  /** Annual precipitation (mm/yr). */
  precipitation: Float32Array;
}

export const BASIN_TUNING = {
  /** Open-water evaporation (mm/yr) = base + perDegree · T, clamped to [min, max]. */
  evaporationBase: 400,
  evaporationPerDegree: 60,
  evaporationRange: [150, 2600] as [number, number],
  /** A balance lake shallower than this (m) dries to a playa. */
  playaDepth: 3,
  /** Smallest depression (cells) considered: noise hollows stay open. */
  minCells: 3,
  /** A playa's crust reaches this share of the way from the basin's floor to its spill level. */
  playaShare: 0.3,
};

/** Open-water evaporation (mm/yr) at temperature t (°C). */
export function lakeEvaporation(t: number): number {
  const b = BASIN_TUNING;
  return Math.min(
    b.evaporationRange[1],
    Math.max(b.evaporationRange[0], b.evaporationBase + b.evaporationPerDegree * t),
  );
}

/**
 * @param n cells per face edge
 * @param height physical height above sea level (m); ≤ 0 is ocean
 * @param runoff runoff (mm/yr) per cell
 * @param radius planet radius (m)
 * @param climate if given, closed basins keep their water where evaporation
 *   beats inflow (decision 210); without it every depression drains to the sea
 */
export function computeDrainage(
  n: number,
  height: Float32Array,
  runoff: Float32Array,
  radius: number,
  climate?: DrainageClimate,
): Drainage {
  const count = 6 * n * n;
  if (height.length !== count || runoff.length !== count) {
    throw new RangeError(`computeDrainage: expected ${count} cells`);
  }
  const cellArea = (4 * Math.PI * radius * radius) / count;
  const nb = new Int32Array(8);

  // 1–3 with every depression open: filled surface, receivers, discharge.
  const open = route(n, height, runoff, cellArea, null);
  if (!climate) return open.drainage;

  // 4. Water balance per depression; closed basins become sinks, and routing runs again.
  const sink = new Float64Array(count).fill(NaN);
  const basinCell = new Uint8Array(count);
  const basins: ClosedBasin[] = [];
  const seen = new Uint8Array(count);
  const stack = new Int32Array(count);
  const members: number[] = [];
  for (let s = 0; s < count; s++) {
    if (seen[s] || height[s]! <= 0 || open.filled[s]! - height[s]! < MIN_LAKE_DEPTH) continue;
    // The depression: connected cells standing below the filled surface.
    members.length = 0;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    while (sp > 0) {
      const c = stack[--sp]!;
      members.push(c);
      neighbors8(n, c, nb);
      for (let k = 0; k < 8; k++) {
        const m = nb[k]!;
        if (m < 0 || seen[m] || height[m]! <= 0 || open.filled[m]! - height[m]! <= 0.01) continue;
        seen[m] = 1;
        stack[sp++] = m;
      }
    }
    if (members.length < BASIN_TUNING.minCells) continue;
    // Inflow is the discharge at the depression's outlet: the most of any member.
    let inflow = 0;
    let spill = -Infinity;
    for (const c of members) {
      inflow = Math.max(inflow, open.drainage.discharge[c]!);
      spill = Math.max(spill, open.filled[c]!);
    }
    members.sort((a, b) => height[a]! - height[b]! || a - b);
    // Net loss per m² of lake (m/s): evaporation minus rain on the lake.
    let level = NaN;
    let lakeCells = 0;
    let lossSum = 0;
    for (let k = 0; k < members.length; k++) {
      const c = members[k]!;
      const net =
        (lakeEvaporation(climate.temperature[c]!) - climate.precipitation[c]!) /
        1000 /
        CLIMATE_YEAR;
      lossSum += Math.max(0, net) * cellArea;
      if (Number.isNaN(level) && lossSum >= inflow) {
        level = height[c]!;
        lakeCells = k + 1;
      }
    }
    const lossAtSpill = lossSum;
    if (Number.isNaN(level) || lossAtSpill <= inflow) continue; // the lake fills and spills: open
    const lowest = members[0]!;
    const playa = level - height[lowest]! < BASIN_TUNING.playaDepth;
    // A playa is the floor a former, larger lake left flat: up to a share of the basin's depth.
    if (playa)
      level = height[lowest]! + Math.max(0.5, BASIN_TUNING.playaShare * (spill - height[lowest]!));
    basins.push({ lowest, level, spill, fill: inflow / lossAtSpill, playa, cells: lakeCells });
    let cells = 0;
    for (let k = 0; k < members.length; k++) {
      const c = members[k]!;
      if (height[c]! >= level && k > 0) break;
      sink[c] = level;
      basinCell[c] = playa ? BasinCell.Playa : BasinCell.SaltLake;
      cells++;
    }
    basins[basins.length - 1]!.cells = cells;
  }
  const basinLevel = new Float32Array(count);
  for (let c = 0; c < count; c++) if (basinCell[c]) basinLevel[c] = sink[c]!;
  if (basins.length === 0) return { ...open.drainage, basinCell, basinLevel, basins };
  const closed = route(n, height, runoff, cellArea, sink);
  // Lakes: open depressions as before; closed basins hold water only below their balance.
  const lakeDepth = closed.drainage.lakeDepth;
  for (let c = 0; c < count; c++) {
    if (basinCell[c] === BasinCell.SaltLake)
      lakeDepth[c] = Math.max(MIN_LAKE_DEPTH, sink[c]! - height[c]!);
    else if (basinCell[c] === BasinCell.Playa) lakeDepth[c] = 0;
  }
  return { ...closed.drainage, basinCell, basinLevel, basins };
}

/**
 * Priority-Flood+ε from the sea (and from closed basins' sinks at their
 * level), D8 receivers on the filled surface, and discharge accumulated
 * downstream. Water reaching a sink cell stays there: a sink passes nothing on.
 */
function route(
  n: number,
  height: Float32Array,
  runoff: Float32Array,
  cellArea: number,
  sink: Float64Array | null,
): { drainage: Drainage; filled: Float64Array } {
  const count = 6 * n * n;
  const nb = new Int32Array(8);
  const filled = new Float64Array(count);
  const closed = new Uint8Array(count);
  const heap = new MinHeap(1 << 16);
  const pit = new Int32Array(count);
  let pitHead = 0;
  let pitTail = 0;
  const isSink = (c: number) => sink !== null && !Number.isNaN(sink[c]!);

  // 1. Priority-Flood+ε, seeded with every ocean cell that touches land, and every sink.
  for (let c = 0; c < count; c++) {
    filled[c] = height[c]!;
    if (isSink(c)) {
      filled[c] = Math.max(height[c]!, sink![c]!);
      closed[c] = 1;
      heap.push(filled[c]!, c);
      continue;
    }
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

  // 2. D8 receivers on the filled surface. A closed basin's sink is a terminal,
  // like a river mouth at sea: receiver −1, so rivers end at its lake (decision 210).
  const receiver = new Int32Array(count).fill(-1);
  const donors = new Uint8Array(count);
  for (let c = 0; c < count; c++) {
    if (height[c]! <= 0 || isSink(c)) continue;
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
  return { drainage: { receiver, discharge, lakeDepth }, filled };
}
