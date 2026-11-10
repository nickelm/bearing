/**
 * Sea lanes and chokepoints over a coarse ocean grid.
 *
 * - **Ocean grid.** A cube-sphere grid with cells of about OCEAN_CELL (33 km
 *   on the default planet). Each cell aggregates the coarse cells inside it:
 *   water fraction, shallows (reference depth under 200 m) and sea ice. A cell
 *   is navigable with at least MIN_WATER water. The cost per meter is
 *   1 + 0.6 · shallows + 4 · ice + 1.5 · land.
 * - **Sea lanes.** For each pair of nodes, the least-cost route from a port
 *   site of one to a port site of the other (one multi-source Dijkstra per
 *   node). Lanes between two major nodes (landmasses of at least MAJOR_AREA)
 *   are always kept, so a strait between two continents stays a chokepoint
 *   on the lane through it instead of splitting the lane at a nearby port. A
 *   lane that involves a minor node (an archipelago or a small landmass) is
 *   dropped when a third node lies on the way: going through it costs at most
 *   DOMINATION_SLACK more.
 * - **Width.** At each route point, marching left and right across the route
 *   on the coarse grid until land; the width is the sum. Points within
 *   END_MARGIN of either port are skipped (ports are on the coast).
 * - **Chokepoints.** The narrowest point of each stretch narrower than
 *   STRAIT_MAX_WIDTH (straits closer than STRAIT_MERGE merge across lanes),
 *   and up to three islands per lane with an airbase site within ISLAND_REACH
 *   of the route and away from its ends.
 * - **Node distance.** Sea distance between the ocean cells touching each
 *   node's land, coast to coast.
 */
import { CubeGrid } from '../../core/cubeGrid';
import { MinHeap } from '../../core/heap';
import { Vec3d } from '../../core/vec3d';
import { Biome } from '../biomes';
import { ISLAND_REACH, STRAIT_MAX_WIDTH, polylinePoint, surfaceDistance } from './graph';
import type { Chokepoint, LandNode, Point, SeaLane } from './graph';
import type { StrategicContext } from './input';
import type { NodeBuild } from './nodes';

const OCEAN_CELL = 33e3;
const MIN_WATER = 0.25;
const SHALLOW_REF_DEPTH = 200;
const DOMINATION_SLACK = 1.1;
/** Landmasses at least this large are major nodes (m²). */
const MAJOR_AREA = 50_000e6;
const END_MARGIN = 150e3;
const STRAIT_MERGE = 150e3;
const ISLAND_END_CLEARANCE = 250e3;
/** Islands larger than this are not chokepoint islands (m²). */
const ISLAND_MAX_AREA = 20_000e6;
const ISLANDS_PER_LANE = 3;

export class OceanGrid {
  readonly grid: CubeGrid;
  /** Ocean cell of each coarse cell. */
  readonly oceanOf: Int32Array;
  readonly water: Float32Array;
  readonly shallow: Float32Array;
  readonly ice: Float32Array;
  /** Cost per meter of entering a cell; Infinity where not navigable. */
  readonly cost: Float32Array;
  /** Node ids whose land lies in each cell. */
  readonly touches: number[][];

  constructor(ctx: StrategicContext, nodeOfLandmass: Int32Array) {
    const n = Math.max(4, Math.round((Math.PI / 2) * (ctx.radius / OCEAN_CELL)));
    const og = (this.grid = new CubeGrid(n));
    const m = og.cellCount;
    this.oceanOf = new Int32Array(ctx.grid.cellCount);
    const area = new Float64Array(m);
    const water = new Float64Array(m);
    const shallow = new Float64Array(m);
    const ice = new Float64Array(m);
    const touch: Set<number>[] = Array.from({ length: m }, () => new Set());
    const d = new Vec3d();
    for (let c = 0; c < ctx.grid.cellCount; c++) {
      const o = og.cellOfDirection(ctx.grid.center(c, d));
      this.oceanOf[c] = o;
      const a = ctx.grid.areas[c]!;
      area[o] += a;
      const lm = ctx.labels.label[c]!;
      if (lm < 0) {
        water[o] += a;
        if (-ctx.height[c]! / ctx.reliefScale < SHALLOW_REF_DEPTH) shallow[o] += a;
        if (ctx.biome[c] === Biome.SeaIce) ice[o] += a;
      } else if (nodeOfLandmass[lm]! >= 0) {
        touch[o]!.add(nodeOfLandmass[lm]!);
      }
    }
    this.water = new Float32Array(m);
    this.shallow = new Float32Array(m);
    this.ice = new Float32Array(m);
    this.cost = new Float32Array(m);
    for (let o = 0; o < m; o++) {
      const a = area[o] || 1;
      const w = water[o]! / a;
      this.water[o] = w;
      this.shallow[o] = water[o]! > 0 ? shallow[o]! / water[o]! : 0;
      this.ice[o] = water[o]! > 0 ? ice[o]! / water[o]! : 0;
      this.cost[o] =
        w < MIN_WATER ? Infinity : 1 + 0.6 * this.shallow[o]! + 4 * this.ice[o]! + 1.5 * (1 - w);
    }
    this.touches = touch.map((s) => [...s].sort((a, b) => a - b));
  }

  /** Navigable cell for a coarse sea cell: its own, or the nearest navigable neighbor. */
  navigableFor(coarseCell: number): number {
    const o = this.oceanOf[coarseCell]!;
    if (Number.isFinite(this.cost[o]!)) return o;
    let best = -1;
    let bestWater = -1;
    for (let k = 0; k < 8; k++) {
      const nb = this.grid.neighbors8[o * 8 + k]!;
      if (nb >= 0 && Number.isFinite(this.cost[nb]!) && this.water[nb]! > bestWater) {
        best = nb;
        bestWater = this.water[nb]!;
      }
    }
    return best;
  }
}

interface Search {
  dist: Float64Array;
  prev: Int32Array;
  /** Index of the source (port) each cell was reached from. */
  origin: Int32Array;
}

function dijkstra(
  og: OceanGrid,
  sources: { cell: number; origin: number }[],
  weighted: boolean,
  radius: number,
): Search {
  const g = og.grid;
  const m = g.cellCount;
  const dist = new Float64Array(m).fill(Infinity);
  const prev = new Int32Array(m).fill(-1);
  const origin = new Int32Array(m).fill(-1);
  const heap = new MinHeap(1024);
  for (const s of sources) {
    if (s.cell < 0 || dist[s.cell] === 0) continue;
    dist[s.cell] = 0;
    origin[s.cell] = s.origin;
    heap.push(0, s.cell);
  }
  while (heap.size > 0) {
    const d = heap.peekKey();
    const c = heap.pop();
    if (d > dist[c]!) continue;
    for (let k = 0; k < 8; k++) {
      const nb = g.neighbors8[c * 8 + k]!;
      if (nb < 0 || !Number.isFinite(og.cost[nb]!)) continue;
      const step = g.angleBetween(c, nb) * radius * (weighted ? og.cost[nb]! : 1);
      const nd = d + step;
      if (nd < dist[nb]!) {
        dist[nb] = nd;
        prev[nb] = c;
        origin[nb] = origin[c]!;
        heap.push(nd, nb);
      }
    }
  }
  return { dist, prev, origin };
}

export interface OceanResult {
  lanes: SeaLane[];
  chokepoints: Chokepoint[];
  nodeDistance: Float32Array;
}

export function buildSeaLanes(ctx: StrategicContext, nb: NodeBuild): OceanResult {
  const { radius } = ctx;
  const nodes = nb.nodes;
  const N = nodes.length;
  const og = new OceanGrid(ctx, nb.nodeOfLandmass);

  // Coast-to-coast sea distance between nodes.
  const touching: number[][] = nodes.map(() => []);
  og.touches.forEach((ids, o) => {
    if (!Number.isFinite(og.cost[o]!)) return;
    for (const id of ids) touching[id]!.push(o);
  });
  const nodeDistance = new Float32Array(N * N).fill(Infinity);
  for (let a = 0; a < N; a++) {
    nodeDistance[a * N + a] = 0;
    const s = dijkstra(
      og,
      touching[a]!.map((cell) => ({ cell, origin: 0 })),
      false,
      radius,
    );
    for (let b = 0; b < N; b++) {
      if (b === a) continue;
      let best = Infinity;
      for (const o of touching[b]!) best = Math.min(best, s.dist[o]!);
      nodeDistance[a * N + b] = best;
    }
  }
  // Symmetrize (each search is exact, but the two directions can tie-break differently).
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      const d = Math.min(nodeDistance[a * N + b]!, nodeDistance[b * N + a]!);
      nodeDistance[a * N + b] = d;
      nodeDistance[b * N + a] = d;
    }
  }

  // Least-cost port-to-port routes.
  const portCells = nb.portSea.map((sea) => Array.from(sea, (c) => og.navigableFor(c)));
  const searches = portCells.map((cells) =>
    dijkstra(
      og,
      cells.map((cell, origin) => ({ cell, origin })),
      true,
      radius,
    ),
  );
  const cost = new Float64Array(N * N).fill(Infinity);
  const endPort = new Int32Array(N * N).fill(-1);
  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      if (a === b) continue;
      portCells[b]!.forEach((o, i) => {
        if (o >= 0 && searches[a]!.dist[o]! < cost[a * N + b]!) {
          cost[a * N + b] = searches[a]!.dist[o]!;
          endPort[a * N + b] = i;
        }
      });
    }
  }
  const lanes: SeaLane[] = [];
  const widths: Float64Array[] = [];
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      const direct = cost[a * N + b]!;
      if (!Number.isFinite(direct)) continue;
      const major = (n: LandNode) => n.kind === 'landmass' && n.area >= MAJOR_AREA;
      let dominated = false;
      if (!major(nodes[a]!) || !major(nodes[b]!)) {
        for (let c = 0; c < N && !dominated; c++) {
          if (c === a || c === b) continue;
          dominated = cost[a * N + c]! + cost[c * N + b]! <= DOMINATION_SLACK * direct;
        }
      }
      if (dominated) continue;
      const traced = traceLane(ctx, og, nodes, searches[a]!, a, b, endPort[a * N + b]!, portCells);
      traced.lane.id = lanes.length;
      lanes.push(traced.lane);
      widths.push(traced.widths);
    }
  }
  const chokepoints = findChokepoints(ctx, nb, lanes, widths);
  return { lanes, chokepoints, nodeDistance };
}

function traceLane(
  ctx: StrategicContext,
  og: OceanGrid,
  nodes: LandNode[],
  search: Search,
  a: number,
  b: number,
  portB: number,
  portCells: number[][],
): { lane: SeaLane; widths: Float64Array } {
  const end = portCells[b]![portB]!;
  const cells: number[] = [];
  for (let c = end; c >= 0; c = search.prev[c]!) cells.push(c);
  cells.reverse();
  const portA = search.origin[end]!;
  const pa = nodes[a]!.ports;
  const pb = nodes[b]!.ports;
  const pts: Point[] = [
    [pa.points[portA * 3]!, pa.points[portA * 3 + 1]!, pa.points[portA * 3 + 2]!],
  ];
  for (const c of cells) {
    pts.push([og.grid.centers[c * 3]!, og.grid.centers[c * 3 + 1]!, og.grid.centers[c * 3 + 2]!]);
  }
  pts.push([pb.points[portB * 3]!, pb.points[portB * 3 + 1]!, pb.points[portB * 3 + 2]!]);
  const points = new Float64Array(pts.length * 3);
  pts.forEach((p, i) => points.set(p, i * 3));

  const R = ctx.radius;
  const along = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++)
    along[i] = along[i - 1]! + surfaceDistance(pts[i - 1]!, pts[i]!, R);
  const length = along[pts.length - 1]!;
  const widths = routeWidths(ctx, pts, along, length);
  let minWidth = Infinity;
  let narrowest = pts[Math.floor(pts.length / 2)]!;
  widths.forEach((w, i) => {
    if (w < minWidth) {
      minWidth = w;
      narrowest = pts[i]!;
    }
  });
  let ice = 0;
  for (const c of cells) ice += og.ice[c]!;
  const lane: SeaLane = {
    id: -1,
    a,
    b,
    portA,
    portB,
    points,
    length,
    minWidth,
    narrowest,
    ice: cells.length ? ice / cells.length : 0,
  };
  return { lane, widths };
}

/** Width of water across the route at each point (Infinity near the ends, on land, or wider than 2× the strait limit). */
function routeWidths(
  ctx: StrategicContext,
  pts: Point[],
  along: Float64Array,
  length: number,
): Float64Array {
  const R = ctx.radius;
  const grid = ctx.grid;
  const label = ctx.labels.label;
  const out = new Float64Array(pts.length).fill(Infinity);
  const step = Math.min(3e3, ctx.cellSize / 2);
  const maxReach = 2 * STRAIT_MAX_WIDTH;
  const p = new Vec3d();
  const t = new Vec3d();
  const perp = new Vec3d();
  const q = new Vec3d();
  for (let i = 1; i < pts.length - 1; i++) {
    if (along[i]! < END_MARGIN || length - along[i]! < END_MARGIN) continue;
    p.set(...pts[i]!);
    if (label[grid.cellOfDirection(p)]! >= 0) continue;
    t.set(
      pts[i + 1]![0] - pts[i - 1]![0],
      pts[i + 1]![1] - pts[i - 1]![1],
      pts[i + 1]![2] - pts[i - 1]![2],
    );
    perp.copy(p).cross(t);
    if (perp.lengthSq() < 1e-20) continue;
    perp.normalize();
    let total = 0;
    for (const sign of [1, -1]) {
      let hit = Infinity;
      for (let s = step; s <= maxReach; s += step) {
        const ang = s / R;
        q.copy(p)
          .scale(Math.cos(ang))
          .addScaled(perp, sign * Math.sin(ang));
        if (label[grid.cellOfDirection(q)]! >= 0) {
          hit = s;
          break;
        }
      }
      total += hit;
    }
    out[i] = total;
  }
  return out;
}

function findChokepoints(
  ctx: StrategicContext,
  nb: NodeBuild,
  lanes: SeaLane[],
  laneWidths: Float64Array[],
): Chokepoint[] {
  const R = ctx.radius;
  const straits: Chokepoint[] = [];
  for (const lane of lanes) {
    const widths = laneWidths[lane.id]!;
    let i = 0;
    while (i < widths.length) {
      if (!(widths[i]! < STRAIT_MAX_WIDTH)) {
        i++;
        continue;
      }
      let best = i;
      while (i < widths.length && widths[i]! < STRAIT_MAX_WIDTH) {
        if (widths[i]! < widths[best]!) best = i;
        i++;
      }
      const point = polylinePoint(lane.points, best);
      const near = straits.find((s) => surfaceDistance(s.point, point, R) < STRAIT_MERGE);
      if (near) {
        if (!near.lanes.includes(lane.id)) near.lanes.push(lane.id);
        if (widths[best]! < near.width) {
          near.width = widths[best]!;
          near.point = point;
        }
      } else {
        straits.push({
          id: -1,
          kind: 'strait',
          point,
          width: widths[best]!,
          node: -1,
          islandArea: 0,
          airfields: 0,
          lanes: [lane.id],
        });
      }
    }
  }

  // Islands with an airfield site near a lane.
  const { stats, labels } = ctx;
  const islands = labels.landmasses
    .filter((m) => m.area < ISLAND_MAX_AREA)
    .map((m) => ({ id: m.id, area: m.area, centroid: stats[m.id]!.centroid }));
  const airfieldCount = new Int32Array(labels.landmasses.length);
  // Airbase sites per landmass label, via each node's merged list.
  for (const node of nb.nodes) {
    for (const cell of node.airbases.cells) airfieldCount[labels.label[cell]!]++;
  }
  const islandChokes = new Map<number, Chokepoint>();
  for (const lane of lanes) {
    const count = lane.points.length / 3;
    const start = polylinePoint(lane.points, 0);
    const end = polylinePoint(lane.points, count - 1);
    const near: { island: (typeof islands)[number]; d: number }[] = [];
    for (const isl of islands) {
      if (airfieldCount[isl.id]! === 0) continue;
      const node = nb.nodeOfLandmass[isl.id]!;
      if (node === lane.a || node === lane.b) continue;
      if (
        surfaceDistance(isl.centroid, start, R) < ISLAND_END_CLEARANCE ||
        surfaceDistance(isl.centroid, end, R) < ISLAND_END_CLEARANCE
      ) {
        continue;
      }
      let d = Infinity;
      for (let k = 0; k < count; k++) {
        d = Math.min(d, surfaceDistance(isl.centroid, polylinePoint(lane.points, k), R));
      }
      if (d <= ISLAND_REACH) near.push({ island: isl, d });
    }
    near.sort((x, y) => x.d - y.d || x.island.id - y.island.id);
    for (const { island, d } of near.slice(0, ISLANDS_PER_LANE)) {
      let cp = islandChokes.get(island.id);
      if (!cp) {
        cp = {
          id: -1,
          kind: 'island',
          point: island.centroid,
          width: d,
          node: nb.nodeOfLandmass[island.id]!,
          islandArea: island.area,
          airfields: airfieldCount[island.id]!,
          lanes: [],
        };
        islandChokes.set(island.id, cp);
      }
      cp.width = Math.min(cp.width, d);
      cp.lanes.push(lane.id);
    }
  }
  const all = [
    ...straits,
    ...[...islandChokes.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => c),
  ];
  all.forEach((c, i) => {
    c.id = i;
    c.lanes.sort((x, y) => x - y);
  });
  return all;
}
