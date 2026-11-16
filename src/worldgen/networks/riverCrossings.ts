/**
 * Rivers in the alignment tier (decision 190): the rendered rivers' segments
 * under a task's tiles, sent to its worker, projected into each piece's plane
 * for the router, and the crossings a link makes, from which its bridges come.
 *
 * - **Cost.** A move that crosses a river pays a bridge: `base` plus
 *   `perMeter` × the span, which is the river's width over the sine of the
 *   crossing angle (at most four widths) plus the abutments. Square crossings
 *   of narrow reaches are cheapest, so roads seek them out; a road never runs
 *   along inside a channel (nodes there cost as much as open water).
 * - **Records.** After a link is assembled, each crossing its routed pieces
 *   made is found again on the final plan: where, at what angle, how wide, and
 *   the deck's elevation, the water surface plus a clearance by class or the
 *   banks' height, whichever is higher.
 */
import { Vec3d } from '../../core/vec3d';
import type { TileKey } from '../../core/tiles';
import type { RiverIndex } from '../riverIndex';
import { NO_SURFACE, RIVER_SEGMENT_FIELDS } from '../riverIndex';
import type { gnomonic } from './pieces';

/** Values per river segment sent to a worker: a.xyz, b.xyz, widthA, widthB, surfaceA, surfaceB. */
export const TASK_RIVER_FIELDS = 10;

export interface TaskRivers {
  /** River index segment ids. */
  ids: Int32Array;
  data: Float64Array;
}

export const CROSSING_TUNING = {
  /** Cost of any bridge (as meters of road), and per meter of span. */
  base: 400,
  perMeter: 30,
  /** Span beyond the water: abutments either side (m). */
  abutments: 10,
  /** The span counted for an oblique crossing is at most this many widths. */
  maxSkew: 4,
  /** Bucket size of the plane index (m). */
  cell: 250,
  /** Height of the deck over the water by class (m). */
  clearance: {
    mainline: 6,
    mountainRailway: 6,
    motorway: 5.5,
    trunk: 5,
    secondary: 4.5,
    mountainRoad: 3.5,
    track: 2.5,
  },
};

/** The river segments within reach of `keys` (level-6 tiles), for a task's worker. */
export function taskRivers(
  index: RiverIndex,
  keys: readonly TileKey[],
  radius: number,
): TaskRivers {
  const ids = new Set<number>();
  for (const k of keys) for (const s of index.forTile(k, 500, radius)) ids.add(s);
  const sorted = Int32Array.from([...ids].sort((a, b) => a - b));
  const data = new Float64Array(sorted.length * TASK_RIVER_FIELDS);
  const src = index.segments.data;
  sorted.forEach((s, i) => {
    for (let f = 0; f < TASK_RIVER_FIELDS; f++)
      data[i * TASK_RIVER_FIELDS + f] = src[s * RIVER_SEGMENT_FIELDS + f]!;
  });
  return { ids: sorted, data };
}

export interface PlaneCrossing {
  /** Index into the task's rivers. */
  river: number;
  /** Where along the move (0..1) and along the river segment (0..1). */
  t: number;
  u: number;
  /** River width there (m) and |sin| of the crossing angle. */
  width: number;
  sin: number;
  /** The span a bridge needs (m). */
  span: number;
}

/** A task's rivers in one piece's gnomonic plane, bucketed for the router. */
export class PlaneRivers {
  private readonly ax: Float64Array;
  private readonly ay: Float64Array;
  private readonly bx: Float64Array;
  private readonly by: Float64Array;
  private readonly buckets = new Map<number, number[]>();

  constructor(
    readonly rivers: TaskRivers,
    frame: ReturnType<typeof gnomonic>,
    center: Readonly<Vec3d>,
    reachM: number,
    radius: number,
  ) {
    const n = rivers.ids.length;
    this.ax = new Float64Array(n);
    this.ay = new Float64Array(n);
    this.bx = new Float64Array(n);
    this.by = new Float64Array(n);
    const d = rivers.data;
    const a = new Vec3d();
    const b = new Vec3d();
    const near = Math.cos(reachM / radius);
    const C = CROSSING_TUNING.cell;
    for (let i = 0; i < n; i++) {
      const o = i * TASK_RIVER_FIELDS;
      a.set(d[o]!, d[o + 1]!, d[o + 2]!);
      b.set(d[o + 3]!, d[o + 4]!, d[o + 5]!);
      if (a.dot(center) < near && b.dot(center) < near) continue;
      [this.ax[i], this.ay[i]] = frame.toPlane(a);
      [this.bx[i], this.by[i]] = frame.toPlane(b);
      const w = 0.5 * Math.max(d[o + 6]!, d[o + 7]!) + C;
      const x0 = Math.floor((Math.min(this.ax[i]!, this.bx[i]!) - w) / C);
      const x1 = Math.floor((Math.max(this.ax[i]!, this.bx[i]!) + w) / C);
      const y0 = Math.floor((Math.min(this.ay[i]!, this.by[i]!) - w) / C);
      const y1 = Math.floor((Math.max(this.ay[i]!, this.by[i]!) + w) / C);
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const key = x * 73856093 + y * 19349663;
          let l = this.buckets.get(key);
          if (!l) this.buckets.set(key, (l = []));
          l.push(i);
        }
    }
  }

  private cellOf(x: number, y: number): number[] | undefined {
    const C = CROSSING_TUNING.cell;
    return this.buckets.get(Math.floor(x / C) * 73856093 + Math.floor(y / C) * 19349663);
  }

  get empty(): boolean {
    return this.buckets.size === 0;
  }

  /** Whether (x, y) lies in a channel. */
  inside(x: number, y: number): boolean {
    const l = this.cellOf(x, y);
    if (!l) return false;
    const d = this.rivers.data;
    for (const i of l) {
      const ex = this.bx[i]! - this.ax[i]!;
      const ey = this.by[i]! - this.ay[i]!;
      const L2 = ex * ex + ey * ey;
      const u =
        L2 > 0
          ? Math.min(1, Math.max(0, ((x - this.ax[i]!) * ex + (y - this.ay[i]!) * ey) / L2))
          : 0;
      const w =
        d[i * TASK_RIVER_FIELDS + 6]! +
        (d[i * TASK_RIVER_FIELDS + 7]! - d[i * TASK_RIVER_FIELDS + 6]!) * u;
      if (Math.hypot(x - this.ax[i]! - u * ex, y - this.ay[i]! - u * ey) < 0.5 * w) return true;
    }
    return false;
  }

  /** The first river the move from (x0, y0) to (x1, y1) crosses, or null. */
  crossing(x0: number, y0: number, x1: number, y1: number): PlaneCrossing | null {
    const l0 = this.cellOf(x0, y0);
    const l1 = this.cellOf(x1, y1);
    if (!l0 && !l1) return null;
    let best: PlaneCrossing | null = null;
    const mx = x1 - x0;
    const my = y1 - y0;
    const d = this.rivers.data;
    for (const list of l0 === l1 ? [l0] : [l0, l1]) {
      if (!list) continue;
      for (const i of list) {
        const ex = this.bx[i]! - this.ax[i]!;
        const ey = this.by[i]! - this.ay[i]!;
        const den = mx * ey - my * ex;
        if (den === 0) continue;
        const qx = this.ax[i]! - x0;
        const qy = this.ay[i]! - y0;
        const t = (qx * ey - qy * ex) / den;
        const u = (qx * my - qy * mx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        if (best && t >= best.t) continue;
        const o = i * TASK_RIVER_FIELDS;
        const width = d[o + 6]! + (d[o + 7]! - d[o + 6]!) * u;
        const sin = Math.abs(den) / (Math.hypot(mx, my) * Math.hypot(ex, ey));
        best = { river: i, t, u, width, sin, span: spanOf(width, sin) };
      }
    }
    return best;
  }
}

/** The span a bridge needs over a river `width` m wide crossed at |sin| `sin` (m). */
export function spanOf(width: number, sin: number): number {
  const T = CROSSING_TUNING;
  return width / Math.max(sin, 1 / T.maxSkew) + 2 * T.abutments;
}

/** The cost of crossing (as meters of road). */
export function crossingCost(c: PlaneCrossing): number {
  return CROSSING_TUNING.base + CROSSING_TUNING.perMeter * c.span;
}

/** The water surface of task river `i` at `u` along it (m), or null where it has none. */
export function riverSurface(rivers: TaskRivers, i: number, u: number): number | null {
  const o = i * TASK_RIVER_FIELDS;
  const a = rivers.data[o + 8]!;
  const b = rivers.data[o + 9]!;
  if (a >= NO_SURFACE || b >= NO_SURFACE) return null;
  return a + (b - a) * u;
}
