/**
 * Relief features (decision 95): mountain ranges with ridge lines, peaks by
 * prominence, hills, plains and plateaus. Thresholds are in reference meters
 * (physical height ÷ reliefScale, decision 14) and reference slope, the units of
 * the terrain classes in landmasses.ts.
 *
 * - **Cells.** Plateau: reference height ≥ 900 m and slope < 0.04 at the cell and
 *   its 8 neighbors (a ridge crest is not a plateau). Mountain: not
 *   plateau, and height ≥ 1,500 m, or slope ≥ 0.1 above 600 m, or boundary uplift
 *   ≥ 800 m above 700 m. Hills: neither, slope ≥ 0.022 above 200 m. Plain: slope
 *   < 0.02 below 500 m.
 * - **Ranges.** Components of mountain cells, with gaps of one cell bridged
 *   (components of the mask dilated once, members the undilated cells), of at
 *   least RANGE_MIN_AREA. The ridge line runs between the two ends of the range's
 *   longest geodesic, along the path that favors high cells (cost per meter
 *   1 + 3 · (1 − h / h_max)²), simplified and smoothed.
 * - **Peaks.** Topographic prominence on the coarse grid: land cells in order of
 *   falling height merge their 8-neighbor components; when two meet, the lower
 *   summit's prominence is its height above the joining cell, and an island's
 *   highest summit has its full height. Peaks need PEAK_MIN_PROMINENCE and
 *   PEAK_MIN_HEIGHT; a peak's parent is the range it stands in.
 * - **Hills, plains, plateaus.** Components above HILLS_MIN_AREA,
 *   PLAIN_MIN_AREA and PLATEAU_MIN_AREA; hills bridge one-cell gaps like ranges.
 */
import { MinHeap } from '../../core/heap';
import { FeatureKind } from '../strategic/graph';
import type { Point } from '../strategic/graph';
import type { FeatureBuilder } from './builder';
import type { GeographyInput } from './context';
import { cellArea, cellPoint, components, regionShape, simplify, smooth } from './shape';

export const RANGE_MIN_AREA = 3_000e6;
export const HILLS_MIN_AREA = 3_000e6;
export const PLAIN_MIN_AREA = 40_000e6;
export const PLATEAU_MIN_AREA = 10_000e6;
/** Reference meters. */
export const PEAK_MIN_PROMINENCE = 500;
export const PEAK_MIN_HEIGHT = 1_000;

const enum Relief {
  None = 0,
  Plain = 1,
  Hills = 2,
  Mountain = 3,
  Plateau = 4,
}

export function reliefClasses(input: GeographyInput): Uint8Array {
  const { grid, height, slope, reliefScale, uplift } = input.ctx;
  const out = new Uint8Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    if (height[c]! <= 0) continue;
    const h = height[c]! / reliefScale;
    const s = slope[c]!;
    const u = uplift?.[c] ?? 0;
    // A plateau is flat around the cell too, so a ridge crest is not one.
    let around = s;
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      if (nb >= 0) around = Math.max(around, slope[nb]!);
    }
    if (h >= 900 && around < 0.04) out[c] = Relief.Plateau;
    else if (h >= 1500 || (s >= 0.1 && h >= 600) || (u >= 800 && h >= 700))
      out[c] = Relief.Mountain;
    else if (s >= 0.022 && h >= 200) out[c] = Relief.Hills;
    else if (s < 0.02 && h < 500) out[c] = Relief.Plain;
  }
  return out;
}

/** Dijkstra within a cell set from `start`; cost per edge = angle × weight(cell entered). */
function localDijkstra(
  input: GeographyInput,
  cells: readonly number[],
  index: Map<number, number>,
  start: number,
  weight: (c: number) => number,
): { dist: Float64Array; prev: Int32Array } {
  const { grid } = input.ctx;
  const dist = new Float64Array(cells.length).fill(Infinity);
  const prev = new Int32Array(cells.length).fill(-1);
  const heap = new MinHeap(256);
  const s = index.get(start)!;
  dist[s] = 0;
  heap.push(0, s);
  while (heap.size > 0) {
    const d = heap.peekKey();
    const i = heap.pop();
    if (d > dist[i]!) continue;
    const c = cells[i]!;
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      const j = nb >= 0 ? index.get(nb) : undefined;
      if (j === undefined) continue;
      const nd = d + grid.angleBetween(c, nb) * weight(nb);
      if (nd < dist[j]!) {
        dist[j] = nd;
        prev[j] = i;
        heap.push(nd, j);
      }
    }
  }
  return { dist, prev };
}

function farthest(dist: Float64Array): number {
  let best = 0;
  for (let i = 0; i < dist.length; i++) {
    if (Number.isFinite(dist[i]!) && dist[i]! > dist[best]!) best = i;
  }
  return best;
}

/** The ridge line of a range: its longest geodesic's ends, joined along high ground. */
export function ridgeLine(input: GeographyInput, cells: readonly number[]): Point[] {
  const { grid, height } = input.ctx;
  const index = new Map<number, number>();
  cells.forEach((c, i) => index.set(c, i));
  let top = cells[0]!;
  for (const c of cells) if (height[c]! > height[top]!) top = c;
  const hMax = Math.max(1, height[top]!);
  const flat = () => 1;
  const e1 = cells[farthest(localDijkstra(input, cells, index, top, flat).dist)]!;
  const e2 = cells[farthest(localDijkstra(input, cells, index, e1, flat).dist)]!;
  const { prev } = localDijkstra(input, cells, index, e1, (c) => {
    const t = 1 - Math.max(0, height[c]!) / hMax;
    return 1 + 3 * t * t;
  });
  const path: Point[] = [];
  for (let i = index.get(e2)!; i >= 0; i = prev[i]!) path.push(cellPoint(grid, cells[i]!));
  const tol = (1.5 * Math.PI) / 2 / grid.n;
  return smooth(simplify(path.reverse(), tol), 2);
}

/**
 * Peaks by prominence over land: [cell, prominence (m, physical)] for every summit,
 * highest first.
 */
export function prominentPeaks(input: GeographyInput): { cell: number; prominence: number }[] {
  const { grid, height } = input.ctx;
  const land: number[] = [];
  for (let c = 0; c < grid.cellCount; c++) if (height[c]! > 0) land.push(c);
  land.sort((a, b) => height[b]! - height[a]! || a - b);
  const comp = new Int32Array(grid.cellCount).fill(-1);
  const parent: number[] = [];
  const summit: number[] = [];
  const find = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const out: { cell: number; prominence: number }[] = [];
  for (const c of land) {
    const roots: number[] = [];
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      if (nb < 0 || comp[nb]! < 0) continue;
      const r = find(comp[nb]!);
      if (!roots.includes(r)) roots.push(r);
    }
    if (roots.length === 0) {
      comp[c] = parent.length;
      parent.push(parent.length);
      summit.push(c);
      continue;
    }
    roots.sort((a, b) => height[summit[b]!]! - height[summit[a]!]! || summit[a]! - summit[b]!);
    const main = roots[0]!;
    comp[c] = main;
    for (const r of roots.slice(1)) {
      out.push({ cell: summit[r]!, prominence: height[summit[r]!]! - height[c]! });
      parent[r] = main;
    }
  }
  // The highest summit of each island rises from the sea.
  for (let i = 0; i < parent.length; i++) {
    if (parent[i] === i) out.push({ cell: summit[i]!, prominence: height[summit[i]!]! });
  }
  out.sort((a, b) => height[b.cell]! - height[a.cell]! || a.cell - b.cell);
  return out;
}

export function extractRelief(input: GeographyInput, fb: FeatureBuilder, region: Int32Array): void {
  const { grid, height, radius, reliefScale } = input.ctx;
  const N = grid.cellCount;
  const cls = reliefClasses(input);

  const add = (kind: FeatureKind, cells: number[], polyline?: Point[]) => {
    const a = cellArea(grid, cells, radius);
    const set = new Set(cells);
    const shape = regionShape(grid, cells, (c) => set.has(c), radius);
    let top = 0;
    let sum = 0;
    for (const c of cells) {
      top = Math.max(top, height[c]!);
      sum += height[c]!;
    }
    return fb.add({
      kind,
      anchor: shape.anchor,
      extent: shape.extent,
      size: a,
      height: top,
      measure: sum / cells.length,
      magnitude: a,
      region: region[shape.anchorCell]!,
      polyline: polyline ?? shape.axis,
      cells,
    });
  };

  // Components of a class with one-cell gaps bridged: components of the class
  // dilated once over land, keeping only the class's own cells.
  const bridged = (k: Relief, minArea: number) => {
    const member = new Uint8Array(N);
    const dilated = new Uint8Array(N);
    for (let c = 0; c < N; c++) {
      if (cls[c] !== k) continue;
      member[c] = 1;
      dilated[c] = 1;
      for (let j = 0; j < 8; j++) {
        const nb = grid.neighbors8[c * 8 + j]!;
        if (nb >= 0 && height[nb]! > 0) dilated[nb] = 1;
      }
    }
    return components(grid, dilated)
      .map((group) => group.filter((c) => member[c]))
      .filter((cells) => cells.length > 0 && cellArea(grid, cells, radius) >= minArea);
  };
  for (const cells of bridged(Relief.Mountain, RANGE_MIN_AREA)) {
    add(FeatureKind.Range, cells, ridgeLine(input, cells));
  }

  // Peaks, inside or outside ranges.
  const rangeLayer = fb.layers.relief;
  for (const p of prominentPeaks(input)) {
    const prom = p.prominence / reliefScale;
    if (prom < PEAK_MIN_PROMINENCE || height[p.cell]! / reliefScale < PEAK_MIN_HEIGHT) continue;
    const r = rangeLayer[p.cell]!;
    fb.add({
      kind: FeatureKind.Peak,
      anchor: cellPoint(grid, p.cell),
      extent: 0,
      size: 0,
      height: height[p.cell]!,
      measure: p.prominence,
      magnitude: prom,
      parent: r >= 0 && fb.records[r]!.kind === FeatureKind.Range ? r : -1,
      region: region[p.cell]!,
    });
  }

  const simple = (k: Relief, kind: FeatureKind, minArea: number) => {
    const mask = new Uint8Array(N);
    for (let c = 0; c < N; c++) if (cls[c] === k) mask[c] = 1;
    for (const cells of components(grid, mask)) {
      if (cellArea(grid, cells, radius) >= minArea) add(kind, cells);
    }
  };
  for (const cells of bridged(Relief.Hills, HILLS_MIN_AREA)) add(FeatureKind.Hills, cells);
  simple(Relief.Plain, FeatureKind.Plain, PLAIN_MIN_AREA);
  simple(Relief.Plateau, FeatureKind.Plateau, PLATEAU_MIN_AREA);
}
