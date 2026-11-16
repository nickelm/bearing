/**
 * The router of the alignment tier (decisions 180, 181; proposal 0005,
 * "Routing"): one A* search for roads and railways, with parameters per class.
 *
 * - **Lattice.** Square, `spacing` m, on a local plane in meters; moves go to
 *   the 16 neighbors of Galin et al.'s k = 2 neighborhood (the axes, diagonals
 *   and knight's moves), so paths are not held to 45° angles. The state is the
 *   node alone (decision 181: a state per heading and straight run cost a
 *   hundred times the expansions on a real world's ground); each node keeps
 *   the heading of its best parent, against which turns are charged, as in
 *   Galin et al.
 * - **Grade** along the move: free up to a quarter of the class's maximum,
 *   then (grade over maximum)² × `gradeWeight`; above the maximum the ground
 *   must be cut or filled, costing `steepWeight` × the excess squared, and
 *   above `maxOver` × the maximum a move is forbidden. On a face steeper than
 *   the maximum the cheapest way up is a zigzag: switchbacks emerge.
 * - **Curvature.** A turn costs its angle² × `curveWeight`; turns sharper than
 *   90° are forbidden unless the class's minimum radius is under the lattice
 *   spacing (hairpins). The radius itself is the plan's business (`fitPlan`).
 * - **Earthworks.** The ground's departure at the move's midpoint from the
 *   straight grade between its ends, as an estimate of cut and fill.
 * - **Extra costs** (river crossings, attractors) come from the caller, as
 *   does the search's region (a band around the network's link).
 *
 * Pure and deterministic: ties break by node index.
 */
import { MinHeap } from '../../core/heap';

/** Design parameters of a road or railway class (proposal 0005's table, to be tuned). */
export interface RouteClass {
  name: string;
  /** Steepest grade (m/m). */
  maxGrade: number;
  /** Tightest curve radius (m). */
  minRadius: number;
  /** Cost multiplier of a move at the maximum grade, beyond its length. */
  gradeWeight: number;
  /** Cost per radian² of turn, in lattice spacings. */
  curveWeight: number;
  /** Cost per meter of the ground's departure from the move's straight grade, per meter of move. */
  earthWeight: number;
}

export const ROUTE_CLASSES = {
  mainline: {
    name: 'mainline railway',
    maxGrade: 0.02,
    minRadius: 500,
    gradeWeight: 4,
    curveWeight: 2,
    earthWeight: 0.15,
  },
  mountainRailway: {
    name: 'mountain railway',
    maxGrade: 0.04,
    minRadius: 250,
    gradeWeight: 4,
    curveWeight: 1.5,
    earthWeight: 0.12,
  },
  motorway: {
    name: 'motorway',
    maxGrade: 0.05,
    minRadius: 700,
    gradeWeight: 3,
    curveWeight: 2,
    earthWeight: 0.06,
  },
  trunk: {
    name: 'trunk road',
    maxGrade: 0.07,
    minRadius: 300,
    gradeWeight: 3,
    curveWeight: 1,
    earthWeight: 0.08,
  },
  secondary: {
    name: 'secondary road',
    maxGrade: 0.1,
    minRadius: 100,
    gradeWeight: 2,
    curveWeight: 0.5,
    earthWeight: 0.15,
  },
  mountainRoad: {
    name: 'mountain road',
    maxGrade: 0.14,
    minRadius: 12,
    gradeWeight: 2,
    curveWeight: 0.2,
    earthWeight: 0.2,
  },
  track: {
    name: 'track',
    maxGrade: 0.2,
    minRadius: 8,
    gradeWeight: 1.5,
    curveWeight: 0.1,
    earthWeight: 0.3,
  },
} satisfies Record<string, RouteClass>;

export interface RouteProblem {
  /** Ground height (m) at plane coordinates (m). */
  height: (x: number, y: number) => number;
  start: readonly [number, number];
  goal: readonly [number, number];
  /** Lattice spacing (m). */
  spacing: number;
  /** The lattice covers this box (m); start and goal snap to its nodes. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
  cls: RouteClass;
  /** Whether a node may be used (the band around the link); all by default. */
  allowed?: (x: number, y: number) => boolean;
  /** Extra cost of a move (river crossings, attractors); none by default. */
  extra?: (x0: number, y0: number, x1: number, y1: number) => number;
  /** Search budget in state expansions; the search gives up beyond it. */
  maxExpansions?: number;
}

export interface Route {
  /** Plane coordinates of the path's nodes, start to goal. */
  path: [number, number][];
  cost: number;
  expansions: number;
}

/** The 16 moves of the k = 2 neighborhood, counterclockwise from +x. */
export const MOVES: readonly (readonly [number, number])[] = (() => {
  const m: [number, number][] = [];
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -2; dy <= 2; dy++) {
      if (dx === 0 && dy === 0) continue;
      // Primitive moves only: no move that is a multiple of a shorter one.
      const g = gcd(Math.abs(dx), Math.abs(dy));
      if (g !== 1) continue;
      m.push([dx, dy]);
    }
  return m.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
})();

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

const ANGLE = MOVES.map(([x, y]) => Math.atan2(y, x));
const LENGTH = MOVES.map(([x, y]) => Math.hypot(x, y));

/** Cost of cut and fill per (excess grade over maximum)², and the largest ground grade taken. */
export const STEEP_WEIGHT = 30;
export const MAX_OVER = 3;

/** The cheapest path from start to goal, or null if there is none within the budget. */
export function route(p: RouteProblem): Route | null {
  const { spacing: s, bounds: b, cls } = p;
  const nx = Math.max(2, Math.round((b.x1 - b.x0) / s) + 1);
  const ny = Math.max(2, Math.round((b.y1 - b.y0) / s) + 1);
  const nodes = nx * ny;
  const X = (i: number) => b.x0 + (i % nx) * s;
  const Y = (i: number) => b.y0 + Math.floor(i / nx) * s;
  const snap = (q: readonly [number, number]) => {
    const ix = Math.min(nx - 1, Math.max(0, Math.round((q[0] - b.x0) / s)));
    const iy = Math.min(ny - 1, Math.max(0, Math.round((q[1] - b.y0) / s)));
    return iy * nx + ix;
  };
  const h = new Float32Array(nodes);
  const ok = new Uint8Array(nodes);
  for (let i = 0; i < nodes; i++) {
    ok[i] = !p.allowed || p.allowed(X(i), Y(i)) ? 1 : 0;
    h[i] = ok[i] ? p.height(X(i), Y(i)) : 0;
  }
  const start = snap(p.start);
  const goal = snap(p.goal);
  if (!ok[start]) h[start] = p.height(X(start), Y(start));
  if (!ok[goal]) h[goal] = p.height(X(goal), Y(goal));
  ok[start] = 1;
  ok[goal] = 1;
  const g = new Float32Array(nodes).fill(Infinity);
  const from = new Int32Array(nodes).fill(-1);
  const dirIn = new Int8Array(nodes).fill(-1);
  const closed = new Uint8Array(nodes);
  const gx = X(goal);
  const gy = Y(goal);
  const heur = (i: number) => Math.hypot(X(i) - gx, Y(i) - gy);
  const heap = new MinHeap();
  g[start] = 0;
  heap.push(heur(start), start);
  const budget = p.maxExpansions ?? 4_000_000;
  const hairpins = cls.minRadius < s;
  const maxTurn = hairpins ? (3 * Math.PI) / 4 + 1e-6 : Math.PI / 2 + 1e-6;
  let expansions = 0;
  const free = cls.maxGrade / 4;
  while (heap.size > 0) {
    const node = heap.pop();
    if (closed[node]) continue;
    closed[node] = 1;
    if (node === goal) break;
    if (++expansions > budget) return null;
    const ix = node % nx;
    const iy = Math.floor(node / nx);
    const x0 = X(node);
    const y0 = Y(node);
    const dIn = dirIn[node]!;
    for (let m = 0; m < MOVES.length; m++) {
      const jx = ix + MOVES[m]![0];
      const jy = iy + MOVES[m]![1];
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      const next = jy * nx + jx;
      if (!ok[next] || closed[next]) continue;
      const L = LENGTH[m]! * s;
      const grade = Math.abs(h[next]! - h[node]!) / L;
      const r = grade / cls.maxGrade;
      if (r > MAX_OVER) continue;
      let turn = 0;
      if (dIn >= 0) {
        turn = Math.abs(ANGLE[m]! - ANGLE[dIn]!);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn > maxTurn) continue;
      }
      const q = Math.max(0, grade - free) / (cls.maxGrade - free);
      const x1 = X(next);
      const y1 = Y(next);
      const mid = p.height(0.5 * (x0 + x1), 0.5 * (y0 + y1));
      const earth = Math.abs(mid - 0.5 * (h[node]! + h[next]!));
      let cost =
        L * (1 + cls.gradeWeight * Math.min(q, 1) ** 2 + STEEP_WEIGHT * Math.max(0, r - 1) ** 2) +
        cls.curveWeight * turn * turn * s +
        cls.earthWeight * earth * L;
      if (p.extra) cost += p.extra(x0, y0, x1, y1);
      const ng = Math.fround(g[node]! + cost);
      if (ng < g[next]!) {
        g[next] = ng;
        from[next] = node;
        dirIn[next] = m;
        heap.push(ng + heur(next), next);
      }
    }
  }
  if (!closed[goal]) return null;
  const path: [number, number][] = [];
  for (let n = goal; n >= 0; n = from[n]!) path.push([X(n), Y(n)]);
  path.reverse();
  return { path, cost: g[goal]!, expansions };
}
