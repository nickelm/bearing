/**
 * The router of the alignment tier (decision 180; proposal 0005, "Routing"):
 * one A* search for roads and railways, with parameters per class.
 *
 * - **Lattice.** Square, `spacing` m, on a local plane in meters. The state
 *   is a node and the heading it was entered by, so curvature can be charged;
 *   moves go to the 16 neighbors of Galin et al.'s k = 2 neighborhood (the
 *   axes, diagonals and knight's moves), so paths are not held to 45° angles.
 * - **Grade** along the move: free up to a quarter of the class's maximum,
 *   rising as the square of grade over maximum beyond, and forbidden above
 *   the maximum. On a face steeper than the maximum the cheapest way up is a
 *   zigzag: switchbacks emerge rather than being drawn.
 * - **Curvature.** The state also counts the straight moves since the last
 *   turn (up to RUNS − 1), since with 16 headings the least turn is about 18°
 *   and a wide curve is straight runs with turns between them. A turn implies
 *   a radius, the run before it over twice the tangent of half the turn;
 *   turns tighter than the class's minimum radius are forbidden, others cost
 *   their angle squared.
 * - **Earthworks.** The ground's departure at the move's midpoint from the
 *   straight grade between its ends, as an estimate of cut and fill.
 * - **Extra costs** (river crossings, attractors) come from the caller, as
 *   does the search's region (a band around the network's link).
 *
 * Pure and deterministic: ties break by state index.
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

/** Straight-run lengths counted in the state: 0 .. RUNS − 1 moves since the last turn. */
const RUNS = 6;
const ANGLE = MOVES.map(([x, y]) => Math.atan2(y, x));
const LENGTH = MOVES.map(([x, y]) => Math.hypot(x, y));
const NONE = MOVES.length;

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
    h[i] = p.height(X(i), Y(i));
    ok[i] = !p.allowed || p.allowed(X(i), Y(i)) ? 1 : 0;
  }
  const start = snap(p.start);
  const goal = snap(p.goal);
  ok[start] = 1;
  ok[goal] = 1;
  const K = (NONE + 1) * RUNS;
  // float32 costs: a meter's resolution over tens of kilometers is plenty, at half the memory.
  const g = new Float32Array(nodes * K).fill(Infinity);
  const from = new Int32Array(nodes * K).fill(-1);
  const closed = new Uint8Array(nodes * K);
  const gx = X(goal);
  const gy = Y(goal);
  const heur = (i: number) => Math.hypot(X(i) - gx, Y(i) - gy);
  const heap = new MinHeap();
  const s0 = start * K + NONE * RUNS;
  g[s0] = 0;
  heap.push(heur(start), s0);
  const budget = p.maxExpansions ?? 4_000_000;
  let expansions = 0;
  let found = -1;
  const free = cls.maxGrade / 4;
  while (heap.size > 0) {
    const st = heap.pop();
    if (closed[st]) continue;
    closed[st] = 1;
    const node = Math.floor(st / K);
    const rest = st - node * K;
    const dIn = Math.floor(rest / RUNS);
    const run = rest - dIn * RUNS;
    if (node === goal) {
      found = st;
      break;
    }
    if (++expansions > budget) break;
    const ix = node % nx;
    const iy = Math.floor(node / nx);
    const x0 = X(node);
    const y0 = Y(node);
    for (let m = 0; m < MOVES.length; m++) {
      const jx = ix + MOVES[m]![0];
      const jy = iy + MOVES[m]![1];
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      const next = jy * nx + jx;
      if (!ok[next]) continue;
      const L = LENGTH[m]! * s;
      const grade = Math.abs(h[next]! - h[node]!) / L;
      if (grade > cls.maxGrade) continue;
      let turn = 0;
      let nextRun = 0;
      if (dIn !== NONE) {
        if (m === dIn) nextRun = Math.min(RUNS - 1, run + 1);
        else {
          turn = Math.abs(ANGLE[m]! - ANGLE[dIn]!);
          if (turn > Math.PI) turn = 2 * Math.PI - turn;
          // The arc that rounds this corner: the straight run before it, over twice the
          // tangent of half the turn.
          const straight = (run + 1) * LENGTH[dIn]! * s;
          if (turn >= Math.PI - 1e-9 || straight / (2 * Math.tan(turn / 2)) < cls.minRadius)
            continue;
        }
      }
      const r = Math.max(0, grade - free) / (cls.maxGrade - free);
      const x1 = X(next);
      const y1 = Y(next);
      const mid = p.height(0.5 * (x0 + x1), 0.5 * (y0 + y1));
      const earth = Math.abs(mid - 0.5 * (h[node]! + h[next]!));
      let cost =
        L * (1 + cls.gradeWeight * r * r) +
        cls.curveWeight * turn * turn * s +
        cls.earthWeight * earth * L;
      if (p.extra) cost += p.extra(x0, y0, x1, y1);
      const ns = next * K + m * RUNS + nextRun;
      const ng = Math.fround(g[st]! + cost);
      if (ng < g[ns]!) {
        g[ns] = ng;
        from[ns] = st;
        heap.push(ng + heur(next), ns);
      }
    }
  }
  if (found < 0) return null;
  const path: [number, number][] = [];
  for (let st = found; st >= 0; st = from[st]!) {
    const node = Math.floor(st / K);
    path.push([X(node), Y(node)]);
  }
  path.reverse();
  return { path, cost: g[found]!, expansions };
}
