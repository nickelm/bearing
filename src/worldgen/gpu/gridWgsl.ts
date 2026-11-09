/**
 * WGSL library for the global grid: cell indexing, seam-crossing neighbors,
 * face frames and direction ↔ face coordinates.
 *
 * Generated from CUBE_FACES and FACE_EDGES, so the GPU cannot drift from
 * core/coords.ts and core/faceAdjacency.ts. Tests compare it against both.
 *
 * Index layout as CubeGrid: cell = (face · N + j) · N + i. Neighbor k follows
 * NEIGHBOR_OFFSETS: [+u, −u, +v, −v, (+1,+1), (−1,+1), (+1,−1), (−1,−1)].
 * Indices are i32 so that −1 can mean "no neighbor" (past a cube corner).
 */
import { CUBE_FACES } from '../../core/coords';
import { NEIGHBOR_OFFSETS } from '../../core/cubeGrid';
import { EdgeSource, FACE_EDGES } from '../../core/faceAdjacency';
import type { Vec3d } from '../../core/vec3d';

const v3 = (v: Readonly<Vec3d>) => `vec3f(${v.x}, ${v.y}, ${v.z})`;

/** WGSL for a grid with n cells per face edge. */
export function gridWgsl(n: number): string {
  if (!Number.isInteger(n) || n < 2) throw new RangeError(`Bad grid size ${n}`);
  const edges = FACE_EDGES.map(
    (e) =>
      `vec4i(${e.face}, ${e.iSource === EdgeSource.Past ? 1 : 0}, ${e.iFlip ? 1 : 0}, ${e.jFlip ? 1 : 0})`,
  ).join(',\n  ');
  const offsets = NEIGHBOR_OFFSETS.map(([di, dj]) => `vec2i(${di}, ${dj})`).join(', ');
  return /* wgsl */ `
const N: i32 = ${n};
const NN: i32 = ${n * n};
const CELL_COUNT: u32 = ${6 * n * n}u;
const QUARTER_PI: f32 = 0.78539816339744830962;

var<private> FACE_NORMAL: array<vec3f, 6> = array<vec3f, 6>(${CUBE_FACES.map((f) => v3(f.normal)).join(', ')});
var<private> FACE_U: array<vec3f, 6> = array<vec3f, 6>(${CUBE_FACES.map((f) => v3(f.uAxis)).join(', ')});
var<private> FACE_V: array<vec3f, 6> = array<vec3f, 6>(${CUBE_FACES.map((f) => v3(f.vAxis)).join(', ')});
// (target face, i source: 0 along / 1 past, i flip, j flip); j's source is the other one.
var<private> FACE_EDGE: array<vec4i, 24> = array<vec4i, 24>(
  ${edges}
);
var<private> NEIGHBOR_OFFSET: array<vec2i, 8> = array<vec2i, 8>(${offsets});

fn cellIndex(face: i32, i: i32, j: i32) -> i32 { return (face * N + j) * N + i; }
fn cellFace(c: i32) -> i32 { return c / NN; }
fn cellI(c: i32) -> i32 { return c % N; }
fn cellJ(c: i32) -> i32 { return (c / N) % N; }

// Cell at (i, j) on a face, where i or j (not both) may lie past an edge. −1 past a corner.
fn wrapCell(face: i32, i: i32, j: i32) -> i32 {
  let iOut = i < 0 || i >= N;
  let jOut = j < 0 || j >= N;
  if (!iOut && !jOut) { return cellIndex(face, i, j); }
  if (iOut && jOut) { return -1; }
  var edge: i32;
  var along: i32;
  var past: i32;
  if (iOut) {
    along = j;
    if (i >= N) { edge = 0; past = i - N; } else { edge = 1; past = -1 - i; }
  } else {
    along = i;
    if (j >= N) { edge = 2; past = j - N; } else { edge = 3; past = -1 - j; }
  }
  let m = FACE_EDGE[face * 4 + edge];
  var ni = select(along, past, m.y == 1);
  var nj = select(past, along, m.y == 1);
  if (m.z == 1) { ni = N - 1 - ni; }
  if (m.w == 1) { nj = N - 1 - nj; }
  return cellIndex(m.x, ni, nj);
}

// Neighbor k (0..7) of cell c, or −1.
fn neighbor(c: i32, k: i32) -> i32 {
  let o = NEIGHBOR_OFFSET[k];
  return wrapCell(cellFace(c), cellI(c) + o.x, cellJ(c) + o.y);
}

// Unit direction of face coordinates (u, v); u and v may extend past [0, 1].
fn faceUvDir(face: i32, u: f32, v: f32) -> vec3f {
  let su = tan(QUARTER_PI * (2.0 * u - 1.0));
  let sv = tan(QUARTER_PI * (2.0 * v - 1.0));
  return normalize(FACE_NORMAL[face] + su * FACE_U[face] + sv * FACE_V[face]);
}

fn cellDir(c: i32) -> vec3f {
  let inv = 1.0 / f32(N);
  return faceUvDir(cellFace(c), (f32(cellI(c)) + 0.5) * inv, (f32(cellJ(c)) + 0.5) * inv);
}

// Face for a direction: the axis with the largest magnitude, ties as in coords.ts.
fn dirFace(d: vec3f) -> i32 {
  let a = abs(d);
  if (a.x >= a.y && a.x >= a.z) { return select(1, 0, d.x >= 0.0); }
  if (a.y >= a.z) { return select(3, 2, d.y >= 0.0); }
  return select(5, 4, d.z >= 0.0);
}

// (u, v) of a direction projected onto a given face; outside [0, 1] over a neighbor face.
fn projectToFace(d: vec3f, face: i32) -> vec2f {
  let dn = dot(d, FACE_NORMAL[face]);
  let su = dot(d, FACE_U[face]) / dn;
  let sv = dot(d, FACE_V[face]) / dn;
  return vec2f((atan(su) / QUARTER_PI + 1.0) * 0.5, (atan(sv) / QUARTER_PI + 1.0) * 0.5);
}

fn dirCell(d: vec3f) -> i32 {
  let face = dirFace(d);
  let uv = projectToFace(d, face);
  let i = clamp(i32(floor(uv.x * f32(N))), 0, N - 1);
  let j = clamp(i32(floor(uv.y * f32(N))), 0, N - 1);
  return cellIndex(face, i, j);
}
`;
}
