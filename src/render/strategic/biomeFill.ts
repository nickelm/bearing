/**
 * The strategic map's land colors (visual-style Part II, Strategic Palette;
 * decision 79): one fill per biome, painted into a cube-face texture and sampled
 * by direction, so biome boundaries blend over a few kilometers at any zoom.
 *
 * - **Resolution.** Two global cells per texel along each axis (1024² cells per face
 *   give 512² texels of about 3 km on the 1,000 km planet).
 * - **Blend.** Each texel averages the fills of its land cells; a 3 × 3 tent filter
 *   (weights 1-2-1) widens that to about 9 km, and bilinear sampling smooths it
 *   between texels. Sea cells carry no weight, so coasts keep their land color.
 * - **Sea texels.** Texels with no land in reach take their neighbors' color by
 *   dilation, so bilinear filtering at the coast never mixes in a sea color; the
 *   shader draws water there anyway.
 * - **Seams.** The filter stays within a face and the sampler clamps at face edges;
 *   the fills are smooth at 9 km, so the step across a cube seam is slight.
 *
 * Colors are linear RGB in a half-float `DataArrayTexture`, laid out like the
 * climate texture (face-major, row j, column i). Alpha holds farmability (decision 80):
 * the blended share of open lowland biomes where fields may lie.
 */
import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { int, texture } from 'three/tsl';
import { Biome, BIOME_COUNT } from '../../worldgen/biomes';
import { cubeFaceUv } from '../common/climateTexture';
import { srgbToLinear } from '../common/palette';

type V3 = Node<'vec3'>;

/**
 * Part II land fills (sRGB hex) per biome; null for sea biomes. The guide has no
 * shrubland row: its fill is the midpoint of grassland and savanna. Alpine terrain
 * takes the steep-rock fill. Farmland, wetland and urban fills wait for data that
 * marks them (S4).
 */
export const STRATEGIC_BIOME_FILL: readonly (number | null)[] = (() => {
  const f: (number | null)[] = new Array<number | null>(BIOME_COUNT).fill(null);
  f[Biome.IceSheet] = 0xf1f3f2;
  f[Biome.Tundra] = 0xb1ad94;
  f[Biome.Taiga] = 0x5e7a5c;
  f[Biome.TemperateGrassland] = 0xa3ae78;
  f[Biome.TemperateForest] = 0x6e8a5a;
  f[Biome.TemperateRainforest] = 0x5f8a55;
  f[Biome.ColdDesert] = 0xdcc195;
  f[Biome.HotDesert] = 0xdcc195;
  f[Biome.Shrubland] = 0xb3b27b;
  f[Biome.Savanna] = 0xc2b57e;
  f[Biome.TropicalSeasonalForest] = 0x6e8a5a;
  f[Biome.TropicalRainforest] = 0x5f8a55;
  f[Biome.Alpine] = 0x9c948a;
  return f;
})();

/** Steep-rock fill (sRGB), blended in by the shader on steep displayed slopes. */
export const STEEP_ROCK_FILL = 0x9c948a;
/** Fallback for texels with no land anywhere near: grassland. */
const FALLBACK = 0xa3ae78;

/** Linear RGB of an sRGB hex color. */
export function hexToLinear(h: number): [number, number, number] {
  return [
    srgbToLinear(((h >> 16) & 255) / 255),
    srgbToLinear(((h >> 8) & 255) / 255),
    srgbToLinear((h & 255) / 255),
  ];
}

/**
 * Biomes where farmland can lie (decision 80): open and lightly wooded lowland
 * biomes. The alpha channel carries this, blended like the colors, and the shader
 * multiplies it with habitability to place fields.
 */
const FARMABLE: ReadonlySet<number> = new Set([
  Biome.TemperateGrassland,
  Biome.TemperateForest,
  Biome.Shrubland,
  Biome.Savanna,
  Biome.TropicalSeasonalForest,
]);

/** Linear RGB and farmability per biome; null for sea biomes. */
const FILL_LINEAR = STRATEGIC_BIOME_FILL.map((h, b) =>
  h === null ? null : ([...hexToLinear(h), FARMABLE.has(b) ? 1 : 0] as const),
);

/**
 * Linear RGB texels of the blended fill, with farmability in alpha, for a biome map of `n` cells per
 * face edge, at `n / factor` texels per face edge.
 */
export function biomeFillTexels(biome: Uint8Array, n: number, factor = 2): Float32Array {
  const m = Math.max(1, Math.floor(n / factor));
  const T = 6 * m * m;
  // 1. Land-weighted sums per texel.
  const sum = new Float64Array(T * 4);
  const w = new Float64Array(T);
  for (let face = 0; face < 6; face++) {
    for (let j = 0; j < n; j++) {
      const J = Math.min(m - 1, Math.floor(j / factor));
      for (let i = 0; i < n; i++) {
        const c = FILL_LINEAR[biome[(face * n + j) * n + i]!];
        if (!c) continue;
        const I = Math.min(m - 1, Math.floor(i / factor));
        const t = (face * m + J) * m + I;
        for (let k = 0; k < 4; k++) sum[t * 4 + k] += c[k]!;
        w[t]! += 1;
      }
    }
  }
  // 2. 3 × 3 tent filter within each face (separable, clamped at the edges).
  const blur = (src: Float64Array, srcW: Float64Array, horizontal: boolean) => {
    const out = new Float64Array(src.length);
    const outW = new Float64Array(srcW.length);
    for (let face = 0; face < 6; face++) {
      for (let J = 0; J < m; J++) {
        for (let I = 0; I < m; I++) {
          const t = (face * m + J) * m + I;
          for (const [d, k] of [
            [-1, 1],
            [0, 2],
            [1, 1],
          ] as const) {
            const II = horizontal ? Math.min(m - 1, Math.max(0, I + d)) : I;
            const JJ = horizontal ? J : Math.min(m - 1, Math.max(0, J + d));
            const s = (face * m + JJ) * m + II;
            for (let ch = 0; ch < 4; ch++) out[t * 4 + ch] += src[s * 4 + ch]! * k;
            outW[t]! += srcW[s]! * k;
          }
        }
      }
    }
    return { out, outW };
  };
  const h = blur(sum, w, true);
  const v = blur(h.out, h.outW, false);
  // 3. Normalize; texels without land wait for dilation.
  const rgba = new Float32Array(T * 4);
  const known = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    const wt = v.outW[t]!;
    if (wt <= 0) continue;
    for (let ch = 0; ch < 4; ch++) rgba[t * 4 + ch] = v.out[t * 4 + ch]! / wt;
    known[t] = 1;
  }
  // 4. Dilate land colors a few texels out to sea, then fall back to grassland.
  for (let pass = 0; pass < 4; pass++) {
    const next = known.slice();
    for (let face = 0; face < 6; face++) {
      for (let J = 0; J < m; J++) {
        for (let I = 0; I < m; I++) {
          const t = (face * m + J) * m + I;
          if (known[t]) continue;
          const acc = [0, 0, 0, 0];
          let k = 0;
          for (const [di, dj] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const II = I + di;
            const JJ = J + dj;
            if (II < 0 || JJ < 0 || II >= m || JJ >= m) continue;
            const s = (face * m + JJ) * m + II;
            if (!known[s]) continue;
            for (let ch = 0; ch < 4; ch++) acc[ch]! += rgba[s * 4 + ch]!;
            k++;
          }
          if (k === 0) continue;
          for (let ch = 0; ch < 4; ch++) rgba[t * 4 + ch] = acc[ch]! / k;
          next[t] = 1;
        }
      }
    }
    known.set(next);
  }
  const fallback = [...hexToLinear(FALLBACK), 0];
  for (let t = 0; t < T; t++) {
    if (known[t]) continue;
    for (let ch = 0; ch < 4; ch++) rgba[t * 4 + ch] = fallback[ch]!;
  }
  return rgba;
}

/** The blended fill as a cube-face texture array. */
export class BiomeFillTexture {
  readonly texture: DataArrayTexture;
  private m = 1;

  constructor() {
    this.texture = BiomeFillTexture.make(1);
    const g = hexToLinear(FALLBACK);
    this.fill(new Float32Array(6 * 4).map((_, i) => [g[0], g[1], g[2], 0][i % 4]!));
  }

  private static make(m: number): DataArrayTexture {
    const t = new DataArrayTexture(new Uint16Array(6 * m * m * 4), m, m, 6);
    t.format = RGBAFormat;
    t.type = HalfFloatType;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    return t;
  }

  private fill(texels: Float32Array): void {
    const half = this.texture.image.data as Uint16Array;
    for (let i = 0; i < texels.length; i++) half[i] = DataUtils.toHalfFloat(texels[i]!);
    this.texture.needsUpdate = true;
  }

  /** Loads a world's biome map (`n` cells per face edge). */
  setBiomes(biome: Uint8Array, n: number, factor = 2): void {
    const m = Math.max(1, Math.floor(n / factor));
    if (m !== this.m) {
      // Three does not reallocate a GPU texture whose image changes size (see ClimateTexture).
      this.m = m;
      this.texture.dispose();
      this.texture.image = { data: new Uint16Array(6 * m * m * 4), width: m, height: m, depth: 6 };
    }
    this.fill(biomeFillTexels(biome, n, factor));
  }

  /** Linear land fill (rgb) and farmability (a) at a direction. */
  sample(dir: V3): Node<'vec4'> {
    const { face, uv } = cubeFaceUv(dir);
    return texture(this.texture, uv).depth(face).level(int(0)) as Node<'vec4'>;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
