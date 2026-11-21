/**
 * Viewsheds for composition (Proposal 0010, *Composition*; decision 303): which ground
 * the places players look from can see. Viewpoints are plain points with a height
 * above the ground (an airfield's approach, a road, a sea lane); the caller chooses
 * them, so nothing here knows of airfields as a game's. On the global grid (about
 * 1.5 km a cell), a cell is seen from a viewpoint when the line from the eye to a point
 * `targetHeight` above the cell clears the ground between them.
 *
 * Coarse by design: landmarks are hundreds of meters tall and kilometers away, and the
 * global grid is the surface every system shares (decision 297's heights, as drawn).
 */
import { directionToCubeFace } from '../core/coords';
import type { CubeFaceUv } from '../core/coords';
import { Vec3d } from '../core/vec3d';
import { cellCenterDirection } from './rivers';

export const VIEWSHED_TUNING = {
  /** How far a viewpoint sees (m). */
  range: 30_000,
  /** Height of what is looked at above its cell (m): a landmark's top. */
  targetHeight: 60,
  /** Step along each sight line, in cells. */
  step: 0.5,
};

export interface Viewpoint {
  /** Unit direction. */
  dir: readonly [number, number, number];
  /** Eye height above the ground (m). */
  above: number;
}

export interface ViewshedWorld {
  n: number;
  radius: number;
  height: Float32Array;
}

function cellOf(n: number, d: Readonly<Vec3d>, uv: CubeFaceUv): number {
  directionToCubeFace(d, uv);
  const i = Math.min(n - 1, Math.max(0, Math.floor(uv.u * n)));
  const j = Math.min(n - 1, Math.max(0, Math.floor(uv.v * n)));
  return (uv.face * n + j) * n + i;
}

/**
 * Whether the line from `from` (eye `fromH` m above the sea) to `to` (`toH`) clears the
 * ground, sampled every `step` cells on the global grid.
 */
export function lineOfSight(
  w: ViewshedWorld,
  from: Readonly<Vec3d>,
  fromH: number,
  to: Readonly<Vec3d>,
  toH: number,
  step = VIEWSHED_TUNING.step,
): boolean {
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const cell = ((Math.PI / 2) * w.radius) / w.n;
  const dist = from.distanceTo(to) * w.radius;
  const k = Math.max(1, Math.ceil(dist / (cell * step)));
  const p = new Vec3d();
  for (let i = 1; i < k; i++) {
    const t = i / k;
    p.copy(from)
      .scale(1 - t)
      .addScaled(to, t)
      .normalize();
    // The line's height above the sea, with the planet's curvature: a chord sags below
    // the straight interpolation by about s(L − s)/2R.
    const s = t * dist;
    const lineH = fromH + (toH - fromH) * t - (s * (dist - s)) / (2 * w.radius);
    if (Math.max(0, w.height[cellOf(w.n, p, uv)]!) > lineH) return false;
  }
  return true;
}

/**
 * How many viewpoints see each cell, normalized to 0..1 (1 at `full` or more), over
 * cells within range of any viewpoint; 0 elsewhere.
 */
export function viewshedScore(
  w: ViewshedWorld,
  viewpoints: readonly Viewpoint[],
  full = 3,
): Float32Array {
  const n = w.n;
  const out = new Float32Array(6 * n * n);
  const T = VIEWSHED_TUNING;
  const cell = ((Math.PI / 2) * w.radius) / n;
  const reach = Math.ceil(T.range / cell);
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const eye = new Vec3d();
  const target = new Vec3d();
  for (const v of viewpoints) {
    eye.set(...v.dir);
    const c0 = cellOf(n, eye, uv);
    const face = uv.face;
    const i0 = c0 % n;
    const j0 = Math.floor((c0 - face * n * n) / n);
    const eyeH = Math.max(0, w.height[c0]!) + v.above;
    for (let j = j0 - reach; j <= j0 + reach; j++) {
      if (j < 0 || j >= n) continue;
      for (let i = i0 - reach; i <= i0 + reach; i++) {
        if (i < 0 || i >= n) continue;
        const c = (face * n + j) * n + i;
        cellCenterDirection(n, c, target);
        if (target.distanceTo(eye) * w.radius > T.range) continue;
        const th = Math.max(0, w.height[c]!) + T.targetHeight;
        if (lineOfSight(w, eye, eyeH, target, th)) out[c] = out[c]! + 1 / full;
      }
    }
  }
  for (let c = 0; c < out.length; c++) out[c] = Math.min(1, out[c]!);
  return out;
}

/**
 * The share of viewpoints from which at least one landmark is visible, and per
 * viewpoint whether one is: the proposal's composition check (a landmark within view
 * of most airfields). A landmark is a point with the height of its top above the ground.
 */
export function landmarkCoverage(
  w: ViewshedWorld,
  viewpoints: readonly Viewpoint[],
  landmarks: readonly { dir: readonly [number, number, number]; height: number }[],
): { share: number; seen: boolean[] } {
  const ground = (d: Readonly<Vec3d>) =>
    Math.max(0, w.height[cellOf(w.n, d, { face: 0, u: 0, v: 0 })]!);
  const eye = new Vec3d();
  const mark = new Vec3d();
  const seen = viewpoints.map((v) => {
    eye.set(...v.dir);
    const eyeH = ground(eye) + v.above;
    return landmarks.some((l) => {
      mark.set(...l.dir);
      if (mark.distanceTo(eye) * w.radius > VIEWSHED_TUNING.range) return false;
      return lineOfSight(w, eye, eyeH, mark, ground(mark) + l.height);
    });
  });
  const share = viewpoints.length ? seen.filter(Boolean).length / viewpoints.length : 1;
  return { share, seen };
}
