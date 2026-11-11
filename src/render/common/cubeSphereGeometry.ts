/**
 * Cube-sphere vertex data, free of any Three.js dependency so it can be unit-tested.
 *
 * Each of the six faces is an (n+1)×(n+1) vertex grid. Vertices on face edges
 * are duplicated per face, which keeps per-face attributes (color now, face UV
 * for baked maps later) simple. Positions are float32, relative to the planet
 * center; the mesh is placed camera-relative at render time.
 */
import { CUBE_FACE_COUNT, cubeFaceUvToDirection } from '../../core/coords';
import type { CubeFace } from '../../core/coords';
import type { CubeGrid } from '../../core/cubeGrid';
import { Vec3d } from '../../core/vec3d';

export interface CubeSphereArrays {
  /** xyz per vertex, meters from the planet center. */
  positions: Float32Array;
  /** Unit normal per vertex. */
  normals: Float32Array;
  /** Cube face index per vertex. */
  faces: Uint8Array;
  /** Face (u, v) per vertex. */
  uvs: Float32Array;
  indices: Uint32Array;
}

export function buildCubeSphereArrays(subdivisions: number, radius: number): CubeSphereArrays {
  const n = Math.max(1, Math.floor(subdivisions));
  const vertsPerFace = (n + 1) * (n + 1);
  const vertexCount = CUBE_FACE_COUNT * vertsPerFace;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const faces = new Uint8Array(vertexCount);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(CUBE_FACE_COUNT * n * n * 6);

  const d = new Vec3d();
  let vi = 0;
  let ii = 0;
  for (let face = 0; face < CUBE_FACE_COUNT; face++) {
    const base = face * vertsPerFace;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const v = j / n;
        cubeFaceUvToDirection(face as CubeFace, u, v, d);
        positions[vi * 3] = d.x * radius;
        positions[vi * 3 + 1] = d.y * radius;
        positions[vi * 3 + 2] = d.z * radius;
        normals[vi * 3] = d.x;
        normals[vi * 3 + 1] = d.y;
        normals[vi * 3 + 2] = d.z;
        faces[vi] = face;
        uvs[vi * 2] = u;
        uvs[vi * 2 + 1] = v;
        vi++;
      }
    }
    // u right, v up seen from outside, so (00, 10, 11) is counterclockwise: front-facing.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1) + 1;
        const e = a + (n + 1);
        indices[ii++] = a;
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = a;
        indices[ii++] = c;
        indices[ii++] = e;
      }
    }
  }
  return { positions, normals, faces, uvs, indices };
}

/**
 * For each lattice vertex (same order as buildCubeSphereArrays), the grid
 * cells sharing that corner: up to 4, sorted ascending and padded with −1.
 * Three cells meet at a cube corner. Vertices duplicated on face edges get
 * identical lists on every face, which keeps averaged values seam-free.
 */
export function buildCornerCells(grid: CubeGrid): Int32Array {
  const n = grid.n;
  const corners = new Int32Array(CUBE_FACE_COUNT * (n + 1) * (n + 1) * 4).fill(-1);
  const found: number[] = [];
  let v = 0;
  for (let face = 0; face < CUBE_FACE_COUNT; face++) {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        found.length = 0;
        for (const [di, dj] of CORNER_QUADRANTS) {
          const cell = grid.cellAtFaceCoords(face, i + di, j + dj);
          if (!found.includes(cell)) found.push(cell);
        }
        found.sort((a, b) => a - b);
        for (let k = 0; k < found.length; k++) corners[v * 4 + k] = found[k]!;
        v++;
      }
    }
  }
  return corners;
}

const CORNER_QUADRANTS = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [-0.5, 0.5],
  [0.5, 0.5],
] as const;
