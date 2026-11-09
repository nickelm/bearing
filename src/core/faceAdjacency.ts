/**
 * Table-free neighbor addressing on an n × n-per-face cube grid.
 *
 * `CubeGrid` stores neighbor tables, which cost about 80 bytes per cell
 * together with its float64 centers. That is too much for the 1024²–2048²
 * global grid (decision 21). This module computes the same neighbors from
 * (face, i, j) alone, on the CPU here and with the same table on the GPU
 * (worldgen/gpu/globalGrid.ts).
 *
 * Cells use CubeGrid's layout: index = (face · n + j) · n + i.
 *
 * Crossing a face edge is an integer remap. With the equi-angular warp, the
 * row of cells along an edge shares that edge segment exactly with one row on
 * the neighboring face (the tests check this against CubeGrid's direction-based
 * lookup). For each (face, edge), each of the target face's two indices is
 * either the index along the edge or the distance t past the edge (0 for the
 * first cell over), possibly mirrored to n − 1 − x.
 *
 * Edges are numbered like neighbors4: 0 = +u, 1 = −u, 2 = +v, 3 = −v.
 */
import { CUBE_FACES, CUBE_FACE_COUNT } from './coords';
import type { CubeFace } from './coords';
import type { Vec3d } from './vec3d';

/** Source of one target-face index when crossing an edge. */
export const EdgeSource = {
  /** The cell's index along the edge on the source face. */
  Along: 0,
  /** How far past the edge the step lands (0 for the first cell over). */
  Past: 1,
} as const;
export type EdgeSource = (typeof EdgeSource)[keyof typeof EdgeSource];

export interface FaceEdge {
  /** The face across this edge. */
  readonly face: CubeFace;
  readonly iSource: EdgeSource;
  /** Mirror the target i: n − 1 − x. */
  readonly iFlip: boolean;
  readonly jSource: EdgeSource;
  readonly jFlip: boolean;
}

function sameAxis(a: Readonly<Vec3d>, b: Readonly<Vec3d>, sign: number): boolean {
  return a.x === b.x * sign && a.y === b.y * sign && a.z === b.z * sign;
}

function buildFaceEdges(): FaceEdge[] {
  const out: FaceEdge[] = [];
  for (let f = 0; f < CUBE_FACE_COUNT; f++) {
    const F = CUBE_FACES[f]!;
    for (let e = 0; e < 4; e++) {
      const sign = e % 2 === 0 ? 1 : -1;
      const cross = e < 2 ? F.uAxis : F.vAxis;
      const along = e < 2 ? F.vAxis : F.uAxis;
      const g = CUBE_FACES.findIndex((G) => sameAxis(G.normal, cross, sign));
      if (g < 0) throw new Error(`No face across edge ${e} of face ${f}`);
      const G = CUBE_FACES[g]!;
      const axisMap = (A: Readonly<Vec3d>): [EdgeSource, boolean] => {
        if (sameAxis(A, along, 1)) return [EdgeSource.Along, false];
        if (sameAxis(A, along, -1)) return [EdgeSource.Along, true];
        // The shared edge lies where the component along F's normal is largest,
        // i.e. at the high end of an axis equal to +normal.
        if (sameAxis(A, F.normal, 1)) return [EdgeSource.Past, true];
        if (sameAxis(A, F.normal, -1)) return [EdgeSource.Past, false];
        throw new Error(`Face ${g} axis is not aligned with face ${f}`);
      };
      const [iSource, iFlip] = axisMap(G.uAxis);
      const [jSource, jFlip] = axisMap(G.vAxis);
      if (iSource === jSource) throw new Error(`Degenerate edge map ${f}/${e}`);
      out.push({ face: g as CubeFace, iSource, iFlip, jSource, jFlip });
    }
  }
  return out;
}

/** Edge maps indexed by face · 4 + edge. Derived from CUBE_FACES, so it cannot drift from coords.ts. */
export const FACE_EDGES: readonly FaceEdge[] = buildFaceEdges();

/** Cell index for (face, i, j) with 0 ≤ i, j < n. */
export function cellIndex(n: number, face: number, i: number, j: number): number {
  return (face * n + j) * n + i;
}

/**
 * The cell at (i, j) on `face`, where i and j may lie up to n − 1 past one
 * edge (not past two edges at once). Returns −1 past a cube corner, where
 * both coordinates are out of range and no cell exists.
 */
export function wrapCell(n: number, face: number, i: number, j: number): number {
  const iOut = i < 0 || i >= n;
  const jOut = j < 0 || j >= n;
  if (!iOut && !jOut) return cellIndex(n, face, i, j);
  if (iOut && jOut) return -1;
  let edge: number;
  let along: number;
  let past: number;
  if (iOut) {
    edge = i >= n ? 0 : 1;
    along = j;
    past = i >= n ? i - n : -1 - i;
  } else {
    edge = j >= n ? 2 : 3;
    along = i;
    past = j >= n ? j - n : -1 - j;
  }
  const m = FACE_EDGES[face * 4 + edge]!;
  let ni = m.iSource === EdgeSource.Along ? along : past;
  let nj = m.jSource === EdgeSource.Along ? along : past;
  if (m.iFlip) ni = n - 1 - ni;
  if (m.jFlip) nj = n - 1 - nj;
  return cellIndex(n, m.face, ni, nj);
}

/** The neighbor of `cell` at offset (di, dj) in its own face frame, or −1 past a cube corner. */
export function neighborCell(n: number, cell: number, di: number, dj: number): number {
  const nn = n * n;
  const face = Math.floor(cell / nn);
  const r = cell - face * nn;
  const j = Math.floor(r / n);
  const i = r - j * n;
  return wrapCell(n, face, i + di, j + dj);
}
