/**
 * Cube-sphere vertex data, free of any Three.js dependency so it can be unit-tested.
 *
 * Each of the six faces is an (n+1)×(n+1) vertex grid. Vertices on face edges
 * are duplicated per face, which keeps per-face attributes (color now, face UV
 * for baked maps later) simple. Positions are float32, relative to the planet
 * center; the mesh is placed camera-relative at render time.
 */
import { CUBE_FACE_COUNT, cubeFaceUvToDirection } from '../core/coords';
import type { CubeFace } from '../core/coords';
import { Vec3d } from '../core/vec3d';

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
