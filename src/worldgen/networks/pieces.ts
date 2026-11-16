/**
 * One piece of an alignment on the sphere (decision 180): between two
 * anchors, routed, fitted, profiled, its earthworks classified and its
 * corridor edits made. The network tier's links will be cut into pieces at
 * fixed anchors (settlements, junctions, strategic bridges, points every few
 * tens of kilometers), so a piece depends only on its anchors and the ground
 * in its band, and pieces can be aligned in any order (plan, conflict 8).
 *
 * Works in a gnomonic plane at the piece's middle (great circles are straight
 * there; within 30 km of its center the scale is off by under 0.1%).
 */
import { Vec3d } from '../../core/vec3d';
import { CORRIDOR_BANKS } from '../edits/corridor';
import type { CorridorEdit } from '../edits/corridor';
import { designProfile, earthworks, fitPlan, STRUCTURE } from './alignment';
import type { EarthworkLimits, Structure } from './alignment';
import { route } from './router';
import type { RouteClass } from './router';

/** Formation half-width per class (m): carriageway and shoulders, or ballast bed. */
export const FORMATION_HALF_WIDTH = {
  mainline: 4,
  mountainRailway: 3.5,
  motorway: 15,
  trunk: 7,
  secondary: 4.5,
  mountainRoad: 3.5,
  track: 2.5,
};

export interface PieceOptions {
  cls: RouteClass;
  limits: EarthworkLimits;
  /** Formation half-width (m). */
  halfWidth: number;
  /** Router lattice spacing (m). */
  spacing: number;
  /** Half-width of the search band around the straight link (m). */
  band: number;
  /** Plan sample step (m). */
  step?: number;
  /** Elevations at the anchors (m); the ground there by default. */
  startZ?: number;
  endZ?: number;
  /** Corridor priority (class rank). */
  priority?: number;
  maxExpansions?: number;
}

export interface Piece {
  /** Unit directions along the plan. */
  points: Vec3d[];
  /** Arc length (m), ground and design elevation (m) and structure at each point. */
  s: number[];
  ground: number[];
  design: number[];
  structure: Structure[];
  /** Corners tighter than the class's radius (m). */
  violations: number[];
  /** Terrain edits of the corridor stretches. */
  corridors: CorridorEdit[];
  expansions: number;
}

/** A gnomonic frame at unit direction `c`: plane meters ↔ unit directions. */
export function gnomonic(c: Readonly<Vec3d>, radius: number) {
  const east = new Vec3d(0, 1, 0).cross(c);
  if (east.length() < 1e-9) east.set(1, 0, 0);
  east.normalize();
  const north = new Vec3d(c.x, c.y, c.z).cross(east);
  return {
    toPlane(d: Readonly<Vec3d>): [number, number] {
      const k = d.x * c.x + d.y * c.y + d.z * c.z;
      return [
        ((d.x * east.x + d.y * east.y + d.z * east.z) / k) * radius,
        ((d.x * north.x + d.y * north.y + d.z * north.z) / k) * radius,
      ];
    },
    toSphere(x: number, y: number, out = new Vec3d()): Vec3d {
      return out
        .set(
          c.x + (x * east.x + y * north.x) / radius,
          c.y + (x * east.y + y * north.y) / radius,
          c.z + (x * east.z + y * north.z) / radius,
        )
        .normalize();
    },
  };
}

/**
 * Aligns one piece from `a` to `b` (unit directions) over ground `height`
 * (m at a unit direction), or null if no route meets the class's grade
 * within the band.
 */
export function alignPiece(
  a: Readonly<Vec3d>,
  b: Readonly<Vec3d>,
  height: (d: Readonly<Vec3d>) => number,
  radius: number,
  o: PieceOptions,
): Piece | null {
  const mid = new Vec3d(a.x + b.x, a.y + b.y, a.z + b.z).normalize();
  const frame = gnomonic(mid, radius);
  const pa = frame.toPlane(a);
  const pb = frame.toPlane(b);
  const scratch = new Vec3d();
  const h = (x: number, y: number) => height(frame.toSphere(x, y, scratch));
  // The band: within `band` m of the straight link.
  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  const l2 = dx * dx + dy * dy;
  const allowed = (x: number, y: number) => {
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - pa[0]) * dx + (y - pa[1]) * dy) / l2)) : 0;
    return Math.hypot(x - pa[0] - t * dx, y - pa[1] - t * dy) <= o.band;
  };
  const r = route({
    height: h,
    start: pa,
    goal: pb,
    spacing: o.spacing,
    bounds: {
      x0: Math.min(pa[0], pb[0]) - o.band,
      y0: Math.min(pa[1], pb[1]) - o.band,
      x1: Math.max(pa[0], pb[0]) + o.band,
      y1: Math.max(pa[1], pb[1]) + o.band,
    },
    cls: o.cls,
    allowed,
    maxExpansions: o.maxExpansions,
  });
  if (!r) return null;
  // The route ends on lattice nodes: put the anchors back.
  const path = r.path.slice();
  path[0] = [pa[0], pa[1]];
  path[path.length - 1] = [pb[0], pb[1]];
  // Simplified to within ¾ of a lattice spacing before its corners are rounded.
  const plan = fitPlan(path, o.cls.minRadius, o.step ?? 10, 0.75 * o.spacing);
  const ground = plan.points.map(([x, y]) => h(x, y));
  const design = designProfile(ground, plan.s, o.cls.maxGrade, {
    startZ: o.startZ ?? ground[0],
    endZ: o.endZ ?? ground[ground.length - 1],
  });
  const structure = earthworks(design, ground, o.limits);
  const points = plan.points.map(([x, y]) => frame.toSphere(x, y));
  // Corridor edits for each run of corridor points, banks reaching as far as their
  // tallest cut or fill needs.
  const corridors: CorridorEdit[] = [];
  let i = 0;
  while (i < points.length) {
    if (structure[i] !== STRUCTURE.Corridor) {
      i++;
      continue;
    }
    let j = i;
    let deep = 0;
    while (j < points.length && structure[j] === STRUCTURE.Corridor) {
      deep = Math.max(deep, Math.abs(design[j]! - ground[j]!));
      j++;
    }
    if (j - i >= 2) {
      const run = Math.max(CORRIDOR_BANKS.fillRun, CORRIDOR_BANKS.cutRun);
      corridors.push({
        points: Float64Array.from(points.slice(i, j).flatMap((p) => [p.x, p.y, p.z])),
        elevation: Float64Array.from(design.slice(i, j)),
        halfWidth: o.halfWidth,
        ...CORRIDOR_BANKS,
        reach: o.halfWidth + deep * run + CORRIDOR_BANKS.fade + 2,
        priority: o.priority ?? 0,
      });
    }
    i = j;
  }
  return {
    points,
    s: plan.s,
    ground,
    design,
    structure,
    violations: plan.violations,
    corridors,
    expansions: r.expansions,
  };
}
