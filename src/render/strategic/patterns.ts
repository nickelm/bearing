/**
 * Procedural map patterns (visual-style Part II, Base Map; decision 80).
 *
 * - **Anchored to the ground, sized on the screen.** A pattern lives in world
 *   coordinates, so it never swims while the camera pans. Its period comes from each
 *   fragment's pixel footprint f (meters per pixel): the wanted period is
 *   `targetPx · f`, rounded down to a power of two of `PATTERN_BASE`, and the pattern
 *   is drawn at that period and at twice it, crossfaded by the fraction in between.
 *   The two periods lie within (target / 2, 2 · target] pixels, weighted toward the
 *   one nearer the target, at every zoom and tilt; the switch between powers of two is
 *   a smooth fade. Coverage edges are
 *   one pixel wide (antialiased with f), so patterns stay crisp.
 * - **Plane coordinates.** Each point uses the two world axes across its dominant
 *   radial axis (as on the cube faces), in meters. Patterns step slightly where the
 *   dominant axis changes, along the cube's edges.
 * - **Patterns.** `stipple`: jittered dots, one per cell, for forest canopy.
 *   `grid`: thin lines along both axes, for farmland fields (decision 80).
 *   `hatch`: diagonal lines for steep rock. `dunes`: wavy parallel ripples for sand
 *   deserts. `tussocks`: small sparse dots for tundra. `cracks`: the edges of
 *   jittered cells (Voronoi) for ice caps. `reeds`: short horizontal dashes for
 *   wetlands (decision 81). Lines nest across powers of two (every line of the
 *   coarser period is a line of the finer one), so they fade by dropping the finer
 *   lines; the other patterns crossfade.
 *
 * `patternLevels` and the `*Coverage` functions are the CPU reference for tests; the
 * `*Node` functions are the same in TSL.
 */
import type { Node } from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  exp2,
  float,
  floor,
  fract,
  length,
  log2,
  max,
  min,
  mix,
  select,
  sin,
  step,
  vec2,
  vec3,
} from 'three/tsl';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** Pattern periods are PATTERN_BASE · 2^k meters. */
export const PATTERN_BASE = 1;
/** Forest stipple: dot spacing on screen (px) and dot radius as a share of the spacing. */
export const STIPPLE_SPACING_PX = 7;
export const STIPPLE_RADIUS = 0.24;
/** Farmland grid: field size on screen (px) and line width (px). */
export const GRID_SPACING_PX = 16;
export const GRID_LINE_PX = 1;
/** Line spacing (px) of steep-rock hatching, dune ripples, tundra tussocks, ice cracks and reeds. */
export const HATCH_SPACING_PX = 5;
export const DUNE_SPACING_PX = 9;
export const TUSSOCK_SPACING_PX = 7;
export const CRACK_SPACING_PX = 28;
export const REED_SPACING_PX = 10;
/** Tussock dot radius and the share of cells that get one. */
export const TUSSOCK_RADIUS = 0.2;
export const TUSSOCK_SHARE = 0.55;
/** Reed dash half-length (share of the spacing) and the share of cells that get one. */
export const REED_HALF_LENGTH = 0.25;
export const REED_SHARE = 0.7;

export interface PatternLevels {
  /** The finer period (m) and the one twice as coarse. */
  period0: number;
  period1: number;
  /** Weight of the coarser period, 0..1. */
  t: number;
}

/** Periods for a pixel footprint (m per px) and a target size on screen (px). */
export function patternLevels(
  footprint: number,
  targetPx: number,
  base = PATTERN_BASE,
): PatternLevels {
  const level = Math.log2(Math.max(1e-9, (targetPx * footprint) / base));
  const k = Math.floor(level);
  const period0 = base * 2 ** k;
  return { period0, period1: 2 * period0, t: level - k };
}

/** Pseudo-random 0..1 for a 2D cell (Dave Hoskins' hash12), as on the GPU. */
export function hash12(x: number, y: number): number {
  const fr = (v: number) => v - Math.floor(v);
  let a = fr(x * 0.1031);
  let b = fr(y * 0.1031);
  let c = fr(x * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d;
  b += d;
  c += d;
  return fr((a + b) * c);
}

/** Smooth 0..1 coverage of a shape edge at signed distance `d` (m, inside < 0), `w` m wide. */
const edge = (d: number, w: number) => Math.min(1, Math.max(0, 0.5 - d / w));

/** Stipple coverage at plane coordinates (m) for one period. */
export function stippleCoverage(x: number, y: number, period: number, footprint: number): number {
  const cx = Math.floor(x / period);
  const cy = Math.floor(y / period);
  const jx = (hash12(cx, cy) - 0.5) * (1 - 2 * STIPPLE_RADIUS) * period;
  const jy = (hash12(cy + 17.3, cx - 9.1) - 0.5) * (1 - 2 * STIPPLE_RADIUS) * period;
  const dx = x - (cx + 0.5) * period - jx;
  const dy = y - (cy + 0.5) * period - jy;
  return edge(Math.hypot(dx, dy) - STIPPLE_RADIUS * period, footprint);
}

/** Grid-line coverage at plane coordinates (m) for one period. */
export function gridCoverage(x: number, y: number, period: number, footprint: number): number {
  const half = (GRID_LINE_PX * footprint) / 2;
  const dist = (v: number) => {
    const f = v / period - Math.floor(v / period);
    return Math.min(f, 1 - f) * period;
  };
  return edge(Math.min(dist(x), dist(y)) - half, footprint);
}

/** Distance (m) from v to the nearest multiple of `period`. */
const lineDist = (v: number, period: number) => {
  const f = v / period - Math.floor(v / period);
  return Math.min(f, 1 - f) * period;
};

/** Steep-rock hatching: diagonal lines, one pixel wide. */
export function hatchCoverage(x: number, y: number, period: number, footprint: number): number {
  return edge(lineDist((x + y) * Math.SQRT1_2, period) - footprint / 2, footprint);
}

/** Dune ripples: parallel lines wobbling sideways by 0.15 of the spacing. */
export function duneCoverage(x: number, y: number, period: number, footprint: number): number {
  const u = 0.8 * x + 0.6 * y;
  const v = -0.6 * x + 0.8 * y;
  const w = u + 0.15 * period * Math.sin((2 * Math.PI * v) / (2.5 * period));
  return edge(lineDist(w, period) - footprint / 2, footprint);
}

/** Jittered point of cell (cx, cy) for a period, as in the stipple. */
function cellPoint(cx: number, cy: number, period: number, spread: number): [number, number] {
  return [
    (cx + 0.5 + (hash12(cx, cy) - 0.5) * spread) * period,
    (cy + 0.5 + (hash12(cy + 17.3, cx - 9.1) - 0.5) * spread) * period,
  ];
}

/** Tundra tussocks: small dots in about half the cells. */
export function tussockCoverage(x: number, y: number, period: number, footprint: number): number {
  const cx = Math.floor(x / period);
  const cy = Math.floor(y / period);
  if (hash12(cx + 41.7, cy + 3.1) > TUSSOCK_SHARE) return 0;
  const [px, py] = cellPoint(cx, cy, period, 1 - 2 * TUSSOCK_RADIUS);
  return edge(Math.hypot(x - px, y - py) - TUSSOCK_RADIUS * period, footprint);
}

/** Ice cracks: one-pixel lines along the edges of jittered cells (Voronoi). */
export function crackCoverage(x: number, y: number, period: number, footprint: number): number {
  const cx = Math.floor(x / period);
  const cy = Math.floor(y / period);
  // The nearest point, then the exact distance to the bisector with each other point.
  let ax = 0;
  let ay = 0;
  let best = Infinity;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const [px, py] = cellPoint(cx + i, cy + j, period, 0.8);
      const d = Math.hypot(x - px, y - py);
      if (d < best) {
        best = d;
        ax = px;
        ay = py;
      }
    }
  let edgeDist = Infinity;
  for (let j = -2; j <= 2; j++)
    for (let i = -2; i <= 2; i++) {
      const [bx, by] = cellPoint(cx + i, cy + j, period, 0.8);
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-9) continue;
      const proj = ((x - (ax + bx) / 2) * (bx - ax) + (y - (ay + by) / 2) * (by - ay)) / len;
      edgeDist = Math.min(edgeDist, -proj);
    }
  return edge(edgeDist - footprint / 2, footprint);
}

/** Wetland reeds: short horizontal dashes in most cells. */
export function reedCoverage(x: number, y: number, period: number, footprint: number): number {
  const cx = Math.floor(x / period);
  const cy = Math.floor(y / period);
  if (hash12(cx - 5.3, cy + 29.9) > REED_SHARE) return 0;
  const [px, py] = cellPoint(cx, cy, period, 0.4);
  const dx = Math.max(0, Math.abs(x - px) - REED_HALF_LENGTH * period);
  const dy = Math.abs(y - py);
  return edge(Math.hypot(dx, dy) - footprint / 2, footprint);
}

// --- TSL ---------------------------------------------------------------------

/** Plane coordinates (m) across the dominant axis of `radial`, from a planet position. */
export function planeCoordsNode(planet: V3, radial: V3): V2 {
  const a = abs(radial);
  const xMajor = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
  const yMajor = a.y.greaterThanEqual(a.z);
  return select(
    xMajor,
    vec2(planet.y, planet.z),
    select(yMajor, vec2(planet.x, planet.z), vec2(planet.x, planet.y)),
  ) as V2;
}

/** `patternLevels` in TSL. */
export function patternLevelsNode(footprint: F, targetPx: number | F): { p0: F; p1: F; t: F } {
  const target = typeof targetPx === 'number' ? float(targetPx) : targetPx;
  const level = log2(max(target.mul(footprint).div(PATTERN_BASE), 1e-6));
  const k = floor(level);
  const p0 = exp2(k).mul(PATTERN_BASE) as F;
  return { p0, p1: p0.mul(2) as F, t: level.sub(k) as F };
}

/** `hash12` in TSL. */
export function hash12Node(p: V2): F {
  let p3: V3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)) as V3;
  p3 = p3.add(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33))) as V3;
  return fract(p3.x.add(p3.y).mul(p3.z)) as F;
}

const edgeNode = (d: F, w: F) => clamp(float(0.5).sub(d.div(w)), 0, 1) as F;

function stippleOnce(p: V2, period: F, footprint: F): F {
  const cell = floor(p.div(period)) as V2;
  const spread = period.mul(1 - 2 * STIPPLE_RADIUS);
  const jx = hash12Node(cell).sub(0.5).mul(spread);
  const jy = hash12Node(vec2(cell.y.add(17.3), cell.x.sub(9.1)) as V2)
    .sub(0.5)
    .mul(spread);
  const center = cell.add(0.5).mul(period).add(vec2(jx, jy));
  return edgeNode(length(p.sub(center)).sub(period.mul(STIPPLE_RADIUS)) as F, footprint);
}

function gridOnce(p: V2, period: F, footprint: F): F {
  const f = fract(p.div(period));
  const d = min(min(f.x, f.x.oneMinus()), min(f.y, f.y.oneMinus())).mul(period);
  return edgeNode(d.sub(footprint.mul(GRID_LINE_PX / 2)) as F, footprint);
}

/** Forest stipple coverage 0..1, screen-stable (see the header). */
export function stippleNode(p: V2, footprint: F, targetPx: number | F = STIPPLE_SPACING_PX): F {
  const { p0, p1, t } = patternLevelsNode(footprint, targetPx);
  return mix(stippleOnce(p, p0, footprint), stippleOnce(p, p1, footprint), t) as F;
}

/** Farmland grid-line coverage 0..1, screen-stable (see the header). */
export function gridNode(p: V2, footprint: F, targetPx: number | F = GRID_SPACING_PX): F {
  const { p0, p1, t } = patternLevelsNode(footprint, targetPx);
  // Fade the finer lines out and the coarser in, so a field never splits abruptly.
  return max(gridOnce(p, p1, footprint), gridOnce(p, p0, footprint).mul(t.oneMinus())) as F;
}

/** Distance (m) to the nearest multiple of `period`. */
const lineDistNode = (v: F, period: F) => {
  const f = fract(v.div(period));
  return min(f, f.oneMinus()).mul(period) as F;
};

/** Screen-stable crossfade of a one-period coverage function. */
function crossfade(
  p: V2,
  footprint: F,
  targetPx: number,
  once: (p: V2, period: F, footprint: F) => F,
): F {
  const { p0, p1, t } = patternLevelsNode(footprint, targetPx);
  return mix(once(p, p0, footprint), once(p, p1, footprint), t) as F;
}

/** Screen-stable fade of nested lines: the finer lines fade out above the coarser ones. */
function nestedLines(
  p: V2,
  footprint: F,
  targetPx: number,
  once: (p: V2, period: F, footprint: F) => F,
): F {
  const { p0, p1, t } = patternLevelsNode(footprint, targetPx);
  return max(once(p, p1, footprint), once(p, p0, footprint).mul(t.oneMinus())) as F;
}

function cellPointNode(cell: V2, period: F, spread: number): V2 {
  const jx = hash12Node(cell).sub(0.5).mul(spread);
  const jy = hash12Node(vec2(cell.y.add(17.3), cell.x.sub(9.1)) as V2)
    .sub(0.5)
    .mul(spread);
  return cell.add(0.5).add(vec2(jx, jy)).mul(period) as V2;
}

/** Steep-rock hatching coverage (see `hatchCoverage`). */
export function hatchNode(p: V2, footprint: F): F {
  return nestedLines(p, footprint, HATCH_SPACING_PX, (q, period, f) =>
    edgeNode(lineDistNode(q.x.add(q.y).mul(Math.SQRT1_2) as F, period).sub(f.mul(0.5)) as F, f),
  );
}

/** Dune-ripple coverage (see `duneCoverage`). */
export function duneNode(p: V2, footprint: F): F {
  return crossfade(p, footprint, DUNE_SPACING_PX, (q, period, f) => {
    const u = q.x.mul(0.8).add(q.y.mul(0.6));
    const v = q.x.mul(-0.6).add(q.y.mul(0.8));
    const w = u.add(period.mul(0.15).mul(sin(v.mul(2 * Math.PI).div(period.mul(2.5)))));
    return edgeNode(lineDistNode(w as F, period).sub(f.mul(0.5)) as F, f);
  });
}

/** Tundra-tussock coverage (see `tussockCoverage`). */
export function tussockNode(p: V2, footprint: F): F {
  return crossfade(p, footprint, TUSSOCK_SPACING_PX, (q, period, f) => {
    const cell = floor(q.div(period)) as V2;
    const keep = step(hash12Node(cell.add(vec2(41.7, 3.1)) as V2), float(TUSSOCK_SHARE));
    const c = cellPointNode(cell, period, 1 - 2 * TUSSOCK_RADIUS);
    return edgeNode(length(q.sub(c)).sub(period.mul(TUSSOCK_RADIUS)) as F, f).mul(keep) as F;
  });
}

/** Ice-crack coverage (see `crackCoverage`). */
export function crackNode(p: V2, footprint: F): F {
  return crossfade(p, footprint, CRACK_SPACING_PX, (q, period, f) => {
    const cell = floor(q.div(period)) as V2;
    // The nearest point, then the exact distance to its bisector with each other point.
    let best: F = float(1e9) as F;
    let a: V2 = vec2(0, 0) as V2;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const pt = cellPointNode(cell.add(vec2(i, j)) as V2, period, 0.8);
        const d = length(q.sub(pt)) as F;
        a = select(d.lessThan(best), pt, a) as V2;
        best = min(best, d) as F;
      }
    let edgeDist: F = float(1e9) as F;
    for (let j = -2; j <= 2; j++)
      for (let i = -2; i <= 2; i++) {
        const b = cellPointNode(cell.add(vec2(i, j)) as V2, period, 0.8);
        const ab = b.sub(a);
        const len = length(ab);
        const proj = dot(q.sub(a.add(b).mul(0.5)), ab).div(max(len, 1e-6));
        // The nearest point itself (len 0) never bounds the cell.
        edgeDist = min(edgeDist, select(len.lessThan(1e-6), float(1e9), proj.negate())) as F;
      }
    return edgeNode(edgeDist.sub(f.mul(0.5)) as F, f);
  });
}

/** Wetland-reed coverage (see `reedCoverage`). */
export function reedNode(p: V2, footprint: F): F {
  return crossfade(p, footprint, REED_SPACING_PX, (q, period, f) => {
    const cell = floor(q.div(period)) as V2;
    const keep = step(hash12Node(cell.add(vec2(-5.3, 29.9)) as V2), float(REED_SHARE));
    const c = cellPointNode(cell, period, 0.4);
    const dx = max(abs(q.x.sub(c.x)).sub(period.mul(REED_HALF_LENGTH)), 0);
    const dy = abs(q.y.sub(c.y));
    return edgeNode(length(vec2(dx, dy)).sub(f.mul(0.5)) as F, f).mul(keep) as F;
  });
}
