/**
 * Cube-sphere cell grid: n × n cells per cube face, 6n² cells in total.
 *
 * Cell index = (face · n + j) · n + i, where i runs along the face's u axis
 * and j along its v axis (see coords.ts for the face frames). Cell (i, j)
 * covers u ∈ [i/n, (i+1)/n] and v ∈ [j/n, (j+1)/n] in equi-angular face
 * coordinates.
 *
 * Neighbor lookups cross face seams. The cell on the far side of an edge is
 * found by stepping one cell past the edge in face coordinates (the
 * equi-angular warp extends smoothly beyond [0, 1]), converting to a
 * direction and looking up the cell that contains it. The order of
 * neighbors4 is [+u, −u, +v, −v] in the cell's own face frame. Neighbors on
 * another face have their own, rotated frame.
 */
import { CUBE_FACE_COUNT, cubeFaceUvToDirection, directionToCubeFace } from './coords';
import type { CubeFace, CubeFaceUv } from './coords';
import { Vec3d } from './vec3d';

/** Offsets (di, dj) for neighbors8: the four edge neighbors first, then the diagonals. */
export const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

export class CubeGrid {
  /** Cells per face edge. */
  readonly n: number;
  readonly cellCount: number;
  /** Unit direction of each cell center, xyz interleaved. */
  readonly centers: Float64Array;
  /** Solid angle of each cell in steradians. They sum to 4π. */
  readonly areas: Float64Array;
  /** Edge neighbors [+u, −u, +v, −v] per cell. Every cell has exactly four. */
  readonly neighbors4: Int32Array;
  /**
   * Edge and diagonal neighbors per cell, in NEIGHBOR_OFFSETS order. A
   * diagonal is −1 where none exists: the 24 cells touching a cube corner
   * have only seven neighbors.
   */
  readonly neighbors8: Int32Array;

  private readonly uvScratch: CubeFaceUv = { face: 0, u: 0, v: 0 };
  private readonly dirScratch = new Vec3d();

  constructor(n: number) {
    if (!Number.isInteger(n) || n < 2) throw new RangeError(`CubeGrid needs n >= 2, got ${n}`);
    this.n = n;
    this.cellCount = CUBE_FACE_COUNT * n * n;
    this.centers = new Float64Array(this.cellCount * 3);
    this.areas = new Float64Array(this.cellCount);
    this.neighbors4 = new Int32Array(this.cellCount * 4);
    this.neighbors8 = new Int32Array(this.cellCount * 8);
    this.buildCenters();
    this.buildAreas();
    this.buildNeighbors();
  }

  index(face: number, i: number, j: number): number {
    return (face * this.n + j) * this.n + i;
  }

  faceOf(cell: number): CubeFace {
    return Math.floor(cell / (this.n * this.n)) as CubeFace;
  }

  iOf(cell: number): number {
    return cell % this.n;
  }

  jOf(cell: number): number {
    return Math.floor(cell / this.n) % this.n;
  }

  /** Writes the unit direction of a cell center into `out`. */
  center(cell: number, out = new Vec3d()): Vec3d {
    const c = this.centers;
    return out.set(c[cell * 3], c[cell * 3 + 1], c[cell * 3 + 2]);
  }

  /** Cell containing face coordinates (u, v) in [0, 1]². Values on the far edge clamp inward. */
  cellOfUv(face: number, u: number, v: number): number {
    const n = this.n;
    const i = Math.min(n - 1, Math.max(0, Math.floor(u * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
    return this.index(face, i, j);
  }

  /** Cell containing a direction (any nonzero length). */
  cellOfDirection(d: Readonly<Vec3d>): number {
    const uv = directionToCubeFace(d, this.uvScratch);
    return this.cellOfUv(uv.face, uv.u, uv.v);
  }

  /**
   * Cell at fractional cell coordinates (fi, fj) on a face, where (i + 0.5,
   * j + 0.5) is the center of cell (i, j). Coordinates may lie outside the
   * face, in which case the point is mapped onto the neighboring face.
   */
  cellAtFaceCoords(face: number, fi: number, fj: number): number {
    const n = this.n;
    if (fi >= 0 && fi < n && fj >= 0 && fj < n) {
      return this.index(face, Math.floor(fi), Math.floor(fj));
    }
    cubeFaceUvToDirection(face as CubeFace, fi / n, fj / n, this.dirScratch);
    return this.cellOfDirection(this.dirScratch);
  }

  /** Angle in radians between two cell centers. */
  angleBetween(a: number, b: number): number {
    const c = this.centers;
    const ax = c[a * 3];
    const ay = c[a * 3 + 1];
    const az = c[a * 3 + 2];
    const bx = c[b * 3];
    const by = c[b * 3 + 1];
    const bz = c[b * 3 + 2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz);
  }

  private buildCenters(): void {
    const n = this.n;
    const d = new Vec3d();
    for (let face = 0; face < CUBE_FACE_COUNT; face++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          cubeFaceUvToDirection(face as CubeFace, (i + 0.5) / n, (j + 0.5) / n, d);
          const c = this.index(face, i, j) * 3;
          this.centers[c] = d.x;
          this.centers[c + 1] = d.y;
          this.centers[c + 2] = d.z;
        }
      }
    }
  }

  private buildAreas(): void {
    const n = this.n;
    const a = new Vec3d();
    const b = new Vec3d();
    const c = new Vec3d();
    const d = new Vec3d();
    for (let face = 0; face < CUBE_FACE_COUNT; face++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const f = face as CubeFace;
          cubeFaceUvToDirection(f, i / n, j / n, a);
          cubeFaceUvToDirection(f, (i + 1) / n, j / n, b);
          cubeFaceUvToDirection(f, (i + 1) / n, (j + 1) / n, c);
          cubeFaceUvToDirection(f, i / n, (j + 1) / n, d);
          this.areas[this.index(face, i, j)] =
            sphericalTriangleArea(a, b, c) + sphericalTriangleArea(a, c, d);
        }
      }
    }
  }

  private buildNeighbors(): void {
    const n = this.n;
    for (let face = 0; face < CUBE_FACE_COUNT; face++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const cell = this.index(face, i, j);
          for (let k = 0; k < 8; k++) {
            const [di, dj] = NEIGHBOR_OFFSETS[k]!;
            let nb = this.cellAtFaceCoords(face, i + 0.5 + di, j + 0.5 + dj);
            if (k >= 4) {
              // Past a cube corner the diagonal folds onto an existing neighbor (or the cell itself).
              for (let m = 0; m < k; m++) {
                if (this.neighbors8[cell * 8 + m] === nb) nb = -1;
              }
              if (nb === cell) nb = -1;
            }
            this.neighbors8[cell * 8 + k] = nb;
            if (k < 4) this.neighbors4[cell * 4 + k] = nb;
          }
        }
      }
    }
  }
}

/** Solid angle of the spherical triangle with unit-vector corners a, b, c (Van Oosterom & Strackee). */
export function sphericalTriangleArea(
  a: Readonly<Vec3d>,
  b: Readonly<Vec3d>,
  c: Readonly<Vec3d>,
): number {
  const triple =
    a.x * (b.y * c.z - b.z * c.y) + a.y * (b.z * c.x - b.x * c.z) + a.z * (b.x * c.y - b.y * c.x);
  const denom = 1 + a.dot(b) + b.dot(c) + c.dot(a);
  return 2 * Math.atan2(Math.abs(triple), denom);
}
