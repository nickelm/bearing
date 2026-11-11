/**
 * Low-poly tree clumps for the forest layer (decision 45). Pure TypeScript:
 * flat-shaded triangles with per-vertex colors, in a local frame where +y is
 * up and the clump stands on y = 0. One instance is a clump of a few trees,
 * so a 40 m lattice of instances reads as a forest.
 */
import { rng } from '../../../core/rng';
import { srgbToLinear } from '../../common/palette';

export type TreeKind = 'conifer' | 'broadleaf';

export interface TreeGeometryData {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
}

const TRUNK = [0.3, 0.22, 0.15];
const CROWN: Record<TreeKind, number[]> = {
  conifer: [0.17, 0.3, 0.18],
  broadleaf: [0.27, 0.4, 0.15],
};
/** How far a trunk extends below the ground point, hiding small height mismatches (m). */
export const TRUNK_SINK = 3;

class Builder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];

  /** Adds a flat-shaded triangle (counterclockwise seen from outside). */
  tri(a: number[], b: number[], c: number[], color: number[]): void {
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (const p of [a, b, c]) {
      this.pos.push(p[0]!, p[1]!, p[2]!);
      this.nrm.push(n[0]! / l, n[1]! / l, n[2]! / l);
      this.col.push(...color.map(srgbToLinear));
    }
  }

  /**
   * A pyramid/cone: `sides`-gon of radius r at height y0, apex at y1, around
   * (x, z). Sides only: the base faces down and is seldom seen, and dropping it
   * halves the triangle count (the material is double-sided).
   */
  cone(
    x: number,
    z: number,
    y0: number,
    y1: number,
    r: number,
    sides: number,
    color: number[],
    twist: number,
  ): void {
    const ring = (i: number) => {
      const a = twist + (i / sides) * 2 * Math.PI;
      return [x + r * Math.cos(a), y0, z + r * Math.sin(a)];
    };
    for (let i = 0; i < sides; i++) {
      // Counterclockwise from outside: ring(i+1), ring(i), apex.
      this.tri(ring(i + 1), ring(i), [x, y1, z], color);
    }
  }

  /** An octahedral blob (broadleaf crown) of radii (rx, ry) centered at (x, y, z). */
  blob(
    x: number,
    y: number,
    z: number,
    rx: number,
    ry: number,
    color: number[],
    twist: number,
  ): void {
    const ring = (i: number) => {
      const a = twist + (i / 4) * 2 * Math.PI;
      return [x + rx * Math.cos(a), y, z + rx * Math.sin(a)];
    };
    const top = [x, y + ry, z];
    const bottom = [x, y - ry * 0.7, z];
    for (let i = 0; i < 4; i++) {
      this.tri(ring(i + 1), ring(i), top, color);
      this.tri(ring(i), ring(i + 1), bottom, color);
    }
  }

  build(): TreeGeometryData {
    return {
      position: Float32Array.from(this.pos),
      normal: Float32Array.from(this.nrm),
      color: Float32Array.from(this.col),
    };
  }
}

/** A clump of `count` trees of one kind within about 14 m, standing on y = 0. Deterministic. */
export function treeClump(kind: TreeKind, count = 4): TreeGeometryData {
  const r = rng(0, `render/trees/${kind}`);
  const b = new Builder();
  for (let i = 0; i < count; i++) {
    const a = r.range(0, 2 * Math.PI);
    const d = i === 0 ? 0 : r.range(5, 14);
    const x = d * Math.cos(a);
    const z = d * Math.sin(a);
    const twist = r.range(0, Math.PI);
    if (kind === 'conifer') {
      const h = r.range(14, 24);
      b.cone(x, z, -TRUNK_SINK, h * 0.3, h * 0.04, 4, TRUNK, twist);
      b.cone(x, z, h * 0.18, h, h * 0.24, 6, CROWN.conifer, twist);
    } else {
      const h = r.range(12, 20);
      b.cone(x, z, -TRUNK_SINK, h * 0.55, h * 0.05, 4, TRUNK, twist);
      b.blob(x, h * 0.62, z, h * 0.33, h * 0.35, CROWN.broadleaf, twist);
    }
  }
  return b.build();
}
