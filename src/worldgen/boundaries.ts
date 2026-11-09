/**
 * Stage: plate boundary classification.
 *
 * A cell is a boundary cell if any edge neighbor belongs to another plate.
 * Relative plate motion across those edges gives a closing speed (positive
 * when converging) and a shear speed. Together with the crust type on each
 * side, they decide the boundary type.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Vec3d } from '../core/vec3d';
import type { Plate } from './plates';
import { plateVelocity } from './plates';

export const BoundaryType = {
  None: 0,
  /** Continent–continent convergence: high ranges on both sides. */
  Collision: 1,
  /** Continental side of ocean–continent subduction: a cordillera. */
  Cordillera: 2,
  /** Subducting oceanic side: a trench. */
  Trench: 3,
  /** Overriding side of ocean–ocean subduction: an island arc. */
  IslandArc: 4,
  /** Oceanic divergence: a mid-ocean ridge. */
  Ridge: 5,
  /** Continental divergence: a rift valley. */
  Rift: 6,
  /** Mostly shear. */
  Transform: 7,
} as const;
export type BoundaryType = (typeof BoundaryType)[keyof typeof BoundaryType];
export const BOUNDARY_TYPE_COUNT = 8;

export const BOUNDARY_NAMES: readonly string[] = [
  'none',
  'collision',
  'cordillera',
  'trench',
  'island arc',
  'ridge',
  'rift',
  'transform',
];

export interface Boundaries {
  type: Uint8Array;
  /** Magnitude of the relevant relative speed (closing, opening or shear), roughly 0..2. */
  strength: Float32Array;
}

/** Converging or diverging motion must exceed this share of the shear to count as such. */
const NORMAL_DOMINANCE = 0.5;
const MIN_SPEED = 0.05;
/**
 * A side counts as continental if crust is continental at the boundary or a
 * short distance (meters) into that side. An offshore subduction zone next to a continent then still
 * builds a coastal range.
 */
const CRUST_PROBE_DISTANCES = [60_000, 120_000];

function sideIsContinental(
  grid: CubeGrid,
  continentalness: Float32Array,
  x: Readonly<Vec3d>,
  towardSide: Readonly<Vec3d>,
  startCell: number,
  radius: number,
  scratch: Vec3d,
): boolean {
  if (continentalness[startCell] > 0) return true;
  for (const d of CRUST_PROBE_DISTANCES) {
    const a = d / radius;
    scratch.copy(x).scale(Math.cos(a)).addScaled(towardSide, Math.sin(a));
    if (continentalness[grid.cellOfDirection(scratch)] > 0) return true;
  }
  return false;
}

export function classifyBoundaries(
  grid: CubeGrid,
  plates: readonly Plate[],
  plateOf: Uint8Array,
  continentalness: Float32Array,
  radius: number,
): Boundaries {
  const n = grid.cellCount;
  const probe = new Vec3d();
  const away = new Vec3d();
  const meanTangent = new Vec3d();
  const type = new Uint8Array(n);
  const strength = new Float32Array(n);
  const x = new Vec3d();
  const y = new Vec3d();
  const tangent = new Vec3d();
  const side = new Vec3d();
  const vOwn = new Vec3d();
  const vOther = new Vec3d();
  const rel = new Vec3d();

  for (let c = 0; c < n; c++) {
    const own = plateOf[c];
    let closing = 0;
    let shear = 0;
    let otherCell = -1;
    let edges = 0;
    let overriding = true;
    meanTangent.set(0, 0, 0);
    grid.center(c, x);
    for (let k = 0; k < 4; k++) {
      const nb = grid.neighbors4[c * 4 + k];
      const other = plateOf[nb];
      if (other === own) continue;
      grid.center(nb, y);
      // Direction toward the neighbor, with the radial component removed.
      tangent.subVectors(y, x);
      tangent.addScaled(x, -tangent.dot(x)).normalize();
      side.copy(x).cross(tangent);
      plateVelocity(plates[own]!, x, vOwn);
      plateVelocity(plates[other]!, x, vOther);
      rel.subVectors(vOwn, vOther);
      closing += rel.dot(tangent);
      shear += Math.abs(rel.dot(side));
      meanTangent.add(tangent);
      otherCell = nb;
      // Deterministic choice of overriding plate for ocean–ocean subduction.
      if (other < own) overriding = false;
      edges++;
    }
    if (edges === 0) continue;
    closing /= edges;
    shear /= edges;
    // meanTangent points across the boundary toward the other plate.
    if (meanTangent.lengthSq() < 1e-12) meanTangent.copy(tangent);
    meanTangent.normalize();
    away.copy(meanTangent).scale(-1);
    const ownCont = sideIsContinental(grid, continentalness, x, away, c, radius, probe);
    const otherCont = sideIsContinental(
      grid,
      continentalness,
      x,
      meanTangent,
      otherCell,
      radius,
      probe,
    );
    let t: BoundaryType;
    let s: number;
    if (closing > MIN_SPEED && closing > NORMAL_DOMINANCE * shear) {
      s = closing;
      if (ownCont && otherCont) t = BoundaryType.Collision;
      else if (ownCont) t = BoundaryType.Cordillera;
      else if (otherCont) t = BoundaryType.Trench;
      else t = overriding ? BoundaryType.IslandArc : BoundaryType.Trench;
    } else if (-closing > MIN_SPEED && -closing > NORMAL_DOMINANCE * shear) {
      s = -closing;
      t = ownCont ? BoundaryType.Rift : BoundaryType.Ridge;
    } else {
      s = shear;
      t = BoundaryType.Transform;
    }
    type[c] = t;
    strength[c] = s;
  }
  return { type, strength };
}
