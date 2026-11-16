/**
 * The strategic graph's habitability map (decision 65) as a cube-face array
 * texture, one R8 layer per face at the coarse grid's resolution, sampled by
 * direction like the climate texture (decision 42). The terrain uses it for
 * the rural night glow between towns; the strategic map places farmland with it
 * (decision 80).
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
import { cubeFaceUv } from './climateTexture';
import { directionToCubeFace } from '../../core/coords';
import type { Vec3d } from '../../core/vec3d';

type V3 = Node<'vec3'>;

export class HabitabilityTexture {
  readonly texture: DataArrayTexture;

  /** `cells` holds 6 · n² values, cell index = face · n² + j · n + i. */
  constructor(cells: Uint8Array | null, n: number) {
    const data = cells && cells.length === 6 * n * n ? cells : new Uint8Array(6 * n * n);
    const t = new DataArrayTexture(data, n, n, 6);
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

  /**
   * Replaces the map in place, so materials that sample this texture keep working
   * (three does not reallocate a GPU texture whose image changes size: free it first).
   */
  set(cells: Uint8Array | null, n: number): void {
    const data = cells && cells.length === 6 * n * n ? cells : new Uint8Array(6 * n * n);
    const img = this.texture.image as { width: number };
    if (img.width !== n) this.texture.dispose();
    this.texture.image = { data, width: n, height: n, depth: 6 };
    this.texture.needsUpdate = true;
  }

  /** Habitability 0..1 at a direction (need not be normalized). */
  sample(dir: V3): Node<'float'> {
    const { face, uv } = cubeFaceUv(dir);
    return texture(this.texture, uv).depth(face).level(int(0)).x as Node<'float'>;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * `HabitabilityTexture.sample` on the CPU (decision 162): habitability 0..1 at a
 * direction, bilinear between cell centers and clamped at face edges as the GPU
 * filters it. `cells` holds 6 · n² bytes, cell index = face · n² + j · n + i.
 */
export function habitabilityAt(cells: Uint8Array, n: number, dir: Readonly<Vec3d>): number {
  if (cells.length !== 6 * n * n) return 0;
  const { face, u, v } = directionToCubeFace(dir);
  const x = Math.min(n - 1, Math.max(0, u * n - 0.5));
  const y = Math.min(n - 1, Math.max(0, v * n - 0.5));
  const x0 = Math.min(Math.max(n - 2, 0), Math.floor(x));
  const y0 = Math.min(Math.max(n - 2, 0), Math.floor(y));
  const tx = n > 1 ? x - x0 : 0;
  const ty = n > 1 ? y - y0 : 0;
  const at = (i: number, j: number) =>
    cells[face * n * n + Math.min(j, n - 1) * n + Math.min(i, n - 1)]! / 255;
  return (
    (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
    (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
  );
}
