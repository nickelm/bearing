/**
 * The cast's territory as a cube-face array texture for the map's territory tint
 * (visual-style Part II, Military Overlays; decision 101): one RGBA8 layer per face at
 * the strategic graph's coarse resolution, with the Alliance's share in red, the Pact's
 * in green and neutral land's in blue, sampled by direction like the habitability map.
 *
 * Sea cells take the holder of the nearest land within `COAST_SPREAD` cells, so linear
 * filtering does not thin the tint along coasts; the relief shader tints dry land only,
 * so the spread never shows at sea.
 */
import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  LinearFilter,
  RGBAFormat,
  UnsignedByteType,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { int, texture } from 'three/tsl';
import type { CubeGrid } from '../../../core/cubeGrid';
import { cubeFaceUv } from '../../common/climateTexture';

type V3 = Node<'vec3'>;

/** Cells the holder spreads over the sea. */
export const COAST_SPREAD = 3;

/**
 * RGBA8 texels from a TERRITORY_* raster (−1 sea, 0 neutral, 1 Alliance, 2 Pact):
 * 255 in the holder's channel, sea cells spread from the nearest land.
 */
export function territoryTexels(owner: Int8Array, grid: CubeGrid): Uint8Array {
  const n = grid.cellCount;
  const code = Int8Array.from(owner);
  let frontier: number[] = [];
  for (let c = 0; c < n; c++) if (code[c]! >= 0) frontier.push(c);
  for (let step = 0; step < COAST_SPREAD && frontier.length; step++) {
    const next: number[] = [];
    for (const c of frontier) {
      for (let k = 0; k < 8; k++) {
        const x = grid.neighbors8[c * 8 + k]!;
        if (x < 0 || code[x]! >= 0) continue;
        code[x] = code[c]!;
        next.push(x);
      }
    }
    frontier = next;
  }
  const out = new Uint8Array(n * 4);
  for (let c = 0; c < n; c++) {
    const v = code[c]!;
    if (v === 1) out[c * 4] = 255;
    else if (v === 2) out[c * 4 + 1] = 255;
    else if (v === 0) out[c * 4 + 2] = 255;
  }
  return out;
}

export class TerritoryTexture {
  readonly texture: DataArrayTexture;

  constructor() {
    const t = new DataArrayTexture(new Uint8Array(4 * 6), 1, 1, 6);
    t.format = RGBAFormat;
    t.type = UnsignedByteType;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.texture = t;
  }

  /** Replaces the territory in place (null clears it), keeping materials that sample it valid. */
  set(owner: Int8Array | null, grid: CubeGrid | null): void {
    const n = owner && grid && owner.length === grid.cellCount ? grid.n : 1;
    const data = owner && grid && n > 1 ? territoryTexels(owner, grid) : new Uint8Array(4 * 6);
    const img = this.texture.image as { width: number };
    if (img.width !== n) this.texture.dispose();
    this.texture.image = { data, width: n, height: n, depth: 6 };
    this.texture.needsUpdate = true;
  }

  /** Alliance, Pact and neutral shares (0..1) at a direction (need not be normalized). */
  sample(dir: V3): Node<'vec4'> {
    const { face, uv } = cubeFaceUv(dir);
    return texture(this.texture, uv).depth(face).level(int(0)) as Node<'vec4'>;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
