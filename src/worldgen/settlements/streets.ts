/**
 * Streamline tracing of streets through the tensor field (proposal 0009, decision 262),
 * with the evenly spaced seeding of Jobard and Lefer as Chen et al. use it.
 *
 * Two levels, major then minor streets, each traced along both eigenvectors (the
 * field's direction and the one across it), so streets cross into grids. A line grows
 * from a seed in both directions with RK2 steps until it leaves the domain (outside the
 * extent, over water, onto ground steeper than 30%, into the old core), comes within
 * half its separation of a parallel street of its level or above, closes on itself, or
 * reaches its length cap. New seeds sit a separation to either side of every accepted
 * line. Arterials count as parallel lines of every level.
 */
import type { Rng } from '../../core/rng';
import { simplify, SpatialHash, polylineLength } from './geom';
import type { TensorField } from './tensorField';

export interface Domain {
  inside(x: number, y: number): boolean;
}

export interface TraceOptions {
  /** Separation (m) per level: major, minor. */
  separation: [number, number];
  /** Least length (m) of an accepted line per level. */
  minLength: [number, number];
  /** Step (m). */
  step: number;
  /** Most steps in each direction. */
  maxSteps: number;
  /** Lines to trace at most per level, a guard. */
  maxLines: number;
  /** Separation multiplier at a point (default 1). */
  scale?: (x: number, y: number) => number;
  /** Whether a line of `level` may step from (x, y) along (vx, vy) (default yes). */
  accept?: (x: number, y: number, vx: number, vy: number, level: number) => boolean;
}

export interface TracedLine {
  level: 0 | 1;
  /** 0 along the field's direction, 1 across it. */
  dir: 0 | 1;
  points: number[];
}

interface Sample {
  x: number;
  y: number;
  dir: number;
  level: number;
  line: number;
}

/** The unit eigenvector `dir` at (x, y), turned to agree with (px, py). */
function eigen(
  field: TensorField,
  x: number,
  y: number,
  dir: number,
  px: number,
  py: number,
): [number, number] {
  const a = field.at(x, y).angle + (dir ? Math.PI / 2 : 0);
  let vx = Math.cos(a);
  let vy = Math.sin(a);
  if (vx * px + vy * py < 0) {
    vx = -vx;
    vy = -vy;
  }
  return [vx, vy];
}

export function traceStreets(
  field: TensorField,
  domain: Domain,
  arterials: number[][],
  seeds: [number, number][],
  options: TraceOptions,
  r: Rng,
): TracedLine[] {
  const scale = options.scale ?? (() => 1);
  const maxSep = Math.max(...options.separation) * 2;
  const hash = new SpatialHash<Sample>(maxSep / 2);
  const out: TracedLine[] = [];
  // Arterials block parallel streets of both directions at every level.
  for (const pts of arterials) {
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      const j = Math.min(i + 2, pts.length - 2);
      const k = Math.max(i - 2, 0);
      const ax = pts[j]! - pts[k]!;
      const ay = pts[j + 1]! - pts[k + 1]!;
      const theta = field.at(x, y).angle;
      const along = Math.abs(Math.cos(Math.atan2(ay, ax) - theta)) > Math.SQRT1_2 ? 0 : 1;
      hash.add(x, y, { x, y, dir: along, level: -1, line: -1 });
    }
  }
  const tooClose = (
    x: number,
    y: number,
    dir: number,
    level: number,
    d: number,
    line = -2,
    minIndex = 0,
  ) =>
    hash.near(x, y, d, (s) => {
      if (s.dir !== dir || s.level > level) return false;
      if (s.line === line && minIndex >= 0) return false;
      return (s.x - x) ** 2 + (s.y - y) ** 2 < d * d;
    });

  for (const level of [0, 1] as const) {
    const sep = options.separation[level];
    const test = 0.5 * sep;
    const queue: [number, number, number][] = [];
    for (const [x, y] of seeds) {
      queue.push([x, y, 0], [x, y, 1]);
    }
    // Seeds along every line so far (arterials and majors) for this level.
    for (const pts of arterials) {
      for (let i = 0; i + 1 < pts.length; i += 2) {
        if ((i / 2) % 3 === 0) queue.push([pts[i]!, pts[i + 1]!, 0], [pts[i]!, pts[i + 1]!, 1]);
      }
    }
    for (const l of out) {
      for (let i = 0; i + 1 < l.points.length; i += 8) {
        queue.push([l.points[i]!, l.points[i + 1]!, l.dir ? 0 : 1]);
      }
    }
    let lines = 0;
    for (let head = 0; head < queue.length && lines < options.maxLines; head++) {
      const [sx, sy, dir] = queue[head]!;
      if (!domain.inside(sx, sy)) continue;
      const k0 = scale(sx, sy);
      if (tooClose(sx, sy, dir, level, sep * k0)) continue;
      const index = out.length;
      const halves: number[][] = [];
      const own: Sample[] = [];
      const start = field.at(sx, sy).angle + (dir ? Math.PI / 2 : 0);
      for (const sign of [1, -1]) {
        let px = sign * Math.cos(start);
        let py = sign * Math.sin(start);
        let x = sx;
        let y = sy;
        const pts: number[] = [];
        for (let k = 0; k < options.maxSteps; k++) {
          const h = options.step;
          const [v1x, v1y] = eigen(field, x, y, dir, px, py);
          const [v2x, v2y] = eigen(field, x + (v1x * h) / 2, y + (v1y * h) / 2, dir, v1x, v1y);
          const nx = x + v2x * h;
          const ny = y + v2y * h;
          if (!domain.inside(nx, ny)) break;
          if (options.accept && !options.accept(nx, ny, v2x, v2y, level)) break;
          if (tooClose(nx, ny, dir, level, test * k0, index)) break;
          // Closing on itself: an own sample from well back in the line.
          let closed = false;
          for (let q = 0; q < own.length - 12; q += 3) {
            const s = own[q]!;
            if ((s.x - nx) ** 2 + (s.y - ny) ** 2 < test * test * 0.25) {
              closed = true;
              break;
            }
          }
          if (closed) break;
          pts.push(nx, ny);
          own.push({ x: nx, y: ny, dir, level, line: index });
          px = v2x;
          py = v2y;
          x = nx;
          y = ny;
        }
        halves.push(pts);
      }
      const back = halves[1]!;
      const pts: number[] = [];
      for (let i = back.length - 2; i >= 0; i -= 2) pts.push(back[i]!, back[i + 1]!);
      pts.push(sx, sy, ...halves[0]!);
      if (polylineLength(pts) < options.minLength[level]) continue;
      lines++;
      const simple = simplify(pts, 1.5);
      out.push({ level, dir: dir as 0 | 1, points: simple });
      for (let i = 0; i + 1 < pts.length; i += 2) {
        hash.add(pts[i]!, pts[i + 1]!, { x: pts[i]!, y: pts[i + 1]!, dir, level, line: index });
      }
      // New seeds a separation to either side, every 0.8 separations along, in both
      // directions (the across direction makes the cross streets).
      const every = Math.max(1, Math.round((0.8 * sep * k0) / options.step));
      for (let i = 0; i + 3 < pts.length; i += 2 * every) {
        const x = pts[i]!;
        const y = pts[i + 1]!;
        const tx = pts[i + 2]! - x;
        const ty = pts[i + 3]! - y;
        const tl = Math.hypot(tx, ty) || 1;
        const jitter = 1 + 0.15 * (r.nextFloat() - 0.5);
        for (const side of [1, -1]) {
          const k = scale(x, y);
          queue.push([
            x - (side * ty * sep * k * jitter) / tl,
            y + (side * tx * sep * k * jitter) / tl,
            dir,
          ]);
        }
        queue.push([x, y, dir ? 0 : 1]);
      }
    }
  }
  return out;
}
