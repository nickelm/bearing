/**
 * Urban extents as a cube-face coverage texture for the map's urban fill (visual-style
 * Part II, Settlements and Infrastructure; decision 104): one R8 layer per face at
 * URBAN_TEXTURE_SIZE², 255 where a settlement's urban polygon covers the texel, with
 * fractional coverage from 4 × 4 samples per texel at the polygon's edge. The relief
 * shader blends the urban fill by it under the hillshade, so towns take the relief,
 * the territory tint and the night like the land around them.
 *
 * Each polygon is rasterized on every face one of its vertices falls on, projected
 * onto that face (projectToCubeFace), so towns on a face seam are whole.
 *
 * The map draws towns larger than life (Part II principle 1; decision 105): each
 * polygon is scaled about its center by URBAN_MAP_SCALE, and at least to a mean radius
 * of URBAN_MIN_TEXELS texels, so villages show as small patches instead of a faint
 * smudge under a texel.
 */
import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { int, texture } from 'three/tsl';
import { directionToFace, projectToCubeFace } from '../../../core/coords';
import type { CubeFace } from '../../../core/coords';
import { Vec3d } from '../../../core/vec3d';
import { URBAN_VERTICES } from '../../../worldgen/strategic/graph';
import type { UrbanExtents } from '../../../worldgen/strategic/graph';
import { cubeFaceUv } from '../../common/climateTexture';

type V3 = Node<'vec3'>;

/** Texels per face edge: about 0.8 km on a 1,000 km planet. */
export const URBAN_TEXTURE_SIZE = 2048;
const SAMPLES = 4;
/** Scale of urban polygons on the map, about their centers. */
export const URBAN_MAP_SCALE = 1.6;
/** Least mean radius of a drawn urban polygon (texels). */
export const URBAN_MIN_TEXELS = 1.6;

/** Coverage texels (6 · n², face · n² + j · n + i) of every urban polygon. */
export function urbanTexels(
  urban: UrbanExtents,
  n = URBAN_TEXTURE_SIZE,
  scale = URBAN_MAP_SCALE,
  minTexels = URBAN_MIN_TEXELS,
): Uint8Array {
  const out = new Uint8Array(6 * n * n);
  const K = URBAN_VERTICES;
  const count = urban.points.length / (K * 3);
  const d = new Vec3d();
  const uv = { face: 0 as CubeFace, u: 0, v: 0 };
  const xs = new Float64Array(K);
  const ys = new Float64Array(K);
  const pts = new Float64Array(K * 3);
  const minAngle = (minTexels * Math.PI) / 2 / n;
  const P = urban.points;
  for (let p = 0; p < count; p++) {
    // Scale about the center: larger than life, and at least minTexels in radius.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < K; k++) {
      const o = (p * K + k) * 3;
      cx += P[o]!;
      cy += P[o + 1]!;
      cz += P[o + 2]!;
    }
    const cl = Math.hypot(cx, cy, cz) || 1;
    cx /= cl;
    cy /= cl;
    cz /= cl;
    let mean = 0;
    for (let k = 0; k < K; k++) {
      const o = (p * K + k) * 3;
      mean += Math.hypot(P[o]! - cx, P[o + 1]! - cy, P[o + 2]! - cz) / K;
    }
    const f = Math.max(scale, minAngle / Math.max(mean, 1e-12));
    const faces = new Set<CubeFace>();
    for (let k = 0; k < K; k++) {
      const o = (p * K + k) * 3;
      d.set(cx + (P[o]! - cx) * f, cy + (P[o + 1]! - cy) * f, cz + (P[o + 2]! - cz) * f);
      d.normalize();
      pts[k * 3] = d.x;
      pts[k * 3 + 1] = d.y;
      pts[k * 3 + 2] = d.z;
      faces.add(directionToFace(d));
    }
    for (const face of faces) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < K; k++) {
        projectToCubeFace(d.set(pts[k * 3]!, pts[k * 3 + 1]!, pts[k * 3 + 2]!), face, uv);
        xs[k] = uv.u * n;
        ys[k] = uv.v * n;
        x0 = Math.min(x0, xs[k]!);
        x1 = Math.max(x1, xs[k]!);
        y0 = Math.min(y0, ys[k]!);
        y1 = Math.max(y1, ys[k]!);
      }
      const i0 = Math.max(0, Math.floor(x0));
      const i1 = Math.min(n - 1, Math.floor(x1));
      const j0 = Math.max(0, Math.floor(y0));
      const j1 = Math.min(n - 1, Math.floor(y1));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          let inside = 0;
          for (let sj = 0; sj < SAMPLES; sj++) {
            const y = j + (sj + 0.5) / SAMPLES;
            for (let si = 0; si < SAMPLES; si++) {
              const x = i + (si + 0.5) / SAMPLES;
              // Even-odd rule.
              let odd = false;
              for (let a = 0, b = K - 1; a < K; b = a++) {
                const ya = ys[a]!;
                const yb = ys[b]!;
                if (ya > y !== yb > y && x < ((xs[b]! - xs[a]!) * (y - ya)) / (yb - ya) + xs[a]!)
                  odd = !odd;
              }
              if (odd) inside++;
            }
          }
          if (inside === 0) continue;
          const t = face * n * n + j * n + i;
          out[t] = Math.max(out[t]!, Math.round((255 * inside) / (SAMPLES * SAMPLES)));
        }
      }
    }
  }
  return out;
}

export class UrbanTexture {
  readonly texture: DataArrayTexture;

  constructor() {
    const t = new DataArrayTexture(new Uint8Array(6), 1, 1, 6);
    t.format = RedFormat;
    t.type = UnsignedByteType;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.texture = t;
  }

  /** Replaces the extents in place (null clears them), keeping materials valid. */
  set(urban: UrbanExtents | null, n = URBAN_TEXTURE_SIZE): void {
    const size = urban ? n : 1;
    const data = urban ? urbanTexels(urban, n) : new Uint8Array(6);
    const img = this.texture.image as { width: number };
    if (img.width !== size) this.texture.dispose();
    this.texture.image = { data, width: size, height: size, depth: 6 };
    this.texture.needsUpdate = true;
  }

  /** Urban coverage 0..1 at a direction (need not be normalized). */
  sample(dir: V3): Node<'float'> {
    const { face, uv } = cubeFaceUv(dir);
    return texture(this.texture, uv).depth(face).level(int(0)).x as Node<'float'>;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
