/**
 * Settlement inputs from the world (decision 260): the strategic graph's settlements,
 * naming regions, urban extents, roads and railways, the drawn rivers and a height
 * function. Only world data: nothing here reads the cast, territory, fronts or the
 * infrastructure placed after casting.
 */
import { Vec3d } from '../../core/vec3d';
import type { RiverSegments } from '../riverIndex';
import { SETTLEMENT_PORT, URBAN_VERTICES } from '../strategic/graph';
import type { StrategicGraph } from '../strategic/graph';
import { SettlementFrame } from './frame';
import { simplify } from './geom';
import { styleFor, styleRegions } from './styles';
import { tierOf } from './tiers';
import type { SettlementInput } from './types';

/** How the generator sees the ground: height (m) and water at unit directions. */
export interface WorldGround {
  height(dir: Readonly<Vec3d>): number;
  /** True on the sea and lakes; defaults to height ≤ 0. */
  water?(dir: Readonly<Vec3d>): boolean;
}

/** The largest extent (m) a plan covers toward any bearing. */
export const MAX_EXTENT = 11_000;

/** The world facts the inputs need, built once per world (`settlementWorld`). */
export interface SettlementWorld {
  graph: StrategicGraph;
  radius: number;
  /** Style per settlement. */
  styles: Uint8Array;
  /** Biome per settlement (from the caller's biome map), for the climate gates. */
  biomes: Uint8Array;
  rivers: RiverSegments | null;
  ground: WorldGround;
  /** Road polylines in planet directions: the aligned routes where the world has them. */
  roads: { points: Float64Array; roadClass: number }[];
}

/**
 * Builds the per-world facts. `biomeOf(i)` gives settlement i's biome (the graph
 * holds none; the caller reads it from the biome map at the settlement's cell).
 */
export function settlementWorld(
  graph: StrategicGraph,
  radius: number,
  ground: WorldGround,
  biomeOf: (i: number) => number,
  rivers: RiverSegments | null = null,
  roads?: { points: Float64Array; roadClass: number }[],
): SettlementWorld {
  const s = graph.settlements;
  const n = s.cells.length;
  const biomes = new Uint8Array(n);
  for (let i = 0; i < n; i++) biomes[i] = biomeOf(i);
  const regions = styleRegions(s.node, s.population, s.points);
  const styles = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const node = graph.nodes[s.node[i]!];
    const flavor = node?.flavor ?? 4;
    styles[i] = styleFor(flavor, regions[i]!, biomes[i]!);
  }
  const roadLines =
    roads ??
    Array.from({ length: graph.roads.count }, (_, k) => ({
      points: graph.roads.points.slice(
        graph.roads.offsets[k]! * 3,
        graph.roads.offsets[k + 1]! * 3,
      ),
      roadClass: graph.roads.roadClass[k]!,
    }));
  return { graph, radius, styles, biomes, rivers, ground, roads: roadLines };
}

/** Clips planet polylines to the frame within `reach` m, as local polylines (pieces). */
function clipLocal(
  frame: SettlementFrame,
  pts: Float64Array | number[],
  reach: number,
  stride = 3,
): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  const cos = Math.cos(reach / frame.radius);
  for (let i = 0; i + stride - 1 < pts.length; i += stride) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    const z = pts[i + 2]!;
    const l = Math.hypot(x, y, z);
    const near = (x * frame.cx + y * frame.cy + z * frame.cz) / l > cos;
    if (near) {
      const [px, py] = frame.toPlane(x, y, z);
      cur.push(px, py);
    } else if (cur.length) {
      if (cur.length >= 4) out.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}

/** Densifies a polyline to points at most `step` m apart. */
function densify(p: number[], step: number): number[] {
  const out: number[] = [p[0]!, p[1]!];
  for (let i = 0; i + 3 < p.length; i += 2) {
    const L = Math.hypot(p[i + 2]! - p[i]!, p[i + 3]! - p[i + 1]!);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++)
      out.push(
        p[i]! + ((p[i + 2]! - p[i]!) * k) / n,
        p[i + 1]! + ((p[i + 3]! - p[i + 1]!) * k) / n,
      );
  }
  return out;
}

/** Coastlines round the settlement by marching squares on the water mask (80 m lattice). */
function coastLines(ground: SettlementInput['ground'], reach: number): number[][] {
  const step = 80;
  const n = Math.ceil(reach / step);
  const w = (i: number, j: number) => (ground.water(i * step, j * step) ? 1 : 0);
  const grid = new Map<number, number>();
  const at = (i: number, j: number) => {
    const k = (i + 1000) * 4000 + j + 1000;
    let v = grid.get(k);
    if (v === undefined) grid.set(k, (v = w(i, j)));
    return v;
  };
  const out: number[][] = [];
  for (let j = -n; j < n; j++) {
    for (let i = -n; i < n; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      const s = a + b + c + d;
      if (s === 0 || s === 4) continue;
      // Midpoints of edges whose ends differ, joined pairwise.
      const mids: number[] = [];
      if (a !== b) mids.push((i + 0.5) * step, j * step);
      if (b !== c) mids.push((i + 1) * step, (j + 0.5) * step);
      if (c !== d) mids.push((i + 0.5) * step, (j + 1) * step);
      if (d !== a) mids.push(i * step, (j + 0.5) * step);
      for (let k = 0; k + 3 < mids.length; k += 4) out.push(mids.slice(k, k + 4));
    }
  }
  return out;
}

/** The input for settlement `i`. */
export function settlementInput(
  w: SettlementWorld,
  i: number,
  anchors: SettlementInput['anchors'] = [],
): SettlementInput {
  const { graph, radius } = w;
  const s = graph.settlements;
  const center: [number, number, number] = [
    s.points[i * 3]!,
    s.points[i * 3 + 1]!,
    s.points[i * 3 + 2]!,
  ];
  const frame = new SettlementFrame(center, radius);
  const population = s.population[i]!;
  // The urban extent's radii (decision 103), else 10 m × √population.
  const outline: number[] = [];
  const u = graph.urban?.points;
  const r0 = Math.min(9000, Math.max(500, 10 * Math.sqrt(population)));
  for (let k = 0; k < URBAN_VERTICES; k++) {
    if (u && u.length >= (i + 1) * URBAN_VERTICES * 3) {
      const o = (i * URBAN_VERTICES + k) * 3;
      const dot = center[0] * u[o]! + center[1] * u[o + 1]! + center[2] * u[o + 2]!;
      outline.push(Math.min(Math.acos(Math.min(1, dot)) * radius, 1.5 * r0, MAX_EXTENT));
    } else outline.push(r0);
  }
  const reach = Math.max(...outline) * 1.3 + 600;
  const arterials: SettlementInput['arterials'] = [];
  for (const r of w.roads) {
    for (const piece of clipLocal(frame, r.points, reach)) {
      arterials.push({ points: simplify(densify(piece, 40), 2), roadClass: r.roadClass });
    }
  }
  const rails: SettlementInput['rails'] = [];
  const rl = graph.railways.lines;
  for (let k = 0; k < rl.count; k++) {
    const pts = rl.points.slice(rl.offsets[k]! * 3, rl.offsets[k + 1]! * 3);
    for (const piece of clipLocal(frame, pts, reach)) rails.push({ points: densify(piece, 60) });
  }
  const rivers: SettlementInput['rivers'] = [];
  const seg = w.rivers;
  if (seg) {
    const F = seg.fields ?? 12;
    const cos = Math.cos(reach / radius);
    for (let k = 0; k < seg.count; k++) {
      const o = k * F;
      const ax = seg.data[o]!;
      const ay = seg.data[o + 1]!;
      const az = seg.data[o + 2]!;
      if (ax * frame.cx + ay * frame.cy + az * frame.cz < cos) continue;
      const a = frame.toPlane(ax, ay, az);
      const b = frame.toPlane(seg.data[o + 3]!, seg.data[o + 4]!, seg.data[o + 5]!);
      rivers.push({
        points: [a[0], a[1], b[0], b[1]],
        halfWidth: Math.max(seg.data[o + 6]!, seg.data[o + 7]!),
      });
    }
  }
  const dir = new Vec3d();
  const tmp: [number, number, number] = [0, 0, 0];
  const toDir = (x: number, y: number) => {
    frame.toSphere(x, y, tmp);
    dir.x = tmp[0];
    dir.y = tmp[1];
    dir.z = tmp[2];
    return dir;
  };
  const ground: SettlementInput['ground'] = {
    height: (x, y) => w.ground.height(toDir(x, y)),
    water: (x, y) => {
      const d = toDir(x, y);
      return w.ground.water ? w.ground.water(d) : w.ground.height(d) <= 0;
    },
  };
  const node = graph.nodes[s.node[i]!];
  return {
    key: `s${i}`,
    name: s.names[i] ?? `Settlement ${i}`,
    center,
    population,
    tier: tierOf(population),
    style: w.styles[i] as SettlementInput['style'],
    flavor: node?.flavor ?? 4,
    outline,
    arterials,
    rails,
    rivers,
    coasts: coastLines(ground, reach).map((points) => ({ points })),
    port: (s.flags[i]! & SETTLEMENT_PORT) !== 0,
    anchors,
    ground,
  };
}
