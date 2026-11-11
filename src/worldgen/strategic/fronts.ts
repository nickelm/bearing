/**
 * The front generator (design, "Automatic Front Line").
 *
 * 1. **Barrier map** per land cell from river width, slope, ridge
 *    prominence, forest density (decision 44) and lakes, combined as
 *    independent obstacles: b = 1 − Π(1 − bᵢ).
 * 2. **Axis.** Each landmass of at least FRONT_MIN_AREA gets a principal axis
 *    (the major axis of its area in an azimuthal projection about the
 *    centroid) and an area quantile q along it.
 * 3. **Line search.** A least-cost path over 8-neighbors from one coast to the
 *    other within the band q ∈ [BAND_LO, BAND_HI], with step cost
 *    length × (0.15 + (1 − b)²), so it follows rivers, ridges and forest and
 *    takes the shorter of two equally strong crossings. The band keeps both
 *    sides at least BAND_LO of the area; the start line needs FRONT_MIN_SIDE.
 * 4. **Exclusion corridors.** Each line excludes the band within a corridor
 *    around it, and the search repeats, up to MAX_LINES roughly parallel lines
 *    that cannot cross.
 * 5. **Start line** one line forward of the strongest, so the defender starts
 *    exposed with a strong line to fall back to. The forward side is the
 *    attacker's.
 * 6. **Corridors:** the weakest windows of about CORRIDOR_WIDTH along each
 *    line (milestone 5 refines them with roads).
 */
import { MinHeap } from '../../core/heap';
import { Vec3d } from '../../core/vec3d';
import { riverWidth } from '../rivers';
import { CORRIDOR_DEPTH, FRONT_MIN_AREA, FRONT_MIN_SIDE, ROAD_CLASS_WEIGHT } from './graph';
import type {
  BarrierLine,
  Corridor,
  FrontGeometry,
  LandNode,
  LineSide,
  Point,
  RoadNetwork,
  SettlementList,
} from './graph';
import { CapWalker, smoothstep } from './input';
import type { StrategicContext } from './input';

const BAND_LO = 0.2;
const BAND_HI = 0.8;
const MAX_LINES = 4;
const MIN_EXCLUSION = 60e3;
const CORRIDOR_WIDTH = 50e3;
const CORRIDOR_SPACING = 150e3;
const CORRIDORS_PER_LINE = 3;
const PROMINENCE_RADIUS = 30e3;
/** Side depth ignores the most remote land beyond this area fraction (peninsula tips). */
const DEPTH_QUANTILE = 0.9;

/** Barrier strength 0..1 per coarse cell (0 at sea). */
export function barrierMap(ctx: StrategicContext, walker = new CapWalker(ctx.grid)): Float32Array {
  const { grid, height, reliefScale } = ctx;
  const label = ctx.labels.label;
  const out = new Float32Array(grid.cellCount);
  const angle = Math.max(PROMINENCE_RADIUS, 1.5 * ctx.cellSize) / ctx.radius;
  for (let c = 0; c < grid.cellCount; c++) {
    if (label[c]! < 0) continue;
    let sum = 0;
    let wsum = 0;
    walker.walk(c, angle, (x) => {
      sum += Math.max(0, height[x]!) * grid.areas[x]!;
      wsum += grid.areas[x]!;
    });
    const prominence = (height[c]! - sum / wsum) / reliefScale;
    const q = ctx.discharge[c]!;
    const river = q >= 20 ? smoothstep(15, 200, riverWidth(q)) : 0;
    const steep = smoothstep(0.03, 0.15, ctx.slope[c]!);
    const ridge = smoothstep(150, 1200, prominence);
    const forest = 0.35 * ctx.forest[c]!;
    const lake = ctx.lakeDepth[c]! > 0 ? 0.7 : 0;
    out[c] = 1 - (1 - river) * (1 - steep) * (1 - ridge) * (1 - forest) * (1 - lake);
  }
  return out;
}

export interface FrontResult {
  lines: BarrierLine[];
  fronts: FrontGeometry[];
}

function cellPoint(ctx: StrategicContext, c: number): Point {
  const g = ctx.grid.centers;
  return [g[c * 3]!, g[c * 3 + 1]!, g[c * 3 + 2]!];
}

/** Front geometry for every landmass node of at least FRONT_MIN_AREA. */
/** Settlements and roads, which the front generator uses for offsets and corridors. */
export interface FrontCivilian {
  settlements: SettlementList;
  roads: RoadNetwork;
}

export function buildFronts(
  ctx: StrategicContext,
  nodes: LandNode[],
  members: number[][],
  barrier: Float32Array,
  civ: FrontCivilian,
): FrontResult {
  const lines: BarrierLine[] = [];
  const fronts: FrontGeometry[] = [];
  for (const node of nodes) {
    if (node.kind !== 'landmass' || node.area < FRONT_MIN_AREA) continue;
    const front = landmassFront(ctx, node, members[node.id]![0]!, barrier, lines, civ);
    if (!front) continue;
    node.front = fronts.length;
    fronts.push(front);
  }
  return { lines, fronts };
}

function landmassFront(
  ctx: StrategicContext,
  node: LandNode,
  landmass: number,
  barrier: Float32Array,
  lines: BarrierLine[],
  civ: FrontCivilian,
): FrontGeometry | null {
  const { grid, radius } = ctx;
  const label = ctx.labels.label;
  const cells: number[] = [];
  for (let c = 0; c < grid.cellCount; c++) if (label[c] === landmass) cells.push(c);
  const inLand = (c: number) => c >= 0 && label[c] === landmass;

  // Principal axis in an azimuthal equidistant projection about the centroid.
  const C = node.centroid;
  const ref: Point = Math.abs(C[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1: Point = [
    ref[1] * C[2] - ref[2] * C[1],
    ref[2] * C[0] - ref[0] * C[2],
    ref[0] * C[1] - ref[1] * C[0],
  ];
  // No sin, cos, acos or hypot below: their results can differ in the last bit between
  // V8's compilation tiers on some CPUs, and the band cut by sorted axis position turns
  // a last-bit change into a different front (TODO.md Known issues; decision 86). Only
  // +, −, ×, ÷, sqrt and atan2 (as in angleBetween) remain.
  const l1 = Math.sqrt(e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2]);
  e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
  const e2: Point = [
    C[1] * e1[2] - C[2] * e1[1],
    C[2] * e1[0] - C[0] * e1[2],
    C[0] * e1[1] - C[1] * e1[0],
  ];
  const px = new Float64Array(grid.cellCount);
  const py = new Float64Array(grid.cellCount);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let mx = 0;
  let my = 0;
  let wsum = 0;
  for (const c of cells) {
    const p = cellPoint(ctx, c);
    // Azimuthal equidistant: angle from the centroid, along the direction (x, y).
    const z = p[0] * C[0] + p[1] * C[1] + p[2] * C[2];
    const x = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2];
    const y = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2];
    const r = Math.sqrt(x * x + y * y);
    const theta = Math.atan2(r, z);
    px[c] = r > 0 ? (theta * x) / r : 0;
    py[c] = r > 0 ? (theta * y) / r : 0;
    const a = grid.areas[c]!;
    mx += px[c]! * a;
    my += py[c]! * a;
    wsum += a;
  }
  mx /= wsum;
  my /= wsum;
  for (const c of cells) {
    const a = grid.areas[c]!;
    const x = px[c]! - mx;
    const y = py[c]! - my;
    sxx += x * x * a;
    syy += y * y * a;
    sxy += x * y * a;
  }
  // Principal axis at alpha = atan2(2·sxy, sxx − syy) / 2, by half-angle identities.
  const h = Math.sqrt(4 * sxy * sxy + (sxx - syy) * (sxx - syy));
  const cos2a = h > 0 ? (sxx - syy) / h : 1;
  const ca = Math.sqrt(Math.max(0, (1 + cos2a) / 2));
  const sa = (sxy < 0 ? -1 : 1) * Math.sqrt(Math.max(0, (1 - cos2a) / 2));
  const t = new Float64Array(grid.cellCount);
  const s = new Float64Array(grid.cellCount);
  for (const c of cells) {
    t[c] = px[c]! * ca + py[c]! * sa;
    s[c] = -px[c]! * sa + py[c]! * ca;
  }
  const order = [...cells].sort((a, b) => t[a]! - t[b]! || a - b);
  const q = new Float64Array(grid.cellCount);
  let acc = 0;
  for (const c of order) {
    acc += grid.areas[c]!;
    q[c] = (acc - grid.areas[c]! / 2) / wsum;
  }
  const inBand = (c: number) => inLand(c) && q[c]! >= BAND_LO && q[c]! <= BAND_HI;
  let tLo = Infinity;
  let tHi = -Infinity;
  for (const c of cells) {
    if (!inBand(c)) continue;
    tLo = Math.min(tLo, t[c]!);
    tHi = Math.max(tHi, t[c]!);
  }
  const exclusion = Math.max(MIN_EXCLUSION, 3 * ctx.cellSize, ((tHi - tLo) * radius) / 8);

  // The two coastal arcs of the band: 8-connected components of coastal band
  // cells, taking those with the largest and smallest mean minor coordinate.
  const coastal = (c: number) => {
    for (let k = 0; k < 4; k++) if (!inLand(grid.neighbors4[c * 4 + k]!)) return true;
    return false;
  };
  const comp = new Int32Array(grid.cellCount).fill(-1);
  const comps: { cells: number[]; meanS: number }[] = [];
  for (const c of cells) {
    if (!inBand(c) || !coastal(c) || comp[c]! >= 0) continue;
    const id = comps.length;
    const list: number[] = [];
    const stack = [c];
    comp[c] = id;
    while (stack.length) {
      const x = stack.pop()!;
      list.push(x);
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[x * 8 + k]!;
        if (nb >= 0 && comp[nb]! < 0 && inBand(nb) && coastal(nb)) {
          comp[nb] = id;
          stack.push(nb);
        }
      }
    }
    comps.push({ cells: list, meanS: list.reduce((m, x) => m + s[x]!, 0) / list.length });
  }
  // The largest coastal stretch, and the largest one on the other side of the band's midline.
  let bandS = 0;
  let bandW = 0;
  for (const c of cells) {
    if (!inBand(c)) continue;
    bandS += s[c]! * grid.areas[c]!;
    bandW += grid.areas[c]!;
  }
  bandS /= bandW;
  const bySize = comps
    .map((k, i) => ({ ...k, i }))
    .filter((k) => k.cells.length >= 2)
    .sort((a, b) => b.cells.length - a.cells.length || a.i - b.i);
  const left = bySize[0];
  const right = left && bySize.find((k) => k.meanS - bandS > 0 !== left.meanS - bandS > 0);
  if (!left || !right) return null;
  const isTarget = new Uint8Array(grid.cellCount);
  for (const c of right.cells) isTarget[c] = 1;

  const excluded = new Uint8Array(grid.cellCount);
  const found: { line: BarrierLine; side: Int8Array; path: number[] }[] = [];
  const heap = new MinHeap(4096);
  const dist = new Float64Array(grid.cellCount);
  const prev = new Int32Array(grid.cellCount);
  for (let attempt = 0; attempt < MAX_LINES; attempt++) {
    // Least-cost coast-to-coast path inside the band.
    dist.fill(Infinity);
    prev.fill(-1);
    heap.clear();
    for (const c of left.cells) {
      if (excluded[c]) continue;
      dist[c] = 0;
      heap.push(0, c);
    }
    let end = -1;
    while (heap.size > 0) {
      const d = heap.peekKey();
      const c = heap.pop();
      if (d > dist[c]!) continue;
      if (isTarget[c]) {
        end = c;
        break;
      }
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[c * 8 + k]!;
        if (nb < 0 || !inBand(nb) || excluded[nb]) continue;
        const w = 1 - barrier[nb]!;
        const nd = d + grid.angleBetween(c, nb) * radius * (0.15 + w * w);
        if (nd < dist[nb]!) {
          dist[nb] = nd;
          prev[nb] = c;
          heap.push(nd, nb);
        }
      }
    }
    if (end < 0) break;
    const path: number[] = [];
    for (let c = end; c >= 0; c = prev[c]!) path.push(c);
    path.reverse();

    const result = lineFromPath(ctx, node, landmass, cells, path, q, barrier, civ.settlements);
    if (!result) {
      // The path does not split the land (it wraps around an inland sea): rule out its cells and retry.
      for (const c of path) {
        excluded[c] = 1;
        for (let k = 0; k < 8; k++) {
          const nb = grid.neighbors8[c * 8 + k]!;
          if (nb >= 0) excluded[nb] = 1;
        }
      }
      continue;
    }
    // Exclude the corridor around the line for later searches.
    for (const c of cells) if (result.distance[c]! < exclusion) excluded[c] = 1;
    found.push({ line: result.line, side: result.side, path });
  }
  if (found.length === 0) return null;

  found.sort((a, b) => a.line.sides[0].fraction - b.line.sides[0].fraction);
  const ids: number[] = [];
  const corridors: Corridor[] = [];
  for (const f of found) {
    f.line.id = lines.length;
    ids.push(f.line.id);
    lines.push(f.line);
    corridors.push(
      ...lineCorridors(ctx, f.line, f.side, roadCrossings(ctx, f.path, f.side, civ.roads)),
    );
  }
  let strongestIdx = 0;
  found.forEach((f, i) => {
    if (f.line.meanStrength > found[strongestIdx]!.line.meanStrength) strongestIdx = i;
  });
  const valid = (l: BarrierLine) =>
    Math.min(l.sides[0].fraction, l.sides[1].fraction) >= FRONT_MIN_SIDE;
  let start = -1;
  let forwardSide: 0 | 1 = 1;
  // One line forward of the strongest; with two candidates, the one giving the attacker more land.
  const options: { line: BarrierLine; forward: 0 | 1 }[] = [];
  const after = found[strongestIdx + 1]?.line;
  const before = found[strongestIdx - 1]?.line;
  if (after && valid(after)) options.push({ line: after, forward: 1 });
  if (before && valid(before)) options.push({ line: before, forward: 0 });
  options.sort(
    (a, b) =>
      b.line.sides[b.forward].fraction - a.line.sides[a.forward].fraction || a.line.id - b.line.id,
  );
  if (options.length > 0) {
    start = options[0]!.line.id;
    forwardSide = options[0]!.forward;
  } else {
    // No neighbor qualifies: the strongest valid line itself, attacker on its larger side.
    const fallback = found
      .map((f) => f.line)
      .filter(valid)
      .sort((a, b) => b.meanStrength - a.meanStrength || a.id - b.id)[0];
    if (fallback) {
      start = fallback.id;
      forwardSide = fallback.sides[1].fraction > fallback.sides[0].fraction ? 1 : 0;
    }
  }
  return {
    node: node.id,
    lines: ids,
    strongest: found[strongestIdx]!.line.id,
    start,
    forwardSide,
    corridors,
  };
}

function lineFromPath(
  ctx: StrategicContext,
  node: LandNode,
  landmass: number,
  cells: number[],
  path: number[],
  q: Float64Array,
  barrier: Float32Array,
  settlements: SettlementList,
): { line: BarrierLine; side: Int8Array; distance: Float64Array } | null {
  const { grid, radius } = ctx;
  const label = ctx.labels.label;
  const onPath = new Uint8Array(grid.cellCount);
  for (const c of path) onPath[c] = 1;

  // Sides by 4-connected flood fill from the two ends of the axis; an
  // 8-connected path blocks it. If the floods meet, the path does not split the land.
  const side = new Int8Array(grid.cellCount).fill(-1);
  const stack: number[] = [];
  for (const c of cells) {
    if (onPath[c]) continue;
    if (q[c]! < BAND_LO) {
      side[c] = 0;
      stack.push(c);
    }
  }
  const flood = (value: 0 | 1): boolean => {
    while (stack.length) {
      const c = stack.pop()!;
      for (let k = 0; k < 4; k++) {
        const nb = grid.neighbors4[c * 4 + k]!;
        if (label[nb] !== landmass || onPath[nb]) continue;
        if (side[nb] === value) continue;
        if (side[nb]! >= 0) return false;
        side[nb] = value;
        stack.push(nb);
      }
    }
    return true;
  };
  if (!flood(0)) return null;
  for (const c of cells) {
    if (onPath[c] || q[c]! <= BAND_HI) continue;
    if (side[c] === 0) return null;
    if (side[c]! < 0) {
      side[c] = 1;
      stack.push(c);
    }
  }
  if (!flood(1)) return null;
  // Enclosed pockets go by position along the axis.
  let meanQ = 0;
  for (const c of path) meanQ += q[c]!;
  meanQ /= path.length;
  for (const c of cells) if (!onPath[c] && side[c]! < 0) side[c] = q[c]! < meanQ ? 0 : 1;

  // Distance from the line over the landmass.
  const distance = new Float64Array(grid.cellCount).fill(Infinity);
  const heap = new MinHeap(4096);
  for (const c of path) {
    distance[c] = 0;
    heap.push(0, c);
  }
  while (heap.size > 0) {
    const d = heap.peekKey();
    const c = heap.pop();
    if (d > distance[c]!) continue;
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      if (nb < 0 || label[nb] !== landmass) continue;
      const nd = d + grid.angleBetween(c, nb) * radius;
      if (nd < distance[nb]!) {
        distance[nb] = nd;
        heap.push(nd, nb);
      }
    }
  }

  const sides: [LineSide, LineSide] = [0, 1].map((v) => {
    let area = 0;
    const dists: [number, number][] = [];
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const c of cells) {
      if (side[c] !== v || onPath[c]) continue;
      const a = grid.areas[c]!;
      area += a;
      cx += grid.centers[c * 3]! * a;
      cy += grid.centers[c * 3 + 1]! * a;
      cz += grid.centers[c * 3 + 2]! * a;
      if (Number.isFinite(distance[c]!)) dists.push([distance[c]!, a]);
    }
    const len = Math.hypot(cx, cy, cz) || 1;
    const areaM2 = area * radius * radius;
    // Depth: the distance within which DEPTH_QUANTILE of the side's land lies.
    dists.sort((x, y) => x[0] - y[0]);
    let depth = 0;
    let seen = 0;
    for (const [d, a] of dists) {
      seen += a;
      depth = d;
      if (seen >= DEPTH_QUANTILE * area) break;
    }
    return {
      area: areaM2,
      fraction: areaM2 / node.area,
      centroid: [cx / len, cy / len, cz / len] as Point,
      depth,
    };
  }) as [LineSide, LineSide];

  // Polyline: cell centers, lightly smoothed (ends fixed); strength per point.
  const raw = path.map((c) => cellPoint(ctx, c));
  const points = new Float64Array(raw.length * 3);
  const strength = new Float32Array(raw.length);
  let length = 0;
  let weighted = 0;
  raw.forEach((p, i) => {
    let v = p;
    if (i > 0 && i < raw.length - 1) {
      const a = raw[i - 1]!;
      const b = raw[i + 1]!;
      const m: Point = [
        0.25 * a[0] + 0.5 * p[0] + 0.25 * b[0],
        0.25 * a[1] + 0.5 * p[1] + 0.25 * b[1],
        0.25 * a[2] + 0.5 * p[2] + 0.25 * b[2],
      ];
      const l = Math.hypot(...m);
      v = [m[0] / l, m[1] / l, m[2] / l];
    }
    points.set(v, i * 3);
    strength[i] = barrier[path[i]!]!;
    if (i > 0) {
      const step = grid.angleBetween(path[i - 1]!, path[i]!) * radius;
      length += step;
      weighted += step * 0.5 * (barrier[path[i - 1]!]! + barrier[path[i]!]!);
    }
  });
  const offsets = (cellsOf: Int32Array) =>
    Float32Array.from(cellsOf, (c) => {
      if (onPath[c]) return 0;
      const d = Number.isFinite(distance[c]!) ? distance[c]! : 0;
      return side[c] === 0 ? -d : d;
    });
  const line: BarrierLine = {
    id: -1,
    node: node.id,
    points,
    strength,
    meanStrength: length > 0 ? weighted / length : barrier[path[0]!]!,
    length,
    sides,
    airbaseOffset: offsets(node.airbases.cells),
    portOffset: offsets(node.ports.cells),
    settlementOffset: Float32Array.from(settlements.cells, (c) =>
      label[c] === landmass ? offsets(Int32Array.of(c))[0]! : NaN,
    ),
  };
  return { line, side, distance };
}

/** A road crossing a barrier line: index of the nearest line point, and the road class. */
interface Crossing {
  index: number;
  roadClass: number;
}

/**
 * Where roads cross a line: a road's cells change side (skipping cells on
 * the line itself). The crossing is placed at the line cell the road touched,
 * or at the line cell next to the road's last cell before it changed side.
 */
function roadCrossings(
  ctx: StrategicContext,
  path: number[],
  side: Int8Array,
  roads: RoadNetwork,
): Crossing[] {
  const grid = ctx.grid;
  const index = new Map<number, number>();
  path.forEach((c, i) => index.set(c, i));
  const out: Crossing[] = [];
  for (let k = 0; k < roads.count; k++) {
    let lastSide = -1;
    let lastCell = -1;
    let touched = -1;
    for (let p = roads.offsets[k]!; p < roads.offsets[k + 1]!; p++) {
      const c = roads.cells[p]!;
      const onLine = index.get(c);
      if (onLine !== undefined) {
        touched = onLine;
        continue;
      }
      const s = side[c]!;
      if (s < 0) continue;
      if (lastSide >= 0 && s !== lastSide) {
        let at = touched;
        if (at < 0) {
          for (let j = 0; j < 8 && at < 0; j++)
            at = index.get(grid.neighbors8[lastCell * 8 + j]!) ?? -1;
        }
        if (at >= 0) out.push({ index: at, roadClass: roads.roadClass[k]! });
      }
      lastSide = s;
      lastCell = c;
      touched = -1;
    }
  }
  return out;
}

/**
 * Invasion corridors (design, "Automatic Front Line"): weak, well-roaded
 * windows of a line, at most CORRIDORS_PER_LINE, CORRIDOR_SPACING apart and
 * away from the coasts. A window scores (1 − mean strength) × (0.35 + 0.65 ×
 * min(1, road score)), where the road score sums ROAD_CLASS_WEIGHT over the
 * roads crossing it; windows at or above the line's mean strength are taken
 * only when roads cross them. A corridor centers on its best road crossing.
 */
function lineCorridors(
  ctx: StrategicContext,
  line: BarrierLine,
  side: Int8Array,
  crossings: Crossing[],
): Corridor[] {
  const R = ctx.radius;
  const n = line.points.length / 3;
  const along = new Float64Array(n);
  const pt = (i: number): Point => [
    line.points[i * 3]!,
    line.points[i * 3 + 1]!,
    line.points[i * 3 + 2]!,
  ];
  for (let i = 1; i < n; i++) {
    const a = pt(i - 1);
    const b = pt(i);
    along[i] = along[i - 1]! + R * Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  }
  const total = along[n - 1]!;
  const margin = Math.max(30e3, ctx.cellSize);
  const windows: {
    center: number;
    mean: number;
    width: number;
    roads: number;
    roadScore: number;
    score: number;
  }[] = [];
  for (let i = 0; i < n; i++) {
    if (
      along[i]! < margin + CORRIDOR_WIDTH / 2 ||
      total - along[i]! < margin + CORRIDOR_WIDTH / 2
    ) {
      continue;
    }
    let sum = 0;
    let count = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < n; j++) {
      if (Math.abs(along[j]! - along[i]!) <= CORRIDOR_WIDTH / 2) {
        sum += line.strength[j]!;
        count++;
        lo = Math.min(lo, along[j]!);
        hi = Math.max(hi, along[j]!);
      }
    }
    let roads = 0;
    let roadScore = 0;
    let best = -1;
    for (const x of crossings) {
      if (Math.abs(along[x.index]! - along[i]!) > CORRIDOR_WIDTH / 2) continue;
      roads++;
      roadScore += ROAD_CLASS_WEIGHT[x.roadClass]!;
      if (
        best < 0 ||
        x.roadClass < crossings[best]!.roadClass ||
        (x.roadClass === crossings[best]!.roadClass &&
          Math.abs(x.index - i) < Math.abs(crossings[best]!.index - i))
      ) {
        best = crossings.indexOf(x);
      }
    }
    const mean = sum / count;
    windows.push({
      center: best >= 0 ? crossings[best]!.index : i,
      mean,
      width: Math.max(hi - lo, ctx.cellSize),
      roads,
      roadScore,
      score: (1 - mean) * (0.35 + 0.65 * Math.min(1, roadScore)),
    });
  }
  windows.sort((a, b) => b.score - a.score || a.center - b.center);
  const chosen: typeof windows = [];
  for (const w of windows) {
    if (chosen.length >= CORRIDORS_PER_LINE) break;
    if (w.mean >= line.meanStrength && w.roads === 0) continue;
    if (chosen.some((c) => Math.abs(along[c.center]! - along[w.center]!) < CORRIDOR_SPACING))
      continue;
    chosen.push(w);
  }
  return chosen.map((w) => {
    const i = w.center;
    const p = pt(i);
    const a = pt(Math.max(0, i - 1));
    const b = pt(Math.min(n - 1, i + 1));
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const tz = b[2] - a[2];
    let perp: Point = [p[1] * tz - p[2] * ty, p[2] * tx - p[0] * tz, p[0] * ty - p[1] * tx];
    const l = Math.hypot(...perp) || 1;
    perp = [perp[0] / l, perp[1] / l, perp[2] / l];
    const along = (dist: number): Point => {
      const ang = dist / R;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      return [p[0] * c + perp[0] * s, p[1] * c + perp[1] * s, p[2] * c + perp[2] * s];
    };
    // Orient the axis from side 0 to side 1.
    const probe = along(Math.max(2 * ctx.cellSize, 20e3));
    const probeCell = ctx.grid.cellOfDirection(new Vec3d(...probe));
    const flip = side[probeCell] === 0;
    const from = along(flip ? CORRIDOR_DEPTH : -CORRIDOR_DEPTH);
    const to = along(flip ? -CORRIDOR_DEPTH : CORRIDOR_DEPTH);
    return {
      line: line.id,
      point: p,
      from,
      to,
      width: w.width,
      strength: w.mean,
      roads: w.roads,
      roadScore: w.roadScore,
      name: '',
    };
  });
}
