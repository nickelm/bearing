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

/**
 * Rounds the corners of `path` with arcs of at least `minRadius` where they fit,
 * after simplifying it to within `tolerance` m (Douglas–Peucker), so the lattice's
 * small wiggles merge into the bends they make (decision 181).
 */
export function fitPlan(
  path: readonly (readonly [number, number])[],
  minRadius: number,
  step: number,
  tolerance = 0,
): Plan {
  const pts = simplify(path, tolerance);
  // The dense line: straights and arcs.
  const dense: [number, number][] = [pts[0]!];
  const violations: number[] = [];
  // How much of each straight is already used by the previous corner's tangent.
  let used = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const c = roundCorner(pts[i - 1]!, pts[i]!, pts[i + 1]!, minRadius, used, step);
    if (!c) continue;
    dense.push(...c.points);
    if (c.violation !== null) violations.push(c.violation);
    used = c.tangent;
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
 * The arc rounding corner `b` between straights from `a` and to `c`: radius
 * `minRadius` where it fits, else as large as the straights allow (the first
 * less the `used` m the previous corner took, half the second), with its
 * radius as a violation. Points: the tangent point on the first straight, then
 * the arc every `step` m; null for no turn.
 */
export function roundCorner(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  minRadius: number,
  used: number,
  step: number,
): { points: [number, number][]; tangent: number; violation: number | null } | null {
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
  if (l1 <= 0 || l2 <= 0) return null;
  const u1: [number, number] = [(b[0] - a[0]) / l1, (b[1] - a[1]) / l1];
  const u2: [number, number] = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
  const turn = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
  if (turn < 1e-9) return null;
  // Tangent length for the minimum radius; at most what the straights leave.
  const room = Math.min(l1 - used, l2 / 2);
  let radius = minRadius;
  let tangent = radius * Math.tan(turn / 2);
  let violation: number | null = null;
  if (tangent > room) {
    tangent = Math.max(0, room);
    radius = tangent / Math.tan(turn / 2);
    violation = radius;
  }
  const t1: [number, number] = [b[0] - u1[0] * tangent, b[1] - u1[1] * tangent];
  const points: [number, number][] = [t1];
  // The arc from t1 to t2 about its center, on the inside of the turn.
  const side = u1[0] * u2[1] - u1[1] * u2[0] > 0 ? 1 : -1;
  const n1: [number, number] = [-u1[1] * side, u1[0] * side];
  const cx = t1[0] + n1[0] * radius;
  const cy = t1[1] + n1[1] * radius;
  const steps = Math.max(1, Math.ceil((radius * turn) / step));
  const a0 = Math.atan2(t1[1] - cy, t1[0] - cx);
  for (let k = 1; k <= steps; k++) {
    const ang = a0 + side * turn * (k / steps);
    points.push([cx + radius * Math.cos(ang), cy + radius * Math.sin(ang)]);
  }
  return { points, tangent, violation };
}

/** Douglas–Peucker simplification to within `tol` m, keeping both ends; collinear points go at 0. */
export function simplify(
  path: readonly (readonly [number, number])[],
  tol: number,
): [number, number][] {
  const n = path.length;
  if (n <= 2) return path.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = path[a]!;
    const [bx, by] = path[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy);
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = path[i]!;
      const d =
        L > 0 ? Math.abs((px - ax) * dy - (py - ay) * dx) / L : Math.hypot(px - ax, py - ay);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > Math.max(tol, 1e-6)) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([path[i]![0], path[i]![1]]);
  return out;
}

/**
 * The design elevation along arc lengths `s` over `ground` (see the module
 * comment): grade at most `maxGrade` (one bound, or one per point, where a link
 * changes class), ends at `startZ` and `endZ` when given.
 */
export function designProfile(
  ground: readonly number[],
  s: readonly number[],
  maxGrade: number | ArrayLike<number>,
  opts: { smooth?: number; verticalCurve?: number; startZ?: number; endZ?: number } = {},
): number[] {
  const n = ground.length;
  // The grade bound between points i − 1 and i: per point, the stricter of the two.
  const G =
    typeof maxGrade === 'number'
      ? () => maxGrade
      : (i: number) => Math.min(maxGrade[i]!, maxGrade[i - 1]!);
  // The ground smoothed over `smooth` m: the line follows the terrain's trend, not its texture.
  const target = movingAverage(ground, s, opts.smooth ?? 200);
  if (opts.startZ !== undefined) target[0] = opts.startZ;
  if (opts.endZ !== undefined) target[n - 1] = opts.endZ;
  // Largest grade-bounded curve below the target, and smallest above it.
  const below = target.slice();
  const above = target.slice();
  for (let i = 1; i < n; i++) {
    const d = G(i) * (s[i]! - s[i - 1]!);
    below[i] = Math.min(below[i]!, below[i - 1]! + d);
    above[i] = Math.max(above[i]!, above[i - 1]! - d);
  }
  for (let i = n - 2; i >= 0; i--) {
    const d = G(i + 1) * (s[i + 1]! - s[i]!);
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
      const d = G(Math.max(k, k - dir)) * Math.abs(s[k]! - s[k - dir]!);
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
