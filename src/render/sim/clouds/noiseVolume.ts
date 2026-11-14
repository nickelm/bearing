/**
 * Tiling 3D noise for the volumetric clouds, fog and dust (decision 141): two
 * small volumes, generated on the CPU from an integer hash (no random numbers,
 * rule 5; no transcendental functions, so every machine gets the same bytes)
 * and uploaded as half-float RGBA 3D textures that repeat in every direction.
 * Half floats, not bytes: some GPUs filter 8-bit textures to 8-bit results,
 * and a cloud's density is a narrow range of the noise, so its edges came
 * out in steps (the software rasterizer the previews run on does).
 *
 * `shape`, 64³ (2 MiB), sampled at 10 km per tile (heaps of 1 to 2 km):
 *
 *   R  cloud shape: Perlin noise dilated by cellular noise, cut by a cellular
 *      fractal (three octaves), so heaps have rounded, cauliflower outlines
 *   G  the same field without the fine octaves: what R turns into where the
 *      march's steps are too long to resolve them
 *   B  Perlin fractal (three octaves): wisps, for fog banks, veils and cirrus
 *   A  a cellular fractal of finer cells: billows, for dust walls
 *
 * `detail`, 32³ (256 KiB), sampled at about 2.4 km per tile:
 *
 *   R  cellular fractal (three octaves): erodes cloud edges near the camera
 *   G  Perlin fractal (three octaves): fine wisps
 *   B  one octave of cells
 *   A  unused (1)
 *
 * R and G of `shape` are equalized: their values are spread evenly over
 * 0..1, so the share of the volume above a threshold 1 − c is c. The cloud
 * density thresholds them by the local coverage, and that makes the coverage
 * drawn follow the coverage asked for.
 *
 * Generation takes about 0.3 s (`generateShapeNoise`, `generateDetailNoise`)
 * and happens once, on first use (`cloudNoise`).
 */
import {
  Data3DTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RepeatWrapping,
  RGBAFormat,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { int, texture3D } from 'three/tsl';

type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** Voxels per edge of the shape volume. */
export const SHAPE_SIZE = 64;
/** Voxels per edge of the detail volume. */
export const DETAIL_SIZE = 32;

/** A 32-bit integer hash of a lattice point and a seed. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** The twelve edge directions of a cube: Perlin's gradients. */
const GRADIENTS = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
] as const;
const GRADIENT_TABLE = new Float32Array(GRADIENTS.flat());

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * One octave of gradient noise over a volume of `size`³ voxels, repeating
 * after `period` lattice cells per edge, added to `out` times `gain`.
 * Values are about −0.7..0.7.
 */
function addPerlin(
  out: Float32Array,
  size: number,
  period: number,
  seed: number,
  gain: number,
): void {
  // The gradient index of every lattice point of the period.
  const grad = new Uint8Array(period * period * period);
  for (let z = 0; z < period; z++)
    for (let y = 0; y < period; y++)
      for (let x = 0; x < period; x++)
        grad[(z * period + y) * period + x] = hash3(x, y, z, seed) % 12;
  const gx = GRADIENT_TABLE;
  const scale = period / size;
  for (let k = 0; k < size; k++) {
    const pz = (k + 0.5) * scale;
    const z0 = Math.floor(pz);
    const fz = pz - z0;
    const wz = fade(fz);
    const fz1 = fz - 1;
    const za = (z0 % period) * period;
    const zb = ((z0 + 1) % period) * period;
    for (let j = 0; j < size; j++) {
      const py = (j + 0.5) * scale;
      const y0 = Math.floor(py);
      const fy = py - y0;
      const wy = fade(fy);
      const fy1 = fy - 1;
      const ya = y0 % period;
      const yb = (y0 + 1) % period;
      for (let i = 0; i < size; i++) {
        const px = (i + 0.5) * scale;
        const x0 = Math.floor(px);
        const fx = px - x0;
        const wx = fade(fx);
        const xa = x0 % period;
        const xb = (x0 + 1) % period;
        const fx1 = fx - 1;
        let g = grad[(za + ya) * period + xa]! * 3;
        const n000 = gx[g]! * fx + gx[g + 1]! * fy + gx[g + 2]! * fz;
        g = grad[(za + ya) * period + xb]! * 3;
        const n100 = gx[g]! * fx1 + gx[g + 1]! * fy + gx[g + 2]! * fz;
        g = grad[(za + yb) * period + xa]! * 3;
        const n010 = gx[g]! * fx + gx[g + 1]! * fy1 + gx[g + 2]! * fz;
        g = grad[(za + yb) * period + xb]! * 3;
        const n110 = gx[g]! * fx1 + gx[g + 1]! * fy1 + gx[g + 2]! * fz;
        g = grad[(zb + ya) * period + xa]! * 3;
        const n001 = gx[g]! * fx + gx[g + 1]! * fy + gx[g + 2]! * fz1;
        g = grad[(zb + ya) * period + xb]! * 3;
        const n101 = gx[g]! * fx1 + gx[g + 1]! * fy + gx[g + 2]! * fz1;
        g = grad[(zb + yb) * period + xa]! * 3;
        const n011 = gx[g]! * fx + gx[g + 1]! * fy1 + gx[g + 2]! * fz1;
        g = grad[(zb + yb) * period + xb]! * 3;
        const n111 = gx[g]! * fx1 + gx[g + 1]! * fy1 + gx[g + 2]! * fz1;
        const a = n000 + (n100 - n000) * wx;
        const b = n010 + (n110 - n010) * wx;
        const c = n001 + (n101 - n001) * wx;
        const d = n011 + (n111 - n011) * wx;
        const lo = a + (b - a) * wy;
        const hi = c + (d - c) * wy;
        out[(k * size + j) * size + i]! += gain * (lo + (hi - lo) * wz);
      }
    }
  }
}

/**
 * One octave of inverted cellular (Worley) noise over `size`³ voxels,
 * repeating after `period` cells per edge, added to `out` times `gain`:
 * 1 at a cell's feature point, falling to 0 a cell's width away.
 */
function addWorley(
  out: Float32Array,
  size: number,
  period: number,
  seed: number,
  gain: number,
): void {
  // The feature point of every cell, in cell units from the volume's origin.
  const points = new Float32Array(period * period * period * 3);
  for (let z = 0; z < period; z++)
    for (let y = 0; y < period; y++)
      for (let x = 0; x < period; x++) {
        const h = hash3(x, y, z, seed);
        const o = ((z * period + y) * period + x) * 3;
        points[o] = x + (h & 0x3ff) / 1024;
        points[o + 1] = y + ((h >>> 10) & 0x3ff) / 1024;
        points[o + 2] = z + ((h >>> 20) & 0x3ff) / 1024;
      }
  const scale = period / size;
  // Squared distance to the nearest feature point; a point farther than one cell never wins.
  const nearest = new Float32Array(size * size * size).fill(4);
  // Each feature point reaches the voxels within one cell of it: loop over points, not voxels.
  const reach = Math.ceil(1 / scale);
  for (let z = 0; z < period; z++)
    for (let y = 0; y < period; y++)
      for (let x = 0; x < period; x++) {
        const o = ((z * period + y) * period + x) * 3;
        const fx = points[o]! / scale - 0.5;
        const fy = points[o + 1]! / scale - 0.5;
        const fz = points[o + 2]! / scale - 0.5;
        const k0 = Math.ceil(fz - reach);
        const k1 = Math.floor(fz + reach);
        const j0 = Math.ceil(fy - reach);
        const j1 = Math.floor(fy + reach);
        const i0 = Math.ceil(fx - reach);
        const i1 = Math.floor(fx + reach);
        for (let k = k0; k <= k1; k++) {
          const dz = (k - fz) * scale;
          const kk = ((k % size) + size) % size;
          for (let j = j0; j <= j1; j++) {
            const dy = (j - fy) * scale;
            const dzy = dz * dz + dy * dy;
            if (dzy >= 1) continue;
            const row = (kk * size + (((j % size) + size) % size)) * size;
            for (let i = i0; i <= i1; i++) {
              const dx = (i - fx) * scale;
              const d = dzy + dx * dx;
              const at = row + (((i % size) + size) % size);
              if (d < nearest[at]!) nearest[at] = d;
            }
          }
        }
      }
  for (let i = 0; i < nearest.length; i++) {
    out[i]! += gain * (1 - Math.min(1, Math.sqrt(nearest[i]!)));
  }
}

/** Replaces every value by its rank among all of them, 0..1: an even spread. */
function equalize(field: Float32Array): void {
  const bins = 4096;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of field) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const scale = (bins - 1) / Math.max(hi - lo, 1e-12);
  const counts = new Float64Array(bins + 1);
  for (const v of field) counts[Math.floor((v - lo) * scale) + 1]!++;
  for (let b = 1; b <= bins; b++) counts[b]! += counts[b - 1]!;
  const total = field.length;
  for (let i = 0; i < field.length; i++) {
    const x = (field[i]! - lo) * scale;
    const b = Math.floor(x);
    // Linear within the bin, so equal ranks stay rare.
    field[i] = (counts[b]! + (counts[b + 1]! - counts[b]!) * (x - b)) / total;
  }
}

function pack(size: number, channels: (Float32Array | null)[]): Uint16Array<ArrayBuffer> {
  const count = size * size * size;
  const data = new Uint16Array(count * 4);
  for (let c = 0; c < 4; c++) {
    const field = channels[c];
    for (let i = 0; i < count; i++) {
      const v = field ? field[i]! : 1;
      data[i * 4 + c] = DataUtils.toHalfFloat(Math.min(1, Math.max(0, v)));
    }
  }
  return data;
}

/** The shape volume's bytes: RGBA per voxel, x fastest (see the file comment). */
export function generateShapeNoise(size = SHAPE_SIZE, seed = 0x51ab): Uint16Array<ArrayBuffer> {
  const count = size * size * size;
  // Perlin, two octaves, about 0..1.
  const perlin = new Float32Array(count).fill(0.5);
  addPerlin(perlin, size, 3, seed + 1, 0.6);
  addPerlin(perlin, size, 6, seed + 2, 0.25);
  // Cells of a fifth, a tenth and a twentieth of the tile.
  const w4 = new Float32Array(count);
  const w8 = new Float32Array(count);
  const w16 = new Float32Array(count);
  addWorley(w4, size, 5, seed + 3, 1);
  addWorley(w8, size, 10, seed + 4, 1);
  addWorley(w16, size, 20, seed + 5, 1);
  const shape = new Float32Array(count);
  const smooth = new Float32Array(count);
  const billows = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Round puffs (the large cells) whose size and presence the Perlin field varies.
    const puffs = 0.7 * w4[i]! + 0.3 * w8[i]!;
    smooth[i] = 0.5 * perlin[i]! + 0.5 * puffs;
    // The finer cells bulge the outline: cauliflower.
    shape[i] = 0.42 * perlin[i]! + 0.36 * w4[i]! + 0.15 * w8[i]! + 0.07 * w16[i]!;
    billows[i] = 0.55 * w8[i]! + 0.45 * w16[i]!;
  }
  equalize(shape);
  equalize(smooth);
  const wisps = new Float32Array(count).fill(0.5);
  addPerlin(wisps, size, 4, seed + 6, 0.5);
  addPerlin(wisps, size, 8, seed + 7, 0.28);
  addPerlin(wisps, size, 16, seed + 8, 0.16);
  return pack(size, [shape, smooth, wisps, billows]);
}

/** The detail volume's bytes: RGBA per voxel, x fastest (see the file comment). */
export function generateDetailNoise(size = DETAIL_SIZE, seed = 0x7c35): Uint16Array<ArrayBuffer> {
  const count = size * size * size;
  const cells = new Float32Array(count);
  addWorley(cells, size, 3, seed + 1, 0.625);
  addWorley(cells, size, 6, seed + 2, 0.25);
  addWorley(cells, size, 12, seed + 3, 0.125);
  const wisps = new Float32Array(count).fill(0.5);
  addPerlin(wisps, size, 4, seed + 4, 0.5);
  addPerlin(wisps, size, 8, seed + 5, 0.3);
  addPerlin(wisps, size, 16, seed + 6, 0.15);
  const single = new Float32Array(count);
  addWorley(single, size, 4, seed + 7, 1);
  return pack(size, [cells, wisps, single, null]);
}

function volumeTexture(data: Uint16Array<ArrayBuffer>, size: number, name: string): Data3DTexture {
  const t = new Data3DTexture(data, size, size, size);
  t.name = name;
  t.format = RGBAFormat;
  t.type = HalfFloatType;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.wrapR = RepeatWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** The two noise volumes as textures. */
export class NoiseVolumes {
  readonly shape: Data3DTexture;
  readonly detail: Data3DTexture;

  constructor() {
    this.shape = volumeTexture(generateShapeNoise(), SHAPE_SIZE, 'cloud shape noise');
    this.detail = volumeTexture(generateDetailNoise(), DETAIL_SIZE, 'cloud detail noise');
  }

  /** The shape volume at a position in tiles (it repeats every 1); usable inside loops. */
  sampleShape(uvw: V3): V4 {
    return texture3D(this.shape, uvw).level(int(0)) as unknown as V4;
  }

  /** The detail volume at a position in tiles. */
  sampleDetail(uvw: V3): V4 {
    return texture3D(this.detail, uvw).level(int(0)) as unknown as V4;
  }

  dispose(): void {
    this.shape.dispose();
    this.detail.dispose();
  }
}

let shared: NoiseVolumes | null = null;

/**
 * The noise volumes every cloud layer and volumetric source shares, generated
 * on first use. The data is the same on every call and every machine.
 */
export function cloudNoise(): NoiseVolumes {
  return (shared ??= new NoiseVolumes());
}
