/**
 * Plane geometry for the settlement generator (proposal 0009): points are [x, y]
 * in meters in a settlement's local frame; polygons are flat [x0, y0, x1, y1, …]
 * arrays, counterclockwise for positive area.
 */

export type P2 = readonly [number, number];
/** A polygon as a flat coordinate array. */
export type Poly = number[];

export function polyArea(p: Poly): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2]! * p[j * 2 + 1]! - p[j * 2]! * p[i * 2 + 1]!;
  }
  return a / 2;
}

export function polyCentroid(p: Poly): [number, number] {
  let cx = 0;
  let cy = 0;
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = p[i * 2]!;
    const y0 = p[i * 2 + 1]!;
    const x1 = p[j * 2]!;
    const y1 = p[j * 2 + 1]!;
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += p[i * 2]!;
      sy += p[i * 2 + 1]!;
    }
    return [sx / n, sy / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function polyPerimeter(p: Poly): number {
  let s = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += Math.hypot(p[j * 2]! - p[i * 2]!, p[j * 2 + 1]! - p[i * 2 + 1]!);
  }
  return s;
}

/** Even-odd point in polygon. */
export function pointInPoly(x: number, y: number, p: ArrayLike<number>): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2]!;
    const yi = p[i * 2 + 1]!;
    const xj = p[j * 2]!;
    const yj = p[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from (x, y) to segment a–b, and the parameter of the nearest point. */
export function segDist(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(x - (ax + dx * t), y - (ay + dy * t)), t };
}

/** Proper or touching intersection of segments p–q and r–s: parameters (t on p–q, u on r–s). */
export function segIntersect(
  px: number,
  py: number,
  qx: number,
  qy: number,
  rx: number,
  ry: number,
  sx: number,
  sy: number,
): [number, number] | null {
  const dx1 = qx - px;
  const dy1 = qy - py;
  const dx2 = sx - rx;
  const dy2 = sy - ry;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((rx - px) * dy2 - (ry - py) * dx2) / den;
  const u = ((rx - px) * dy1 - (ry - py) * dx1) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [t, u];
}

/** Distance from a point to a polyline (flat array), with the tangent angle there. */
export function polylineDist(
  x: number,
  y: number,
  pts: ArrayLike<number>,
): { d: number; angle: number } {
  let best = Infinity;
  let angle = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const r = segDist(x, y, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!);
    if (r.d < best) {
      best = r.d;
      angle = Math.atan2(pts[i + 3]! - pts[i + 1]!, pts[i + 2]! - pts[i]!);
    }
  }
  return { d: best, angle };
}

/**
 * Clips a polygon to the half-plane n·(p − o) ≥ 0 (Sutherland–Hodgman). Each vertex
 * carries a flag for the edge that leaves it; edges along the cut get `cutFlag`.
 */
export function clipHalfPlane(
  p: Poly,
  flags: number[],
  ox: number,
  oy: number,
  nx: number,
  ny: number,
  cutFlag: number,
): { poly: Poly; flags: number[] } {
  const out: Poly = [];
  const of: number[] = [];
  const n = p.length / 2;
  const side = (i: number) => (p[i * 2]! - ox) * nx + (p[i * 2 + 1]! - oy) * ny;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const si = side(i);
    const sj = side(j);
    const inI = si >= 0;
    const inJ = sj >= 0;
    if (inI) {
      out.push(p[i * 2]!, p[i * 2 + 1]!);
      of.push(inJ ? flags[i]! : flags[i]!);
    }
    if (inI !== inJ) {
      const t = si / (si - sj);
      out.push(
        p[i * 2]! + (p[j * 2]! - p[i * 2]!) * t,
        p[i * 2 + 1]! + (p[j * 2 + 1]! - p[i * 2 + 1]!) * t,
      );
      // Leaving the half-plane: the next edge runs along the cut; entering: the rest of edge i.
      of.push(inI ? cutFlag : flags[i]!);
    }
  }
  return { poly: out, flags: of };
}

/** An oriented box: center, unit axis u (length along it), half sizes. */
export interface OBox {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  hu: number;
  hv: number;
}

/** The smallest box over the polygon's edge directions (good enough for blocks and parcels). */
export function minAreaBox(p: Poly): OBox {
  const n = p.length / 2;
  let best: OBox = { cx: 0, cy: 0, ux: 1, uy: 0, hu: 0, hv: 0 };
  let bestArea = Infinity;
  for (let e = 0; e < n; e++) {
    const f = (e + 1) % n;
    let ux = p[f * 2]! - p[e * 2]!;
    let uy = p[f * 2 + 1]! - p[e * 2 + 1]!;
    const l = Math.hypot(ux, uy);
    if (l < 1e-6) continue;
    ux /= l;
    uy /= l;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = p[i * 2]!;
      const y = p[i * 2 + 1]!;
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea) {
      bestArea = area;
      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      best = {
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        ux,
        uy,
        hu: (u1 - u0) / 2,
        hv: (v1 - v0) / 2,
      };
    }
  }
  // Long axis first.
  if (best.hv > best.hu)
    best = { cx: best.cx, cy: best.cy, ux: -best.uy, uy: best.ux, hu: best.hv, hv: best.hu };
  return best;
}

/** The four corners of an oriented rectangle, counterclockwise. */
export function boxCorners(cx: number, cy: number, angle: number, hl: number, hw: number): Poly {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const out: Poly = [];
  for (const [a, b] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    out.push(cx + a * hl * c - b * hw * s, cy + a * hl * s + b * hw * c);
  }
  return out;
}

/** Ramer–Douglas–Peucker on a flat polyline. */
export function simplify(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let wd = tol;
    for (let i = a + 1; i < b; i++) {
      const r = segDist(
        pts[i * 2]!,
        pts[i * 2 + 1]!,
        pts[a * 2]!,
        pts[a * 2 + 1]!,
        pts[b * 2]!,
        pts[b * 2 + 1]!,
      );
      if (r.d > wd) {
        wd = r.d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2]!, pts[i * 2 + 1]!);
  return out;
}

export function polylineLength(pts: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i + 3 < pts.length; i += 2)
    s += Math.hypot(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!);
  return s;
}

/** A uniform grid of buckets over the plane, for proximity queries. */
export class SpatialHash<T> {
  private readonly cells = new Map<number, T[]>();
  constructor(readonly size: number) {}
  private key(ix: number, iy: number): number {
    return (ix + 32768) * 65536 + (iy + 32768);
  }
  add(x: number, y: number, v: T): void {
    const k = this.key(Math.floor(x / this.size), Math.floor(y / this.size));
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push(v);
  }
  /** Adds `v` to every cell a box overlaps. */
  addBox(x0: number, y0: number, x1: number, y1: number, v: T): void {
    const s = this.size;
    for (let ix = Math.floor(x0 / s); ix <= Math.floor(x1 / s); ix++)
      for (let iy = Math.floor(y0 / s); iy <= Math.floor(y1 / s); iy++) {
        const k = this.key(ix, iy);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(v);
      }
  }
  /** Calls `f` for the values in cells within `r` of (x, y); `f` returning true stops. */
  near(x: number, y: number, r: number, f: (v: T) => boolean | void): boolean {
    const s = this.size;
    for (let ix = Math.floor((x - r) / s); ix <= Math.floor((x + r) / s); ix++)
      for (let iy = Math.floor((y - r) / s); iy <= Math.floor((y + r) / s); iy++) {
        const l = this.cells.get(this.key(ix, iy));
        if (l) for (const v of l) if (f(v)) return true;
      }
    return false;
  }
}

/** Smallest angle (0..π/2) between two undirected directions. */
export function lineAngleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Polylines indexed by segment, for nearest-distance queries within a reach. */
export class LineSet {
  private readonly hash: SpatialHash<number>;
  /** ax, ay, bx, by, weight per segment. */
  private readonly segs: number[] = [];
  private readonly line: number[] = [];

  constructor(
    lines: { points: ArrayLike<number>; weight?: number }[],
    readonly cell = 200,
  ) {
    this.hash = new SpatialHash<number>(cell);
    lines.forEach((l, li) => {
      const p = l.points;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const k = this.segs.length / 5;
        this.segs.push(p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!, l.weight ?? 1);
        this.line.push(li);
        this.hash.addBox(
          Math.min(p[i]!, p[i + 2]!),
          Math.min(p[i + 1]!, p[i + 3]!),
          Math.max(p[i]!, p[i + 2]!),
          Math.max(p[i + 1]!, p[i + 3]!),
          k,
        );
      }
    });
  }

  get empty(): boolean {
    return this.segs.length === 0;
  }

  /** Nearest segment within `reach`: distance, tangent angle and weight; d = Infinity if none. */
  nearest(x: number, y: number, reach: number): { d: number; angle: number; weight: number } {
    let best = Infinity;
    let angle = 0;
    let weight = 0;
    const s = this.segs;
    this.hash.near(x, y, reach, (k) => {
      const o = k * 5;
      const r = segDist(x, y, s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!);
      if (r.d < best) {
        best = r.d;
        angle = Math.atan2(s[o + 3]! - s[o + 1]!, s[o + 2]! - s[o]!);
        weight = s[o + 4]!;
      }
    });
    return { d: best, angle, weight };
  }

  /** For each line within `reach`: its nearest distance, angle and weight. */
  perLine(
    x: number,
    y: number,
    reach: number,
    f: (d: number, angle: number, weight: number) => void,
  ): void {
    const best = new Map<number, [number, number, number]>();
    const s = this.segs;
    this.hash.near(x, y, reach, (k) => {
      const o = k * 5;
      const r = segDist(x, y, s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!);
      const li = this.line[k]!;
      const b = best.get(li);
      if (!b || r.d < b[0])
        best.set(li, [r.d, Math.atan2(s[o + 3]! - s[o + 1]!, s[o + 2]! - s[o]!), s[o + 4]!]);
    });
    for (const [d, a, w] of best.values()) if (d <= reach) f(d, a, w);
  }
}

/** Values on a lazy lattice, computed once per lattice point. */
export class Lattice<T> {
  private readonly cells = new Map<number, T>();
  constructor(
    readonly step: number,
    private readonly f: (x: number, y: number) => T,
  ) {}
  at(i: number, j: number): T {
    const k = (i + 100_000) * 200_000 + (j + 100_000);
    let v = this.cells.get(k);
    if (v === undefined) {
      v = this.f(i * this.step, j * this.step);
      this.cells.set(k, v);
    }
    return v;
  }
  /** The value at the nearest lattice point. */
  nearest(x: number, y: number): T {
    return this.at(Math.round(x / this.step), Math.round(y / this.step));
  }
}
