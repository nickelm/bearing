/**
 * From a routed path to an engineered alignment (decision 180; proposal 0005,
 * "Geometry and Profile"): a plan of straights and arcs, a design profile that
 * respects the class's grade, and the earthworks that follow from it.
 *
 * - **Plan** (`fitPlan`). Each corner of the router's lattice path is rounded
 *   with a circular arc of the class's minimum radius, or a tighter one where
 *   the straights either side are too short for it (reported as violations);
 *   the result is resampled every `step` m.
 * - **Profile** (`designProfile`). The ground along the plan, smoothed, is
 *   projected onto the curves whose grade never exceeds the maximum: the mean
 *   of the largest such curve below it and the smallest above it, which keeps
 *   the bound exactly and splits the difference between cut and fill. A moving
 *   average over `verticalCurve` m then rounds crests and sags (an average of
 *   grade-bounded curves stays bounded). The ends are pinned to their anchors'
 *   elevations.
 * - **Earthworks** (`earthworks`). Design minus ground: fill beyond
 *   `viaductFill` becomes a viaduct, cut beyond `tunnelCut` a tunnel, the rest
 *   a corridor of cut and fill (`STRUCTURE`).
 *
 * Plane coordinates in meters, as the router's. Pure and deterministic.
 */

/** What carries the line at a point. */
export const STRUCTURE = { Corridor: 0, Viaduct: 1, Tunnel: 2, Bridge: 3 } as const;
export type Structure = (typeof STRUCTURE)[keyof typeof STRUCTURE];

/** Thresholds of the structure options per class (proposal 0005's table). */
export interface EarthworkLimits {
  /** Fill (m) above which the line goes on a viaduct; Infinity for none. */
  viaductFill: number;
  /** Cut (m) above which it goes into a tunnel; Infinity for none. */
  tunnelCut: number;
}

export const EARTHWORK_LIMITS = {
  mainline: { viaductFill: 12, tunnelCut: 20 },
  mountainRailway: { viaductFill: 12, tunnelCut: 20 },
  motorway: { viaductFill: 15, tunnelCut: 30 },
  trunk: { viaductFill: 15, tunnelCut: 40 },
  secondary: { viaductFill: Infinity, tunnelCut: Infinity },
  mountainRoad: { viaductFill: Infinity, tunnelCut: Infinity },
  track: { viaductFill: Infinity, tunnelCut: Infinity },
} satisfies Record<string, EarthworkLimits>;

export interface Plan {
  /** Points every `step` m (and at both ends). */
  points: [number, number][];
  /** Arc length at each point (m). */
  s: number[];
  /** Corners rounded tighter than the minimum radius: their radius (m). */
  violations: number[];
}

/** Rounds the corners of `path` with arcs of at least `minRadius` where they fit. */
export function fitPlan(
  path: readonly (readonly [number, number])[],
  minRadius: number,
  step: number,
): Plan {
  // Merge collinear runs: corners only where the heading changes.
  const pts: [number, number][] = [[path[0]![0], path[0]![1]]];
  for (let i = 1; i + 1 < path.length; i++) {
    const a = pts[pts.length - 1]!;
    const b = path[i]!;
    const c = path[i + 1]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-6) pts.push([b[0], b[1]]);
  }
  const last = path[path.length - 1]!;
  pts.push([last[0], last[1]]);
  // The dense line: straights and arcs.
  const dense: [number, number][] = [pts[0]!];
  const violations: number[] = [];
  // How much of each straight is already used by the previous corner's tangent.
  let used = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const u1: [number, number] = [(b[0] - a[0]) / l1, (b[1] - a[1]) / l1];
    const u2: [number, number] = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
    const turn = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (turn < 1e-9) continue;
    // Tangent length for the minimum radius; at most what the straights leave.
    const room = Math.min(l1 - used, l2 / 2);
    let radius = minRadius;
    let tangent = radius * Math.tan(turn / 2);
    if (tangent > room) {
      tangent = Math.max(0, room);
      radius = tangent / Math.tan(turn / 2);
      violations.push(radius);
    }
    const t1: [number, number] = [b[0] - u1[0] * tangent, b[1] - u1[1] * tangent];
    dense.push(t1);
    // The arc from t1 to t2 about its center, on the inside of the turn.
    const side = u1[0] * u2[1] - u1[1] * u2[0] > 0 ? 1 : -1;
    const n1: [number, number] = [-u1[1] * side, u1[0] * side];
    const cx = t1[0] + n1[0] * radius;
    const cy = t1[1] + n1[1] * radius;
    const steps = Math.max(1, Math.ceil((radius * turn) / step));
    const a0 = Math.atan2(t1[1] - cy, t1[0] - cx);
    for (let k = 1; k <= steps; k++) {
      const ang = a0 + side * turn * (k / steps);
      dense.push([cx + radius * Math.cos(ang), cy + radius * Math.sin(ang)]);
    }
    used = tangent;
  }
  dense.push(pts[pts.length - 1]!);
  // Resample every `step` m.
  const s0 = [0];
  for (let i = 1; i < dense.length; i++)
    s0.push(
      s0[i - 1]! + Math.hypot(dense[i]![0] - dense[i - 1]![0], dense[i]![1] - dense[i - 1]![1]),
    );
  const total = s0[s0.length - 1]!;
  const n = Math.max(1, Math.ceil(total / step));
  const points: [number, number][] = [];
  const s: number[] = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const sk = (k / n) * total;
    while (j < dense.length - 2 && s0[j + 1]! < sk) j++;
    const span = s0[j + 1]! - s0[j]!;
    const f = span > 0 ? Math.min(1, Math.max(0, (sk - s0[j]!) / span)) : 0;
    points.push([
      dense[j]![0] + (dense[j + 1]![0] - dense[j]![0]) * f,
      dense[j]![1] + (dense[j + 1]![1] - dense[j]![1]) * f,
    ]);
    s.push(sk);
  }
  return { points, s, violations };
}

/**
 * The design elevation along arc lengths `s` over `ground` (see the module
 * comment): grade at most `maxGrade`, ends at `startZ` and `endZ` when given.
 */
export function designProfile(
  ground: readonly number[],
  s: readonly number[],
  maxGrade: number,
  opts: { smooth?: number; verticalCurve?: number; startZ?: number; endZ?: number } = {},
): number[] {
  const n = ground.length;
  // The ground smoothed over `smooth` m: the line follows the terrain's trend, not its texture.
  const target = movingAverage(ground, s, opts.smooth ?? 200);
  if (opts.startZ !== undefined) target[0] = opts.startZ;
  if (opts.endZ !== undefined) target[n - 1] = opts.endZ;
  // Largest grade-bounded curve below the target, and smallest above it.
  const below = target.slice();
  const above = target.slice();
  for (let i = 1; i < n; i++) {
    const d = maxGrade * (s[i]! - s[i - 1]!);
    below[i] = Math.min(below[i]!, below[i - 1]! + d);
    above[i] = Math.max(above[i]!, above[i - 1]! - d);
  }
  for (let i = n - 2; i >= 0; i--) {
    const d = maxGrade * (s[i + 1]! - s[i]!);
    below[i] = Math.min(below[i]!, below[i + 1]! + d);
    above[i] = Math.max(above[i]!, above[i + 1]! - d);
  }
  let z = below.map((b, i) => 0.5 * (b + above[i]!));
  // Vertical curves: a moving average keeps the grade bound.
  z = movingAverage(z, s, opts.verticalCurve ?? 150);
  // Pin the ends, easing the change back under the grade.
  const pin = (i: number, value: number, dir: 1 | -1) => {
    z[i] = value;
    for (let k = i + dir; k >= 0 && k < n; k += dir) {
      const d = maxGrade * Math.abs(s[k]! - s[k - dir]!);
      const lo = z[k - dir]! - d;
      const hi = z[k - dir]! + d;
      if (z[k]! >= lo && z[k]! <= hi) break;
      z[k] = Math.min(hi, Math.max(lo, z[k]!));
    }
  };
  if (opts.startZ !== undefined) pin(0, opts.startZ, 1);
  if (opts.endZ !== undefined) pin(n - 1, opts.endZ, -1);
  return z;
}

/** A centered moving average over `window` m of arc length. */
function movingAverage(v: readonly number[], s: readonly number[], window: number): number[] {
  const n = v.length;
  if (window <= 0 || n < 3) return v.slice();
  const out = new Array<number>(n);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && s[hi]! <= s[i]! + window / 2) sum += v[hi++]!;
    while (s[lo]! < s[i]! - window / 2) sum -= v[lo++]!;
    out[i] = sum / (hi - lo);
  }
  return out;
}

/** The structure carrying the line at each point: viaduct, tunnel or corridor. */
export function earthworks(
  design: readonly number[],
  ground: readonly number[],
  limits: EarthworkLimits,
): Structure[] {
  return design.map((z, i) => {
    const d = z - ground[i]!;
    if (d > limits.viaductFill) return STRUCTURE.Viaduct;
    if (-d > limits.tunnelCut) return STRUCTURE.Tunnel;
    return STRUCTURE.Corridor;
  });
}
