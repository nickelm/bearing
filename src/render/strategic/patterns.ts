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
 *   `grid`: thin lines along both axes, for farmland fields. Later patterns (dunes,
 *   tussocks, hatching, reeds, cracks) add functions here on the same scheme.
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
