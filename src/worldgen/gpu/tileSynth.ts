/**
 * Tile synthesis (decisions 13, 24, 28): heights and materials for any tile
 * key, as a pure function of each sample's direction on the sphere.
 *
 *   h(dir) = global(dir)                    bicubic eroded global height
 *          + detail(dir) · fade             ridged / fBm octaves below the global cell size,
 *                                           amplitude from uplift, roughness exponent H
 *          + gullies(dir) · fade            erosion filter: 3D Gabor waves across the slope,
 *                                           so gullies run downhill, depth ∝ slope · wavelength
 *   then min(h, river banks)                channels from the smoothed vector rivers
 *
 * `fade` goes to zero on floodplains, so river valleys stay smooth. Octaves
 * are added while their wavelength stays above two sample spacings (and
 * above MIN_WAVELENGTH, the finest baked detail), so coarse tiles are a
 * low-pass version of fine ones. Tiles at or above the global grid's level
 * get no octaves at all: that is the "bake global maps into tiles" case.
 *
 * Because every input (global maps, rivers, noise tables) is fixed per world
 * and a sample's face coordinate comes from its integer global index,
 * neighboring tiles agree exactly on shared samples within a face, and to
 * float rounding across face seams, in any generation order.
 *
 * Output per tile, TILE_STRIDE² samples (row-major from the border corner):
 *   height   f32, physical meters above sea level
 *   material u32: biome | river coverage (0..255) << 8 | lake << 16
 */
import { Noise3 } from '../../core/noise';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import { TILE_BORDER, TILE_STRIDE, TILE_TEXELS } from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { RIVER_INDEX_LEVEL, RIVER_SEGMENT_FIELDS, RiverIndex } from '../riverIndex';
import type { GlobalGrid } from './globalGrid';
import { WORKGROUP_SIZE } from './gpuContext';
import { bicubicSamplerWgsl } from './gridWgsl';
import { NOISE_WGSL, packPermutations } from './noiseWgsl';

export const TILE_SYNTH_TUNING = {
  /** First detail octave, in global cells: just below what the global grid resolves (the detail stage covers 3+ cells). */
  firstOctaveCells: 1.5,
  /** Finest baked detail wavelength (m); finer detail is the renderer's job. */
  minWavelength: 100,
  /** Roughness exponent: octave amplitude ∝ wavelength^H. */
  roughness: 0.8,
  /** Detail amplitude of the first octave (reference m) on plains, and per meter of uplift. */
  detailPlains: 25,
  detailPerUplift: 0.05,
  /** Gully depth per (slope × wavelength). */
  gullies: 0.06,
  /** Floodplain half-width in channel widths, and at least this many meters. */
  floodplainWidths: 8,
  floodplainMin: 250,
  /** Rise of the valley floor away from the bank (m per m). */
  bankSlope: 0.04,
  /** Distance (m) beyond which a river no longer shapes the terrain. */
  riverReach: 2500,
};

/** Deepest level with baked tiles (about 48 m samples at R = 1,000 km). */
export const MAX_BAKED_LEVEL = 7;

export interface TileData {
  key: TileKey;
  /** TILE_STRIDE² physical heights (m). */
  height: Float32Array;
  /** TILE_STRIDE² packed materials (see module doc). */
  material: Uint32Array;
  minHeight: number;
  maxHeight: number;
}

export interface TileSynthOptions {
  seed: WorldSeed;
  reliefScale: number;
  radius: number;
  /** Biome per global cell. */
  biome: Uint8Array;
  /** Lake depth per global cell (m). */
  lakeDepth: Float32Array;
  index: RiverIndex;
  tuning?: Partial<typeof TILE_SYNTH_TUNING>;
}

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));
const SAMPLES = TILE_STRIDE * TILE_STRIDE;

/** Sample spacing (m) at a level. */
export function sampleSpacing(level: number, radius: number): number {
  return ((Math.PI / 2) * radius) / (TILE_TEXELS * (1 << level));
}

export class TileSynthesizer {
  readonly tuning: typeof TILE_SYNTH_TUNING;
  private readonly pipeline: GPUComputePipeline;
  private readonly perm: GPUBuffer;
  private readonly material: GPUBuffer;
  private readonly firstWavelength: number;

  constructor(
    private readonly grid: GlobalGrid,
    private readonly opts: TileSynthOptions,
  ) {
    const t = (this.tuning = { ...TILE_SYNTH_TUNING, ...opts.tuning });
    const gpu = grid.gpu;
    const R = opts.radius;
    this.firstWavelength = (t.firstOctaveCells * ((Math.PI / 2) * R)) / grid.n;

    const r = rng(opts.seed, 'tiles');
    this.perm = gpu.storageFrom(
      packPermutations([new Noise3(r.fork('detail')), new Noise3(r.fork('gullies'))]),
      'tiles.perm',
    );
    const packed = new Uint32Array(grid.cellCount);
    for (let c = 0; c < packed.length; c++) {
      packed[c] = opts.biome[c]! | (opts.lakeDepth[c]! > 0 ? 1 << 16 : 0);
    }
    this.material = gpu.storageFrom(packed, 'tiles.globalMaterial');

    const code = /* wgsl */ `${grid.wgsl}
struct Tile { face: i32, level: i32, x: i32, y: i32, segStart: u32, segCount: u32, octaves: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> perm: array<u32>;
@group(0) @binding(1) var<storage, read> gHeight: array<f32>;
@group(0) @binding(2) var<storage, read> gUplift: array<f32>;
@group(0) @binding(3) var<storage, read> gMaterial: array<u32>;
@group(0) @binding(4) var<storage, read> segs: array<f32>;
@group(0) @binding(5) var<storage, read> tiles: array<Tile>;
@group(0) @binding(6) var<storage, read_write> outHeight: array<f32>;
@group(0) @binding(7) var<storage, read_write> outMaterial: array<u32>;
${NOISE_WGSL}
${bicubicSamplerWgsl('sampleHeight', 'gHeight')}
${bicubicSamplerWgsl('sampleUplift', 'gUplift')}

const R: f32 = ${f(R)};
const RELIEF: f32 = ${f(opts.reliefScale)};
const STRIDE: i32 = ${TILE_STRIDE};
const BORDER: i32 = ${TILE_BORDER};
const TEXELS: f32 = ${f(TILE_TEXELS)};
const LAMBDA0: f32 = ${f(this.firstWavelength)};
const SEG_FIELDS: u32 = ${RIVER_SEGMENT_FIELDS}u;
const TWO_PI: f32 = 6.283185307;

fn heightAt(d: vec3f) -> f32 {
  let face = dirFace(d);
  let uv = projectToFace(d, face);
  return sampleHeight(face, uv.x, uv.y);
}
fn upliftAt(d: vec3f) -> f32 {
  let face = dirFace(d);
  let uv = projectToFace(d, face);
  return sampleUplift(face, uv.x, uv.y);
}

fn pcg3(v0: vec3u) -> vec3u {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

// Erosion filter: Gabor waves varying along t (across the slope), on a jittered 3D lattice.
fn gully(q: vec3f, t: vec3f, salt: u32) -> f32 {
  let cell = floor(q);
  var sum = 0.0;
  var wsum = 0.0;
  for (var k = 0; k < 27; k++) {
    let o = vec3f(f32(k % 3 - 1), f32((k / 3) % 3 - 1), f32(k / 9 - 1));
    let lc = cell + o;
    let h = pcg3(bitcast<vec3u>(vec3i(lc)) + vec3u(salt));
    let jitter = vec3f(h & vec3u(0xffffu)) / 65535.0;
    let dlt = q - (lc + jitter);
    let w = exp(-2.0 * dot(dlt, dlt));
    sum += w * cos(TWO_PI * dot(dlt, t));
    wsum += w;
  }
  return sum / max(wsum, 1e-6);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let id = i32(gid.x);
  if (id >= STRIDE * STRIDE) { return; }
  let tile = tiles[gid.z];
  let sx = id % STRIDE - BORDER;
  let sy = id / STRIDE - BORDER;
  let denom = TEXELS * f32(1u << u32(tile.level));
  let u = f32(tile.x * ${TILE_TEXELS} + sx) / denom;
  let v = f32(tile.y * ${TILE_TEXELS} + sy) / denom;
  let d = faceUvDir(tile.face, u, v);
  let slot = gid.z * u32(STRIDE * STRIDE) + u32(id);

  let base = heightAt(d);
  var h = base;
  // Biome from the global cell under a noise-jittered position (about one cell),
  // so biome borders are organic rather than 1.5 km steps.
  let cellAngle = 2.0 * QUARTER_PI / f32(N);
  var jit = vec3f(0.0);
  var jf = R / (1.5 * LAMBDA0);
  var ja = 0.8;
  for (var o = 0; o < 3; o++) {
    let jq = d * jf;
    jit += ja * vec3f(noise3(jq, 512u), noise3(jq + vec3f(31.7, 0.0, 0.0), 512u), noise3(jq + vec3f(0.0, 47.3, 0.0), 512u));
    jf *= 2.7;
    ja *= 0.55;
  }
  let mat = gMaterial[dirCell(normalize(d + 1.4 * cellAngle * jit))];
  var riverCover = 0.0;

  if (base > 0.0) {
    // Rivers: the nearest channel (relative to its floodplain) shapes the terrain.
    var nearest = 1.0e9;
    var bestDist = 1.0e9;
    var bestWidth = 0.0;
    var bestPoint = d;
    for (var s = 0u; s < tile.segCount; s++) {
      let o = (tile.segStart + s) * SEG_FIELDS;
      let a = vec3f(segs[o], segs[o + 1u], segs[o + 2u]);
      let b = vec3f(segs[o + 3u], segs[o + 4u], segs[o + 5u]);
      let ab = b - a;
      let tt = clamp(dot(d - a, ab) / max(dot(ab, ab), 1e-20), 0.0, 1.0);
      let p = a + tt * ab;
      let dist = length(d - p) * R;
      let w = mix(segs[o + 6u], segs[o + 7u], tt);
      let plain = max(${f(t.floodplainMin)}, ${f(t.floodplainWidths)} * w);
      riverCover = max(riverCover, clamp(1.0 - dist / max(0.5 * w, 1.0), 0.0, 1.0));
      if (dist / plain < nearest) {
        nearest = dist / plain;
        bestDist = dist;
        bestWidth = w;
        bestPoint = p;
      }
    }
    let fade = smoothstep(0.0, 1.0, nearest);
    var carve = 1.0e9;
    var reachW = 0.0;
    if (bestDist < ${f(t.riverReach)}) {
      // The water surface follows the smooth global height under the channel.
      let surf = heightAt(normalize(bestPoint)) - 0.5;
      let half = 0.5 * bestWidth;
      let depth = 1.0 + 0.02 * bestWidth;
      if (bestDist < half) {
        let x = bestDist / half;
        carve = surf - depth * (1.0 - x * x);
      } else {
        carve = surf + (bestDist - half) * ${f(t.bankSlope)};
      }
      reachW = 1.0 - smoothstep(0.6 * ${f(t.riverReach)}, ${f(t.riverReach)}, bestDist);
    }

    // Detail octaves.
    let up = upliftAt(d);
    let mountain = smoothstep(500.0, 2500.0, up);
    let a0 = ${f(t.detailPlains)} + ${f(t.detailPerUplift)} * max(up, 0.0);
    var detail = 0.0;
    var lambda = LAMBDA0;
    for (var o = 0u; o < tile.octaves; o++) {
      let q = d * (R / lambda) + f32(o) * vec3f(17.31, 9.17, 3.71);
      let n = noise3(q, 0u);
      let ridge = 0.45 - 2.0 * abs(n);
      detail += a0 * pow(lambda / LAMBDA0, ${f(t.roughness)}) * mix(n, ridge, mountain);
      lambda *= 0.5;
    }

    // Gullies across the global slope.
    var gullies = 0.0;
    let e0 = normalize(cross(vec3f(0.0, 1.0, 0.0), d) + vec3f(1e-7, 0.0, 0.0));
    let n0 = cross(d, e0);
    let dl = 0.5 * QUARTER_PI * 2.0 / f32(N);
    let he = heightAt(normalize(d + dl * e0)) - heightAt(normalize(d - dl * e0));
    let hn = heightAt(normalize(d + dl * n0)) - heightAt(normalize(d - dl * n0));
    let grad = (he * e0 + hn * n0) / (2.0 * dl * R);
    let slope = length(grad);
    if (slope > 1e-5) {
      let across = cross(d, grad / slope);
      lambda = LAMBDA0;
      for (var o = 0u; o < tile.octaves; o++) {
        let q = d * (R / lambda);
        gullies += ${f(t.gullies)} * slope * lambda * gully(q, across, o * 7919u);
        lambda *= 0.5;
      }
    }

    h = base + (detail * RELIEF + gullies) * fade;
    // Rivers shape the terrain within reach; carving never raises it.
    h = mix(h, min(h, carve), reachW);
    // Coastal plains stay land, so detail does not pepper the coast with islands.
    h = select(h, max(h, 0.05), base > 0.5);
  } else {
    // Sea floor: gentle detail only.
    var lambda = LAMBDA0;
    var detail = 0.0;
    for (var o = 0u; o < tile.octaves; o++) {
      let q = d * (R / lambda) + f32(o) * vec3f(17.31, 9.17, 3.71);
      detail += ${f(t.detailPlains)} * pow(lambda / LAMBDA0, ${f(t.roughness)}) * noise3(q, 0u);
      lambda *= 0.5;
    }
    h = min(base + detail * RELIEF, -0.05);
  }
  outHeight[slot] = h;
  outMaterial[slot] = (mat & 0xffu) | (u32(riverCover * 255.0) << 8u) | (mat & 0x10000u);
}`;
    this.pipeline = gpu.kernel(code);
  }

  /** Detail octaves at a level (0 at and above the global grid's resolution). */
  octavesAt(level: number): number {
    const t = this.tuning;
    const minLambda = Math.max(2 * sampleSpacing(level, this.opts.radius), t.minWavelength);
    let o = 0;
    while (this.firstWavelength / 2 ** o >= minLambda && o < 12) o++;
    return o;
  }

  /** Generates `keys` in one batch. Levels must not exceed MAX_BAKED_LEVEL. */
  async generate(keys: readonly TileKey[]): Promise<TileData[]> {
    if (keys.length === 0) return [];
    const gpu = this.grid.gpu;
    const t = this.tuning;
    const tileWords = new Int32Array(keys.length * 8);
    const segIds: number[] = [];
    keys.forEach((k, slot) => {
      if (k.level > MAX_BAKED_LEVEL) throw new RangeError(`Level ${k.level} > ${MAX_BAKED_LEVEL}`);
      const ids =
        k.level >= RIVER_INDEX_LEVEL
          ? this.opts.index.forTile(k, t.riverReach, this.opts.radius)
          : [];
      const w = slot * 8;
      tileWords[w] = k.face;
      tileWords[w + 1] = k.level;
      tileWords[w + 2] = k.x;
      tileWords[w + 3] = k.y;
      tileWords[w + 4] = segIds.length;
      tileWords[w + 5] = ids.length;
      tileWords[w + 6] = this.octavesAt(k.level);
      segIds.push(...ids);
    });
    const src = this.opts.index.segments.data;
    const segData = new Float32Array(Math.max(1, segIds.length) * RIVER_SEGMENT_FIELDS);
    segIds.forEach((s, i) => {
      for (let k = 0; k < RIVER_SEGMENT_FIELDS; k++) {
        segData[i * RIVER_SEGMENT_FIELDS + k] = src[s * RIVER_SEGMENT_FIELDS + k]!;
      }
    });

    const tilesBuf = gpu.storageFrom(tileWords, 'tiles.params');
    const segBuf = gpu.storageFrom(segData, 'tiles.segments');
    const outH = gpu.storage(keys.length * SAMPLES * 4, 'tiles.height');
    const outM = gpu.storage(keys.length * SAMPLES * 4, 'tiles.material');
    gpu.dispatch(
      this.pipeline,
      [
        this.perm,
        this.grid.get('height'),
        this.grid.get('uplift'),
        this.material,
        segBuf,
        tilesBuf,
        outH,
        outM,
      ],
      [Math.ceil(SAMPLES / WORKGROUP_SIZE), 1, keys.length],
    );
    const heights = new Float32Array(await gpu.read(outH));
    const materials = new Uint32Array(await gpu.read(outM));
    for (const b of [tilesBuf, segBuf, outH, outM]) b.destroy();

    return keys.map((key, slot) => {
      const height = heights.slice(slot * SAMPLES, (slot + 1) * SAMPLES);
      let lo = Infinity;
      let hi = -Infinity;
      for (const h of height) {
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      return {
        key,
        height,
        material: materials.slice(slot * SAMPLES, (slot + 1) * SAMPLES),
        minHeight: lo,
        maxHeight: hi,
      };
    });
  }

  dispose(): void {
    this.perm.destroy();
    this.material.destroy();
  }
}
