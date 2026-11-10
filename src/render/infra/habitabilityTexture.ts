/**
 * The strategic graph's habitability map (decision 65) as a cube-face array
 * texture, one R8 layer per face at the coarse grid's resolution, sampled by
 * direction like the climate texture (decision 42). The terrain uses it for
 * the rural night glow between towns.
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
import { cubeFaceUv } from '../climateTexture';

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

  /** Habitability 0..1 at a direction (need not be normalized). */
  sample(dir: V3): Node<'float'> {
    const { face, uv } = cubeFaceUv(dir);
    return texture(this.texture, uv).depth(face).level(int(0)).x as Node<'float'>;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
