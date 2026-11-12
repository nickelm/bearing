/**
 * Graded ground: flat pads cut and filled into the terrain, such as airfields
 * (V3). A pad is a rectangle in a local frame (along a heading, and across it
 * to the right) at a fixed elevation. Inside it the surface is the pad's
 * elevation; over a margin outside it the surface blends back to the terrain
 * with a smootherstep, so the embankment is C¹ at both ends.
 *
 * Grading is a pure function of direction and the ungraded height, so every
 * tile level, the geomorph target, trees and buildings agree on it. Only land
 * is graded: a sample at or below sea level keeps its height, so a coastal
 * pad meets the sea at its own edge rather than filling the bay.
 */
import type { TileKey } from '../../../core/tiles';
import { cubeFaceUvToDirection } from '../../../core/coords';
import { Vec3d } from '../../../core/vec3d';

export interface GradePad {
  /** Unit direction of the pad's reference point. */
  center: Readonly<Vec3d>;
  /** Heading of the pad's long axis, radians clockwise from north. */
  heading: number;
  /** Extent along the heading (m, from the center; along0 < along1). */
  along0: number;
  along1: number;
  /** Extent across, positive to the right of the heading (m; across0 < across1). */
  across0: number;
  across1: number;
  /** Graded elevation (physical m, above sea level). */
  elevation: number;
  /** Width of the blend back to the terrain (m). */
  margin: number;
}

interface PreparedPad {
  pad: GradePad;
  cx: number;
  cy: number;
  cz: number;
  /** Unit tangent along the heading and to its right. */
  fwd: Vec3d;
  right: Vec3d;
  /** Angular reach of the pad and its margin from the center (rad). */
  reach: number;
}

/** The blend weight of the terrain at distance `d` outside a pad: 0 inside, 1 beyond the margin. */
export function gradeBlend(d: number, margin: number): number {
  if (d <= 0) return 0;
  if (d >= margin) return 1;
  const t = d / margin;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export type GradeFn = (dir: Readonly<Vec3d>, h: number) => number;

export class SurfaceGrading {
  private readonly pads: PreparedPad[];

  constructor(
    pads: readonly GradePad[],
    readonly radius: number,
  ) {
    this.pads = pads.map((pad) => {
      const c = pad.center;
      const east = new Vec3d(0, 1, 0).cross(c);
      if (east.length() < 1e-9) east.set(1, 0, 0);
      east.normalize();
      const north = new Vec3d(c.x, c.y, c.z).cross(east);
      const s = Math.sin(pad.heading);
      const k = Math.cos(pad.heading);
      const fwd = east.clone().scale(s).addScaled(north, k);
      // Right of the heading: (fx, fy) turned clockwise by 90°.
      const right = east.clone().scale(k).addScaled(north, -s);
      const ext = Math.hypot(
        Math.max(-pad.along0, pad.along1),
        Math.max(-pad.across0, pad.across1),
      );
      return {
        pad,
        cx: c.x,
        cy: c.y,
        cz: c.z,
        fwd,
        right,
        reach: (ext + pad.margin) / radius,
      };
    });
  }

  get count(): number {
    return this.pads.length;
  }

  /** The graded height at unit direction `dir`, given the ungraded height `h` there. */
  apply(dir: Readonly<Vec3d>, h: number): number {
    return this.applyTo(this.pads, dir, h);
  }

  /** How much of the ground at `dir` is graded: 1 on a pad, 0 beyond its margin. */
  cover(dir: Readonly<Vec3d>): number {
    let c = 0;
    for (const p of this.pads) c = Math.max(c, 1 - this.blendAt(p, dir));
    return c;
  }

  /**
   * The grading restricted to pads that reach tile `t` (any level), or null
   * when none does, so ungraded tiles pay nothing.
   */
  forTile(t: TileKey): GradeFn | null {
    const n = 1 << t.level;
    const c = cubeFaceUvToDirection(t.face, (t.x + 0.5) / n, (t.y + 0.5) / n);
    const corner = cubeFaceUvToDirection(t.face, t.x / n, t.y / n);
    // Half-diagonal of the tile as an angle, with slack for the face warp.
    const half = 1.2 * Math.acos(Math.min(1, c.dot(corner)));
    const near = this.pads.filter((p) => {
      const dot = p.cx * c.x + p.cy * c.y + p.cz * c.z;
      return Math.acos(Math.min(1, dot)) <= half + p.reach;
    });
    if (near.length === 0) return null;
    return (dir, h) => this.applyTo(near, dir, h);
  }

  /** The terrain's weight at `dir` around pad p: 0 on it, 1 beyond its margin. */
  private blendAt(p: PreparedPad, dir: Readonly<Vec3d>): number {
    const R = this.radius;
    const dx = dir.x - p.cx;
    const dy = dir.y - p.cy;
    const dz = dir.z - p.cz;
    // Tangent-plane coordinates (pads are a few km across).
    const along = (dx * p.fwd.x + dy * p.fwd.y + dz * p.fwd.z) * R;
    const across = (dx * p.right.x + dy * p.right.y + dz * p.right.z) * R;
    const q = p.pad;
    const ea = Math.max(q.along0 - along, 0, along - q.along1);
    const ec = Math.max(q.across0 - across, 0, across - q.across1);
    if (ea >= q.margin || ec >= q.margin) return 1;
    return gradeBlend(Math.hypot(ea, ec), q.margin);
  }

  private applyTo(pads: readonly PreparedPad[], dir: Readonly<Vec3d>, h: number): number {
    if (h <= 0) return h;
    for (const p of pads) {
      const w = this.blendAt(p, dir);
      if (w >= 1) continue;
      // Pads do not overlap in practice; if they do, the first one wins.
      return p.pad.elevation + (h - p.pad.elevation) * w;
    }
    return h;
  }
}
