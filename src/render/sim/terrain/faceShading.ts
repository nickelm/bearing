/**
 * Per-face evaluation for the simulation view's terrain (docs/visual-style.md
 * Part I, Terrain: shade quantization; decision 124).
 *
 * Flat facets (decision 123) give each triangle one normal; shade
 * quantization also holds the albedo constant per face. Rather than add
 * vertices or flat attributes, each fragment evaluates the surface at its
 * face's center:
 *
 * - **Which face.** Every vertex knows its grid coordinate in the tile
 *   (0..TILE_SEGMENTS on each axis; `tileGridCoordinate`, from the vertex
 *   index). The interpolated coordinate's integer part is the quad, and the
 *   quad's diagonal (i, j)–(i+1, j+1) splits it into a lower and an upper
 *   triangle, as `buildTileIndex` does.
 * - **The face's center.** A varying is an affine function of the grid
 *   coordinate across a triangle, so its value at the centroid is the
 *   fragment's value plus its gradient times the step to the centroid. The
 *   gradient comes from screen-space derivatives (chain rule through the
 *   inverse Jacobian of the grid coordinate), which is exact for any varying
 *   interpolated across the triangle, perspective included.
 * - **Geomorphing.** At morph 0 a child tile shows its parent's triangles
 *   exactly (decision 123), so it must also show the parent's shades. The
 *   evaluation point slides from the parent face's centroid to the child
 *   face's centroid as the morph runs, the jitter cross-fades between the
 *   two faces' hashes and the facet size from the parent's to the child's.
 *   A split therefore starts with the parent's shades; each face switches
 *   shade at most a few times during the morph.
 * - **Keys.** A face's jitter hashes its global quad index (tile x · 64 + i,
 *   y · 64 + j), level, cube face and half, so a parent's face gets the same
 *   value whether drawn by the parent or as a child's morph target.
 *
 * Skirts (vertex grid coordinates copied from the edge) have no face in grid
 * space; they keep their fragment values.
 *
 * Build it, and call `at`, before any per-fragment branch: WGSL takes
 * derivatives only in uniform control flow (decision 69).
 */
import type { Node } from 'three/webgpu';
import {
  abs,
  clamp,
  dFdx,
  dFdy,
  exp2,
  float,
  floor,
  hash,
  max,
  mix,
  mod,
  select,
  step,
  uint,
  vec2,
  vec3,
} from 'three/tsl';
import { TILE_SEGMENTS } from '../../common/terrain/quadtree';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

const S = TILE_SEGMENTS;
const V = TILE_SEGMENTS + 1;
const GRID_VERTICES = V * V;

/**
 * A vertex's grid coordinate in its tile from its index (buildTileIndex's
 * layout): (i, j, skirt), skirt 1 for skirt vertices, which copy an edge
 * vertex (edge 0 = bottom, 1 = top, 2 = left, 3 = right).
 */
export function tileGridCoordinate(vertexIndex: Node<'uint'>): V3 {
  const v = float(vertexIndex);
  const isSkirt = step(GRID_VERTICES - 0.5, v);
  const gi = mod(v, V);
  const gj = floor(v.div(V));
  const s = v.sub(GRID_VERTICES);
  const e = floor(s.div(V));
  const k = mod(s, V);
  const skirtI = select(e.lessThan(1.5), k, select(e.lessThan(2.5), float(0), float(S)));
  const skirtJ = select(e.lessThan(0.5), float(0), select(e.lessThan(1.5), float(S), k));
  return vec3(mix(gi, skirtI, isSkirt), mix(gj, skirtJ, isSkirt), isSkirt) as V3;
}

/**
 * The centroid of the face containing `uv` (grid units): the quad's lower
 * triangle (i, j), (i+1, j), (i+1, j+1) when fx ≥ fy, else the upper one.
 * Also returns the quad and which half.
 */
function faceOf(uv: V2): { quad: V2; lower: F; center: V2 } {
  const quad = clamp(floor(uv), 0, S - 1) as V2;
  const f = uv.sub(quad);
  const lower = step(f.y, f.x) as F;
  const center = quad.add(mix(vec2(1 / 3, 2 / 3), vec2(2 / 3, 1 / 3), lower)) as V2;
  return { quad, lower, center };
}

/** PCG hash of a face key (global quad index, level, cube face, half) in [0, 1). */
function faceHash(gx: F, gy: F, face: F, level: F, lower: F): F {
  const tag = face.mul(64).add(level.mul(2)).add(lower);
  const h1 = hash(tag);
  const h2 = hash(uint(gy).bitXor(uint(h1.mul(16777216))));
  return hash(uint(gx).bitXor(uint(h2.mul(16777216)))) as F;
}

/** Where a fragment's face is evaluated, without derivatives (testable in compute). */
export interface FacePoint {
  /** Evaluation point in the tile's grid units: parent face centroid at morph 0, own at 1. */
  center: V2;
  /** Per-face random value in [0, 1), cross-faded from the parent's face over the morph. */
  jitter: F;
  /** Facet size (m): the tile's vertex spacing, twice that at morph 0. */
  spacing: F;
}

/**
 * The evaluation point, jitter and facet size for grid coordinate `uv` of
 * `tile` (cube face, level, x, y) at `morph`.
 */
export function facePoint(uv: V2, tile: V4, morph: F, radius: number): FacePoint {
  const own = faceOf(uv);
  // The parent's grid: this tile is one quadrant of it.
  const corner = vec2(mod(tile.z, 2), mod(tile.w, 2)).mul(S / 2);
  const parent = faceOf(corner.add(uv.mul(0.5)) as V2);
  const parentCenter = parent.center.sub(corner).mul(2);
  // Level 0 has no parent; its morph is 1 anyway.
  const m = mix(float(1), morph, step(0.5, tile.y)) as F;

  const gx = tile.z.mul(S).add(own.quad.x);
  const gy = tile.w.mul(S).add(own.quad.y);
  const pgx = floor(tile.z.mul(0.5)).mul(S).add(parent.quad.x);
  const pgy = floor(tile.w.mul(0.5)).mul(S).add(parent.quad.y);
  const ownHash = faceHash(gx, gy, tile.x, tile.y, own.lower);
  const parentHash = faceHash(pgx, pgy, tile.x, max(tile.y.sub(1), 0), parent.lower);
  const ownSpacing = float((Math.PI / 2) * radius).div(exp2(tile.y).mul(S));
  return {
    center: mix(parentCenter, own.center, m) as V2,
    jitter: mix(parentHash, ownHash, m) as F,
    spacing: ownSpacing.mul(mix(float(2), float(1), m)) as F,
  };
}

export class FaceSampler {
  /** Screen offset (px) from the fragment to its face's evaluation point; 0 on skirts. */
  readonly offset: V2;
  /** Per-face random value in [0, 1). */
  readonly jitter: F;
  /** Facet size (m). */
  readonly spacing: F;

  /**
   * @param grid the interpolated tileGridCoordinate
   * @param tile the drawn tile as (cube face, level, x, y)
   * @param morph the tile's morph factor (0 = parent surface)
   * @param radius planet radius (m)
   * @param strength 1 evaluates at the face's center, 0 at the fragment
   */
  constructor(grid: V3, tile: V4, morph: F, radius: number, strength: F) {
    const uv = grid.xy as V2;
    const point = facePoint(uv, tile, morph, radius);
    this.jitter = point.jitter;
    this.spacing = point.spacing;

    // Screen step to the point: the inverse of the grid coordinate's Jacobian.
    const du = dFdx(uv);
    const dv = dFdy(uv);
    const det = du.x.mul(dv.y).sub(dv.x.mul(du.y));
    const safe = select(abs(det).greaterThan(1e-30), det, float(1));
    const d = point.center.sub(uv);
    const sx = dv.y.mul(d.x).sub(dv.x.mul(d.y)).div(safe);
    const sy = du.x.mul(d.y).sub(du.y.mul(d.x)).div(safe);
    const usable = float(1)
      .sub(step(1e-6, grid.z))
      .mul(step(1e-30, abs(det)))
      .mul(strength);
    // A face is at most a few thousand pixels across; bound the step regardless.
    const bound = (x: F) => clamp(x, -8192, 8192);
    this.offset = vec2(bound(sx as F), bound(sy as F)).mul(usable) as V2;
  }

  /** A varying's value at the face's evaluation point (fragment value where unusable). */
  at<T extends F | V2 | V3>(value: T): T {
    // Typed loosely: three's node types do not unify over a union of widths.
    const v = value as unknown as V3;
    return v.add(dFdx(v).mul(this.offset.x)).add(dFdy(v).mul(this.offset.y)) as unknown as T;
  }
}
