/**
 * Water features (decision 95): oceans, seas and bays from the sea's openness,
 * straits where they meet through narrows, and lakes.
 *
 * - **Openness.** D, the distance from each sea cell to the nearest land.
 * - **Basins.** A watershed on −D: sea cells in order of falling D join the basin
 *   of their processed neighbors. Where two basins meet at a saddle of openness
 *   D_s, the one with the lower peak stays separate only if
 *   D_s ≤ SADDLE_RATIO · its peak, a constriction to at most 60% of its own
 *   openness, and its peak is at least BASIN_MIN_PEAK; otherwise it merges.
 *   The rule is scale-free: a bay behind a narrow mouth and an ocean behind a
 *   wide gap between continents separate the same way.
 * - **Small basins** under BAY_MIN_AREA merge, smallest first, into the
 *   neighbor across their highest saddle.
 * - **Classes.** Oceans have at least OCEAN_MIN_AREA and an openness of
 *   OCEAN_MIN_OPEN; seas at least SEA_MIN_AREA; the rest are bays.
 * - **Straits.** The saddle between two water features where the passage
 *   (2 · D_s + one cell) is under STRAIT_MAX_WIDTH, one per pair, if at least
 *   one side is a sea or an ocean (narrows between bays go unnamed), plus the
 *   graph's strait chokepoints; straits closer than STRAIT_MERGE keep the
 *   narrower.
 * - **Lakes.** Connected lake cells (lake depth > 0) of at least LAKE_MIN_AREA.
 */
import { Vec3d } from '../../core/vec3d';
import { FeatureKind, STRAIT_MAX_WIDTH, surfaceDistance } from '../strategic/graph';
import type { Point } from '../strategic/graph';
import type { FeatureBuilder } from './builder';
import type { GeographyInput } from './context';
import { nearestSource } from './context';
import { cellArea, cellPoint, components, regionShape } from './shape';

export const SADDLE_RATIO = 0.6;
export const BASIN_MIN_PEAK = 25e3;
export const BAY_MIN_AREA = 6_000e6;
export const SEA_MIN_AREA = 50_000e6;
export const OCEAN_MIN_AREA = 1_200_000e6;
export const OCEAN_MIN_OPEN = 250e3;
export const LAKE_MIN_AREA = 400e6;
const STRAIT_MERGE = 120e3;

class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]!]!;
      i = p[i]!;
    }
    return i;
  }
}

interface Saddle {
  a: number;
  b: number;
  cell: number;
  openness: number;
}

export function extractWater(input: GeographyInput, fb: FeatureBuilder, region: Int32Array): void {
  const { grid, height, lakeDepth, radius, cellSize } = input.ctx;
  const N = grid.cellCount;
  const landSrc = new Int32Array(N).fill(-1);
  for (let c = 0; c < N; c++) if (height[c]! > 0) landSrc[c] = 0;
  const D = nearestSource(grid, landSrc, radius).distance;

  // Watershed on −D.
  const sea: number[] = [];
  for (let c = 0; c < N; c++) if (height[c]! <= 0) sea.push(c);
  sea.sort((a, b) => D[b]! - D[a]! || a - b);
  const basinOf = new Int32Array(N).fill(-1);
  const peak: number[] = [];
  const uf = new UnionFind(sea.length);
  const saddles: Saddle[] = [];
  for (const c of sea) {
    const roots: number[] = [];
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      if (nb < 0 || basinOf[nb]! < 0) continue;
      const r = uf.find(basinOf[nb]!);
      if (!roots.includes(r)) roots.push(r);
    }
    if (roots.length === 0) {
      basinOf[c] = peak.length;
      peak.push(D[c]!);
      continue;
    }
    roots.sort((a, b) => peak[b]! - peak[a]! || a - b);
    const main = roots[0]!;
    basinOf[c] = main;
    for (const r of roots.slice(1)) {
      const separate = peak[r]! >= BASIN_MIN_PEAK && D[c]! <= SADDLE_RATIO * peak[r]!;
      if (separate) saddles.push({ a: r, b: main, cell: c, openness: D[c]! });
      else uf.parent[r] = main;
    }
  }
  // Basin cells and areas.
  const cellsOf = new Map<number, number[]>();
  for (const c of sea) {
    const r = uf.find(basinOf[c]!);
    let list = cellsOf.get(r);
    if (!list) cellsOf.set(r, (list = []));
    list.push(c);
  }
  const area = new Map<number, number>();
  for (const [r, cells] of cellsOf) area.set(r, cellArea(grid, cells, radius));

  // Merge small basins into the neighbor across their highest saddle, smallest first.
  const saddlesOf = new Map<number, Saddle[]>();
  for (const s of saddles) {
    for (const r of [s.a, s.b]) {
      let list = saddlesOf.get(r);
      if (!list) saddlesOf.set(r, (list = []));
      list.push(s);
    }
  }
  const small = [...area.keys()].filter((r) => area.get(r)! < BAY_MIN_AREA);
  small.sort((a, b) => area.get(a)! - area.get(b)! || a - b);
  for (const r0 of small) {
    const r = uf.find(r0);
    if (r !== r0 || area.get(r)! >= BAY_MIN_AREA) continue;
    let best: Saddle | null = null;
    let other = -1;
    for (const s of saddlesOf.get(r) ?? []) {
      const a = uf.find(s.a);
      const b = uf.find(s.b);
      if (a === b) continue;
      if (!best || s.openness > best.openness) {
        best = s;
        other = a === r ? b : a;
      }
    }
    if (!best) continue; // isolated: kept, classified below by its own area
    uf.parent[r] = other;
    cellsOf.get(other)!.push(...cellsOf.get(r)!);
    cellsOf.delete(r);
    area.set(other, area.get(other)! + area.get(r)!);
    area.delete(r);
    saddlesOf.get(other)!.push(...(saddlesOf.get(r) ?? []));
    saddlesOf.delete(r);
  }

  // Features, in order of each basin's lowest cell.
  const roots = [...cellsOf.keys()].map((r) => ({
    r,
    cells: cellsOf.get(r)!.sort((a, b) => a - b),
  }));
  roots.sort((a, b) => a.cells[0]! - b.cells[0]!);
  const featureOf = new Map<number, number>();
  for (const { r, cells } of roots) {
    const a = cellArea(grid, cells, radius);
    if (a < BAY_MIN_AREA) continue;
    let open = 0;
    for (const c of cells) open = Math.max(open, D[c]!);
    const kind =
      a >= OCEAN_MIN_AREA && open >= OCEAN_MIN_OPEN
        ? FeatureKind.Ocean
        : a >= SEA_MIN_AREA
          ? FeatureKind.Sea
          : FeatureKind.Bay;
    const member = (c: number) => basinOf[c]! >= 0 && uf.find(basinOf[c]!) === r;
    const shape = regionShape(grid, cells, member, radius);
    featureOf.set(
      r,
      fb.add({
        kind,
        anchor: shape.anchor,
        extent: shape.extent,
        size: a,
        height: 0,
        measure: open,
        magnitude: a,
        region: region[shape.anchorCell]!,
        polyline: shape.axis,
        cells,
      }),
    );
  }

  // Straits: the widest saddle between each pair of water features, if narrow.
  const straits: { point: Point; width: number; cell: number }[] = [];
  const pairs = new Map<string, Saddle>();
  for (const s of saddles) {
    const a = featureOf.get(uf.find(s.a));
    const b = featureOf.get(uf.find(s.b));
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const prev = pairs.get(key);
    if (!prev || s.openness > prev.openness) pairs.set(key, s);
  }
  const open = (id: number) => fb.records[id]!.kind !== FeatureKind.Bay;
  for (const [key, s] of [...pairs.entries()].sort((x, y) => x[1].cell - y[1].cell)) {
    const [a, b] = key.split(':').map(Number) as [number, number];
    const width = 2 * s.openness + cellSize;
    if (width < STRAIT_MAX_WIDTH && (open(a) || open(b)))
      straits.push({ point: cellPoint(grid, s.cell), width, cell: s.cell });
  }
  for (const cp of input.chokepoints) {
    if (cp.kind !== 'strait') continue;
    const cell = grid.cellOfDirection(new Vec3d(...cp.point));
    straits.push({ point: cp.point, width: cp.width, cell });
  }
  // Narrowest first; drop any strait within STRAIT_MERGE of a kept one.
  straits.sort((x, y) => x.width - y.width || x.cell - y.cell);
  const kept: typeof straits = [];
  for (const s of straits) {
    if (!kept.some((k) => surfaceDistance(k.point, s.point, radius) < STRAIT_MERGE)) kept.push(s);
  }
  kept.sort((x, y) => x.cell - y.cell);
  for (const s of kept) {
    fb.add({
      kind: FeatureKind.Strait,
      anchor: s.point,
      extent: s.width / 2,
      size: 0,
      height: 0,
      measure: s.width,
      magnitude: 1 - s.width / STRAIT_MAX_WIDTH,
      region: region[s.cell]!,
    });
  }

  // Lakes.
  const lakeMask = new Uint8Array(N);
  for (let c = 0; c < N; c++) if (height[c]! > 0 && lakeDepth[c]! > 0) lakeMask[c] = 1;
  for (const cells of components(grid, lakeMask)) {
    const a = cellArea(grid, cells, radius);
    if (a < LAKE_MIN_AREA) continue;
    let depth = 0;
    let surface = 0;
    for (const c of cells) {
      depth = Math.max(depth, lakeDepth[c]!);
      surface = Math.max(surface, height[c]! + lakeDepth[c]!);
    }
    const set = new Set(cells);
    const shape = regionShape(grid, cells, (c) => set.has(c), radius);
    fb.add({
      kind: FeatureKind.Lake,
      anchor: shape.anchor,
      extent: shape.extent,
      size: a,
      height: surface,
      measure: depth,
      magnitude: a,
      region: region[shape.anchorCell]!,
      polyline: shape.axis,
      cells,
    });
  }
}
