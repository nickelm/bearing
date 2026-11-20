/**
 * Blocks (proposal 0009, decision 263): the bounded faces of the street graph, inset
 * from each street's center line by its half-width plus a sidewalk, so a block is the
 * land between curbs. Faces too small, too large (rural gaps between arterials) or
 * too thin to inset cleanly are dropped and counted.
 */
import { pointInPoly, polyArea } from './geom';
import type { Poly } from './geom';
import type { Face } from './graph';
import { STREET_HALF_WIDTH } from './types';

export const SIDEWALK_WIDTH = 2.5;
export const MIN_BLOCK_AREA = 500;
export const MAX_BLOCK_AREA = 250_000;

/**
 * Insets polygon `p` (counterclockwise) by a distance per edge (edge i leaves vertex i):
 * offset lines intersected at each vertex, miters capped. Null if the result is not a
 * simple shrink of the polygon.
 */
export function insetPolygon(p: Poly, dist: number[]): Poly | null {
  const n = p.length / 2;
  if (n < 3) return null;
  // Offset line of each edge: a point and its direction.
  const lines: [number, number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let dx = p[j * 2]! - p[i * 2]!;
    let dy = p[j * 2 + 1]! - p[i * 2 + 1]!;
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) {
      dx = 1;
      dy = 0;
    } else {
      dx /= l;
      dy /= l;
    }
    // Left normal points inside a counterclockwise polygon.
    const d = dist[i]!;
    lines.push([p[i * 2]! - dy * d, p[i * 2 + 1]! + dx * d, dx, dy]);
  }
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n]!;
    const b = lines[i]!;
    const den = a[2] * b[3] - a[3] * b[2];
    let x: number;
    let y: number;
    if (Math.abs(den) < 0.05) {
      // Nearly straight: the offset point of edge i's start.
      x = b[0];
      y = b[1];
    } else {
      const t = ((b[0] - a[0]) * b[3] - (b[1] - a[1]) * b[2]) / den;
      x = a[0] + a[2] * t;
      y = a[1] + a[3] * t;
      // Cap the miter at three times the larger offset.
      const vx = p[i * 2]!;
      const vy = p[i * 2 + 1]!;
      const m = Math.hypot(x - vx, y - vy);
      const cap = 3 * Math.max(dist[i]!, dist[(i - 1 + n) % n]!);
      if (m > cap) {
        x = vx + ((x - vx) * cap) / m;
        y = vy + ((y - vy) * cap) / m;
      }
    }
    out.push(x, y);
  }
  const a = polyArea(out);
  if (!(a > 0) || a >= polyArea(p)) return null;
  for (let i = 0; i < n; i++) if (!pointInPoly(out[i * 2]!, out[i * 2 + 1]!, p)) return null;
  // Self-crossing: any two non-adjacent edges crossing.
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (crosses(out, i, j)) return null;
    }
  }
  return out;
}

function crosses(p: Poly, i: number, j: number): boolean {
  const n = p.length / 2;
  const ax = p[i * 2]!;
  const ay = p[i * 2 + 1]!;
  const bx = p[((i + 1) % n) * 2]!;
  const by = p[((i + 1) % n) * 2 + 1]!;
  const cx = p[j * 2]!;
  const cy = p[j * 2 + 1]!;
  const dx = p[((j + 1) % n) * 2]!;
  const dy = p[((j + 1) % n) * 2 + 1]!;
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return (
    o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 &&
    o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0
  );
}

/** Drops vertices closer than `eps` to the previous one. */
export function dedupe(p: Poly, kinds: number[], eps = 0.5): { p: Poly; kinds: number[] } {
  const op: Poly = [];
  const ok: number[] = [];
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const x = p[i * 2]!;
    const y = p[i * 2 + 1]!;
    const m = op.length;
    if (m && Math.hypot(op[m - 2]! - x, op[m - 1]! - y) < eps) continue;
    op.push(x, y);
    ok.push(kinds[i]!);
  }
  const m = op.length;
  if (m >= 4 && Math.hypot(op[0]! - op[m - 2]!, op[1]! - op[m - 1]!) < eps) {
    op.splice(m - 2, 2);
    ok.pop();
  }
  // Drop vertices where a street runs straight on (same class, under about 3°), so an
  // inset corner never folds back past a vertex just beside it.
  for (let changed = true; changed && op.length > 6;) {
    changed = false;
    const n = op.length / 2;
    for (let i = 0; i < n; i++) {
      const h = (i - 1 + n) % n;
      const j = (i + 1) % n;
      if (ok[h] !== ok[i]) continue;
      const ax = op[i * 2]! - op[h * 2]!;
      const ay = op[i * 2 + 1]! - op[h * 2 + 1]!;
      const bx = op[j * 2]! - op[i * 2]!;
      const by = op[j * 2 + 1]! - op[i * 2 + 1]!;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (ax * bx + ay * by > 0 && Math.abs(ax * by - ay * bx) < 0.05 * la * lb) {
        op.splice(i * 2, 2);
        ok.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return { p: op, kinds: ok };
}

/** Blocks between curbs from the graph's faces; `dropped` counts the faces left out. */
export function blocksFromFaces(fs: Face[]): { polygons: Poly[]; dropped: number } {
  const polygons: Poly[] = [];
  let dropped = 0;
  for (const f of fs) {
    const area = polyArea(f.polygon);
    if (area < MIN_BLOCK_AREA || area > MAX_BLOCK_AREA) {
      dropped++;
      continue;
    }
    const { p, kinds } = dedupe(f.polygon, f.kinds);
    if (p.length < 6) {
      dropped++;
      continue;
    }
    const inset = insetPolygon(
      p,
      kinds.map((k) => (STREET_HALF_WIDTH[k] ?? 4) + SIDEWALK_WIDTH),
    );
    if (!inset || polyArea(inset) < MIN_BLOCK_AREA * 0.5) {
      dropped++;
      continue;
    }
    polygons.push(inset);
  }
  return { polygons, dropped };
}
