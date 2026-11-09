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

const EDGE_TABLE = FACE_EDGES.map(
  (e) =>
    `vec4i(${e.face}, ${e.iSource === EdgeSource.Past ? 1 : 0}, ${e.iFlip ? 1 : 0}, ${e.jFlip ? 1 : 0})`,
).join(',\n  ');
const OFFSETS = NEIGHBOR_OFFSETS.map(([di, dj]) => `vec2i(${di}, ${dj})`).join(', ');

/** Face tables and face-coordinate math shared by every grid. Include once per shader. */
export const FACE_WGSL = /* wgsl */ `
const QUARTER_PI: f32 = 0.78539816339744830962;

var<private> FACE_NORMAL: array<vec3f, 6> = array<vec3f, 6>(${CUBE_FACES.map((f) => v3(f.normal)).join(', ')});
var<private> FACE_U: array<vec3f, 6> = array<vec3f, 6>(${CUBE_FACES.map((f) => v3(f.uAxis)).join(', ')});
var<private> FACE_V: array<vec3f, 6> = array<vec3f, 6>(${CUBE_FACES.map((f) => v3(f.vAxis)).join(', ')});
// (target face, i source: 0 along / 1 past, i flip, j flip); j's source is the other one.
var<private> FACE_EDGE: array<vec4i, 24> = array<vec4i, 24>(
  ${EDGE_TABLE}
);
var<private> NEIGHBOR_OFFSET: array<vec2i, 8> = array<vec2i, 8>(${OFFSETS});

// Unit direction of face coordinates (u, v); u and v may extend past [0, 1].
fn faceUvDir(face: i32, u: f32, v: f32) -> vec3f {
  let su = tan(QUARTER_PI * (2.0 * u - 1.0));
  let sv = tan(QUARTER_PI * (2.0 * v - 1.0));
  return normalize(FACE_NORMAL[face] + su * FACE_U[face] + sv * FACE_V[face]);
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

// Catmull-Rom interpolation of four samples at t in [0, 1] between p1 and p2.
fn catmullRom(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
  let t2 = t * t;
  return 0.5 * ((2.0 * p1) + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
    + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t2 * t);
}
`;

/**
 * Cell indexing and neighbors for a grid with n cells per face edge. Every
 * identifier is prefixed with `prefix`, so a shader can address two grids
 * (e.g. the tectonic grid as "t_" and the global grid unprefixed). Needs
 * FACE_WGSL in the same shader.
 */
export function gridWgsl(n: number, prefix = ''): string {
  if (!Number.isInteger(n) || n < 2) throw new RangeError(`Bad grid size ${n}`);
  const p = prefix;
  return /* wgsl */ `
const ${p}N: i32 = ${n};
const ${p}NN: i32 = ${n * n};
const ${p}CELL_COUNT: u32 = ${6 * n * n}u;

fn ${p}cellIndex(face: i32, i: i32, j: i32) -> i32 { return (face * ${p}N + j) * ${p}N + i; }
fn ${p}cellFace(c: i32) -> i32 { return c / ${p}NN; }
fn ${p}cellI(c: i32) -> i32 { return c % ${p}N; }
fn ${p}cellJ(c: i32) -> i32 { return (c / ${p}N) % ${p}N; }

// Cell at (i, j) on a face, where i or j (not both) may lie past an edge. −1 past a corner.
fn ${p}wrapCell(face: i32, i: i32, j: i32) -> i32 {
  let iOut = i < 0 || i >= ${p}N;
  let jOut = j < 0 || j >= ${p}N;
  if (!iOut && !jOut) { return ${p}cellIndex(face, i, j); }
  if (iOut && jOut) { return -1; }
  var edge: i32;
  var along: i32;
  var past: i32;
  if (iOut) {
    along = j;
    if (i >= ${p}N) { edge = 0; past = i - ${p}N; } else { edge = 1; past = -1 - i; }
  } else {
    along = i;
    if (j >= ${p}N) { edge = 2; past = j - ${p}N; } else { edge = 3; past = -1 - j; }
  }
  let m = FACE_EDGE[face * 4 + edge];
  var ni = select(along, past, m.y == 1);
  var nj = select(past, along, m.y == 1);
  if (m.z == 1) { ni = ${p}N - 1 - ni; }
  if (m.w == 1) { nj = ${p}N - 1 - nj; }
  return ${p}cellIndex(m.x, ni, nj);
}

// Like wrapCell, but past a cube corner falls back to the nearest cell on the face.
fn ${p}wrapCellSafe(face: i32, i: i32, j: i32) -> i32 {
  let c = ${p}wrapCell(face, i, j);
  if (c >= 0) { return c; }
  return ${p}cellIndex(face, clamp(i, 0, ${p}N - 1), clamp(j, 0, ${p}N - 1));
}

// Neighbor k (0..7) of cell c, or −1.
fn ${p}neighbor(c: i32, k: i32) -> i32 {
  let o = NEIGHBOR_OFFSET[k];
  return ${p}wrapCell(${p}cellFace(c), ${p}cellI(c) + o.x, ${p}cellJ(c) + o.y);
}

fn ${p}cellDir(c: i32) -> vec3f {
  let inv = 1.0 / f32(${p}N);
  return faceUvDir(${p}cellFace(c), (f32(${p}cellI(c)) + 0.5) * inv, (f32(${p}cellJ(c)) + 0.5) * inv);
}

fn ${p}dirCell(d: vec3f) -> i32 {
  let face = dirFace(d);
  let uv = projectToFace(d, face);
  let i = clamp(i32(floor(uv.x * f32(${p}N))), 0, ${p}N - 1);
  let j = clamp(i32(floor(uv.y * f32(${p}N))), 0, ${p}N - 1);
  return ${p}cellIndex(face, i, j);
}
`;
}

/**
 * A bicubic (Catmull-Rom) sampler named `fnName` over the map `mapVar` (an
 * array<f32> in the shader) on the grid with `prefix`. Takes (face, u, v) and
 * crosses face seams. The result is clamped to the range of the four nearest
 * cells, so steep steps such as coasts do not ring.
 */
export function bicubicSamplerWgsl(fnName: string, mapVar: string, prefix = ''): string {
  const p = prefix;
  return /* wgsl */ `
fn ${fnName}(face: i32, u: f32, v: f32) -> f32 {
  let fi = u * f32(${p}N) - 0.5;
  let fj = v * f32(${p}N) - 0.5;
  let i0 = i32(floor(fi));
  let j0 = i32(floor(fj));
  let tx = fi - floor(fi);
  let ty = fj - floor(fj);
  var rows: array<f32, 4>;
  var lo = 3.4e38;
  var hi = -3.4e38;
  for (var b = 0; b < 4; b++) {
    var r: array<f32, 4>;
    for (var a = 0; a < 4; a++) {
      r[a] = ${mapVar}[${p}wrapCellSafe(face, i0 - 1 + a, j0 - 1 + b)];
      if ((a == 1 || a == 2) && (b == 1 || b == 2)) {
        lo = min(lo, r[a]);
        hi = max(hi, r[a]);
      }
    }
    rows[b] = catmullRom(r[0], r[1], r[2], r[3], tx);
  }
  return clamp(catmullRom(rows[0], rows[1], rows[2], rows[3], ty), lo, hi);
}
`;
}
