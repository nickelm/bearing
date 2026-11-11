/**
 * Distance from the sea to the nearest land, for the strategic map's coastal halo
 * and parallel coastal lines (visual-style Part II, Coasts and water; decision 83).
 *
 * - **Field.** An exact Euclidean distance transform (Felzenszwalb & Huttenlocher)
 *   per cube face on the global height grid: 0 on land (height > 0), distance to the
 *   nearest land cell center at sea, in meters, capped at `COAST_DISTANCE_MAX`.
 * - **Seams.** Each face is transformed with a margin of `margin` cells read from
 *   the neighboring faces through the face's extended (u, v) plane, so a coast just
 *   across a seam is seen. The margin covers the cap, so distances agree across seams
 *   up to the cell size.
 * - **Metric.** Distances are in cells times the mean cell size, (π/2 · R) / n. The
 *   equi-angular warp keeps cells within about 10% of that size.
 * - **Resolution.** Stored at up to 1024 texels per face edge (every k-th cell when
 *   the global grid is finer), as half floats; the shader samples it bilinearly.
 *
 * Near the coast the shader prefers the per-vertex coast distance of decision 39,
 * which follows the fine tile coastline; this field takes over beyond a few
 * kilometers, where lines are placed at globe and theater scales.
 */
import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RedFormat,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { int, texture } from 'three/tsl';
import { cubeFaceUvToDirection, directionToCubeFace } from '../../core/coords';
import type { CubeFace, CubeFaceUv } from '../../core/coords';
import { Vec3d } from '../../core/vec3d';
import { cubeFaceUv } from '../common/climateTexture';

type V3 = Node<'vec3'>;

/** Largest distance stored (m): beyond the outermost coastal line at the ceiling. */
export const COAST_DISTANCE_MAX = 100_000;
/** Most texels per face edge in the texture. */
const MAX_TEXELS = 1024;

const INF = 1e20;

/** 1D squared distance transform of `f` (length n) into `d` (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const at = (q: number, p: number) => (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
  for (let q = 1; q < n; q++) {
    let s = at(q, v[k]!);
    while (s <= z[k]!) {
      k--;
      s = at(q, v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = (q - p) * (q - p) + f[p]!;
  }
}

/**
 * Sea-to-land distance (m) per cell of a global height map with `n` cells per face
 * edge, sampled at every `step`-th cell: 6 · (n / step)² values, face-major like the
 * grid. `margin` cells of the neighboring faces are included.
 */
export function coastDistanceField(
  height: Float32Array,
  n: number,
  radius: number,
  options: { step?: number; margin?: number; max?: number } = {},
): Float32Array {
  const step = options.step ?? 1;
  const max = options.max ?? COAST_DISTANCE_MAX;
  const cell = ((Math.PI / 2) * radius) / n;
  const margin = options.margin ?? Math.min(n, Math.ceil(max / cell) + 1);
  const P = n + 2 * margin;
  const m = Math.floor(n / step);
  const out = new Float32Array(6 * m * m);
  const img = new Float64Array(P * P);
  const line = new Float64Array(P);
  const res = new Float64Array(P);
  const v = new Int32Array(P);
  const z = new Float64Array(P + 1);
  const dir = new Vec3d();
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const isLand = (face: number, i: number, j: number) => height[(face * n + j) * n + i]! > 0;
  for (let face = 0; face < 6; face++) {
    // Land mask with a margin from the neighboring faces.
    for (let pj = 0; pj < P; pj++) {
      for (let pi = 0; pi < P; pi++) {
        const i = pi - margin;
        const j = pj - margin;
        let land: boolean;
        if (i >= 0 && i < n && j >= 0 && j < n) {
          land = isLand(face, i, j);
        } else {
          cubeFaceUvToDirection(face as CubeFace, (i + 0.5) / n, (j + 0.5) / n, dir);
          directionToCubeFace(dir, uv);
          const ii = Math.min(n - 1, Math.max(0, Math.floor(uv.u * n)));
          const jj = Math.min(n - 1, Math.max(0, Math.floor(uv.v * n)));
          land = isLand(uv.face, ii, jj);
        }
        img[pj * P + pi] = land ? 0 : INF;
      }
    }
    // Rows, then columns.
    for (let pj = 0; pj < P; pj++) {
      for (let pi = 0; pi < P; pi++) line[pi] = img[pj * P + pi]!;
      edt1d(line, P, res, v, z);
      for (let pi = 0; pi < P; pi++) img[pj * P + pi] = res[pi]!;
    }
    for (let pi = 0; pi < P; pi++) {
      for (let pj = 0; pj < P; pj++) line[pj] = img[pj * P + pi]!;
      edt1d(line, P, res, v, z);
      for (let pj = 0; pj < P; pj++) img[pj * P + pi] = res[pj]!;
    }
    for (let J = 0; J < m; J++) {
      for (let I = 0; I < m; I++) {
        const d2 = img[(J * step + margin) * P + I * step + margin]!;
        out[(face * m + J) * m + I] = Math.min(max, Math.sqrt(d2) * cell);
      }
    }
  }
  return out;
}

/** The field as a cube-face texture array (R16F), sampled by direction. */
export class CoastDistanceTexture {
  readonly texture: DataArrayTexture;
  private m = 1;

  constructor() {
    this.texture = CoastDistanceTexture.make(1);
  }

  private static make(m: number): DataArrayTexture {
    const t = new DataArrayTexture(new Uint16Array(6 * m * m), m, m, 6);
    t.format = RedFormat;
    t.type = HalfFloatType;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    return t;
  }

  /** Computes and uploads the field for a global height map (`n` cells per face edge). */
  setHeights(height: Float32Array, n: number, radius: number): void {
    const step = Math.max(1, Math.ceil(n / MAX_TEXELS));
    const field = coastDistanceField(height, n, radius, { step });
    const m = Math.floor(n / step);
    if (m !== this.m) {
      // Three does not reallocate a GPU texture whose image changes size (see ClimateTexture).
      this.m = m;
      this.texture.dispose();
      this.texture.image = { data: new Uint16Array(6 * m * m), width: m, height: m, depth: 6 };
    }
    const half = this.texture.image.data as Uint16Array;
    for (let i = 0; i < field.length; i++) half[i] = DataUtils.toHalfFloat(field[i]!);
    this.texture.needsUpdate = true;
  }

  /** Distance (m) from the sea to the nearest land at a direction; 0 on land. */
  sample(dir: V3): Node<'float'> {
    const { face, uv } = cubeFaceUv(dir);
    return texture(this.texture, uv).depth(face).level(int(0)).x as Node<'float'>;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
