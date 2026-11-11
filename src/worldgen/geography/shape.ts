/**
 * Shared geometry for feature extraction (decision 95): connected components of a
 * cell mask, the shape of a region (anchor, extent, label axis), and polyline
 * simplification and smoothing on the unit sphere.
 */
import type { CubeGrid } from '../../core/cubeGrid';
import { Vec3d } from '../../core/vec3d';
import type { Point } from '../strategic/graph';

/** Connected components of `mask` over 8-neighbors, in order of their lowest cell. */
export function components(grid: CubeGrid, mask: Uint8Array): number[][] {
  const seen = new Uint8Array(grid.cellCount);
  const stack: number[] = [];
  const out: number[][] = [];
  for (let start = 0; start < grid.cellCount; start++) {
    if (!mask[start] || seen[start]) continue;
    const cells: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const c = stack.pop()!;
      cells.push(c);
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[c * 8 + k]!;
        if (nb >= 0 && mask[nb] && !seen[nb]) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
    cells.sort((a, b) => a - b);
    out.push(cells);
  }
  return out;
}

/** Area of a set of cells (m²). */
export function cellArea(grid: CubeGrid, cells: readonly number[], radius: number): number {
  let a = 0;
  for (const c of cells) a += grid.areas[c]!;
  return a * radius * radius;
}

export function cellPoint(grid: CubeGrid, c: number): Point {
  return [grid.centers[c * 3]!, grid.centers[c * 3 + 1]!, grid.centers[c * 3 + 2]!];
}

export function dot(a: Readonly<Point>, b: Readonly<Point>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalize(p: Point): Point {
  const l = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
}

/** Local east and north unit vectors at a unit direction (+Y is north). */
export function tangentFrame(p: Readonly<Point>): { east: Point; north: Point } {
  let east: Point = [p[2], 0, -p[0]];
  const l = Math.hypot(east[0], east[2]);
  east = l < 1e-9 ? [1, 0, 0] : [east[0] / l, 0, east[2] / l];
  const north: Point = [
    p[1] * east[2] - p[2] * east[1],
    p[2] * east[0] - p[0] * east[2],
    p[0] * east[1] - p[1] * east[0],
  ];
  return { east, north };
}

/** The point at angle t (rad) from `a` along the great circle with unit tangent `d`. */
export function along(a: Readonly<Point>, d: Readonly<Point>, t: number): Point {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [a[0] * c + d[0] * s, a[1] * c + d[1] * s, a[2] * c + d[2] * s];
}

/** Reused per-cell buffers for regionShape (one set per grid size). */
let scratchBuffers: { stamp: Int32Array; depth: Int32Array; round: number } | null = null;
function scratch(n: number) {
  if (!scratchBuffers || scratchBuffers.stamp.length !== n) {
    scratchBuffers = { stamp: new Int32Array(n), depth: new Int32Array(n), round: 0 };
  }
  return scratchBuffers;
}

export interface RegionShape {
  /** The most interior cell (farthest from the region's edge; nearest the centroid on ties). */
  anchorCell: number;
  anchor: Point;
  /** Angular radius (rad) of the cap around the anchor that holds every cell, times the radius. */
  extent: number;
  /** Label axis: the chord along the principal direction through the anchor, three points. */
  axis: Point[];
}

/**
 * Anchor, extent and label axis of a region. `inside(cell)` tests membership (for
 * marching the axis); the march tolerates gaps of up to two steps, so the axis
 * crosses narrow inlets and channels.
 */
export function regionShape(
  grid: CubeGrid,
  cells: readonly number[],
  inside: (cell: number) => boolean,
  radius: number,
): RegionShape {
  // Interior depth by breadth-first search from the region's edge cells.
  const s = scratch(grid.cellCount);
  const stamp = ++s.round;
  const queue: number[] = [];
  const mark = (c: number, d: number) => {
    s.stamp[c] = stamp;
    s.depth[c] = d;
    queue.push(c);
  };
  for (const c of cells) {
    for (let k = 0; k < 4; k++) {
      if (!inside(grid.neighbors4[c * 4 + k]!)) {
        mark(c, 0);
        break;
      }
    }
  }
  if (queue.length === 0) mark(cells[0]!, 0);
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!;
    const d = s.depth[c]!;
    for (let k = 0; k < 4; k++) {
      const nb = grid.neighbors4[c * 4 + k]!;
      if (s.stamp[nb] !== stamp && inside(nb)) mark(nb, d + 1);
    }
  }
  const depthOf = (c: number) => (s.stamp[c] === stamp ? s.depth[c]! : 0);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const c of cells) {
    const a = grid.areas[c]!;
    cx += grid.centers[c * 3]! * a;
    cy += grid.centers[c * 3 + 1]! * a;
    cz += grid.centers[c * 3 + 2]! * a;
  }
  const centroid = normalize([cx, cy, cz]);
  let anchorCell = cells[0]!;
  let bestDepth = -1;
  let bestDot = -2;
  for (const c of cells) {
    const d = depthOf(c);
    const k = dot(cellPoint(grid, c), centroid);
    if (d > bestDepth || (d === bestDepth && k > bestDot)) {
      bestDepth = d;
      bestDot = k;
      anchorCell = c;
    }
  }
  const anchor = cellPoint(grid, anchorCell);
  let maxAngle = 0;
  const { east, north } = tangentFrame(anchor);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const c of cells) {
    const p = cellPoint(grid, c);
    const k = dot(p, anchor);
    maxAngle = Math.max(maxAngle, Math.acos(Math.min(1, k)));
    if (k <= 0.05) continue;
    // Gnomonic projection around the anchor.
    const x = dot(p, east) / k;
    const y = dot(p, north) / k;
    const a = grid.areas[c]!;
    sxx += x * x * a;
    syy += y * y * a;
    sxy += x * y * a;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dir: Point = normalize([
    east[0] * Math.cos(theta) + north[0] * Math.sin(theta),
    east[1] * Math.cos(theta) + north[1] * Math.sin(theta),
    east[2] * Math.cos(theta) + north[2] * Math.sin(theta),
  ]);
  const step = (0.5 * Math.PI) / 2 / grid.n;
  const v = new Vec3d();
  const reach = (sign: number) => {
    let last = 0;
    let gap = 0;
    for (let t = step; t < Math.min(maxAngle + step, Math.PI / 2); t += step) {
      const p = along(anchor, dir, sign * t);
      if (inside(grid.cellOfDirection(v.set(p[0], p[1], p[2])))) {
        last = t;
        gap = 0;
      } else if (++gap > 2) {
        break;
      }
    }
    return sign * last;
  };
  const t0 = reach(-1);
  const t1 = reach(1);
  const axis = [along(anchor, dir, t0), along(anchor, dir, (t0 + t1) / 2), along(anchor, dir, t1)];
  return { anchorCell, anchor, extent: maxAngle * radius, axis };
}

/** Perpendicular angular distance from p to the great circle through a and b. */
function offLine(p: Readonly<Point>, a: Readonly<Point>, b: Readonly<Point>): number {
  const n = normalize([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);
  return Math.abs(Math.asin(Math.max(-1, Math.min(1, dot(p, n)))));
}

/** Douglas–Peucker simplification with an angular tolerance (rad). */
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    let worst = -1;
    let dmax = tolerance;
    for (let k = i + 1; k < j; k++) {
      const d = offLine(points[k]!, points[i]!, points[j]!);
      if (d > dmax) {
        dmax = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

/** Chaikin corner cutting, `rounds` times, keeping the end points; results stay on the sphere. */
export function smooth(points: Point[], rounds = 2): Point[] {
  let p = points;
  for (let r = 0; r < rounds && p.length > 2; r++) {
    const out: Point[] = [p[0]!];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i]!;
      const b = p[i + 1]!;
      out.push(
        normalize([
          0.75 * a[0] + 0.25 * b[0],
          0.75 * a[1] + 0.25 * b[1],
          0.75 * a[2] + 0.25 * b[2],
        ]),
        normalize([
          0.25 * a[0] + 0.75 * b[0],
          0.25 * a[1] + 0.75 * b[1],
          0.25 * a[2] + 0.75 * b[2],
        ]),
      );
    }
    out.push(p[p.length - 1]!);
    p = out;
  }
  return p;
}

/** Length of a polyline of unit directions (m). */
export function polylineLength(points: readonly Point[], radius: number): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    s += Math.acos(Math.min(1, dot(points[i - 1]!, points[i]!)));
  }
  return s * radius;
}
