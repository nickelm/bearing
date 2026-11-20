/**
 * Organic old cores (proposal 0009, decision 262), in the spirit of Watabou's Medieval
 * Fantasy City Generator: wards are the cells of a relaxed Voronoi diagram inside the
 * core's radius, their edges the lanes, a ring round the core where the traced streets
 * meet it, and the center cell the market square. A quarter of the inner ward edges
 * are left out, so blocks merge into irregular shapes.
 */
import type { Rng } from '../../core/rng';
import { clipHalfPlane, polyCentroid } from './geom';
import type { Poly } from './geom';

export interface OldCore {
  radius: number;
  /** Lanes between wards, and the ring (closed: last point repeats the first). */
  lanes: number[][];
  ring: number[];
  /** The market square's polygon. */
  square: Poly;
}

const RING_SIDES = 28;

function ringPolygon(r: number, wobble: number[]): Poly {
  const p: Poly = [];
  for (let k = 0; k < RING_SIDES; k++) {
    const a = (k / RING_SIDES) * 2 * Math.PI;
    const rr = r * (1 + wobble[k]!);
    p.push(rr * Math.cos(a), rr * Math.sin(a));
  }
  return p;
}

function voronoiCells(points: number[][], boundary: Poly): Poly[] {
  return points.map(([x, y], i) => {
    let poly = boundary.slice();
    let flags = poly.map(() => 0).slice(0, poly.length / 2);
    for (let j = 0; j < points.length && poly.length >= 6; j++) {
      if (j === i) continue;
      const [qx, qy] = points[j]!;
      // Keep the side nearer point i: n = p_i − p_j through the midpoint.
      const r = clipHalfPlane(poly, flags, (x! + qx!) / 2, (y! + qy!) / 2, x! - qx!, y! - qy!, 1);
      poly = r.poly;
      flags = r.flags;
    }
    return poly;
  });
}

export function oldCore(
  radius: number,
  wards: number,
  water: (x: number, y: number) => boolean,
  r: Rng,
): OldCore {
  const wobble = Array.from({ length: RING_SIDES }, () => (r.nextFloat() - 0.5) * 0.12);
  const boundary = ringPolygon(radius, wobble);
  // Ward seeds: the market square at the center, the rest by dart throwing.
  const pts: number[][] = [[0, 0]];
  const minD = radius * Math.sqrt(2.2 / wards);
  for (let tries = 0; tries < wards * 40 && pts.length < wards; tries++) {
    const a = r.nextFloat() * 2 * Math.PI;
    const d = radius * 0.95 * Math.sqrt(r.nextFloat());
    const x = d * Math.cos(a);
    const y = d * Math.sin(a);
    if (water(x, y)) continue;
    if (pts.some(([px, py]) => (px! - x) ** 2 + (py! - y) ** 2 < minD * minD)) continue;
    pts.push([x, y]);
  }
  // Two rounds of Lloyd relaxation, the square's seed kept at the center.
  let cells = voronoiCells(pts, boundary);
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i < pts.length; i++) {
      if (cells[i]!.length >= 6) pts[i] = polyCentroid(cells[i]!);
    }
    cells = voronoiCells(pts, boundary);
  }
  // Lanes: each inner edge once, a quarter left out (never the square's own).
  const lanes: number[][] = [];
  const seen = new Set<string>();
  const key = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
  cells.forEach((cell, i) => {
    const n = cell.length / 2;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const ax = cell[k * 2]!;
      const ay = cell[k * 2 + 1]!;
      const bx = cell[j * 2]!;
      const by = cell[j * 2 + 1]!;
      const ka = key(ax, ay);
      const kb = key(bx, by);
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(id)) continue;
      seen.add(id);
      // On the ring: the ring street covers it.
      if (Math.hypot(ax, ay) > radius * 0.85 && Math.hypot(bx, by) > radius * 0.85) {
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        if (Math.hypot(mx, my) > radius * 0.85) continue;
      }
      if (i !== 0 && r.nextFloat() < 0.25) continue;
      lanes.push([ax, ay, bx, by]);
    }
  });
  const ring = boundary.slice();
  ring.push(boundary[0]!, boundary[1]!);
  return { radius, lanes, ring, square: cells[0]! };
}
