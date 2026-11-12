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
 * `fade` goes to zero on floodplains, so river valleys stay smooth. Detail
 * amplitude on plains also falls with the global slope, so flat, sediment-filled
 * lowlands stay smooth while hills and mountains stay rough. On land, detail is
 * in physical meters (landforms keep Earth's heights, decision 121) and follows
 * the landscape position from the global grid: little on valley floors, which
 * erosion has filled, most on ridges and upper slopes. Octaves
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
 *                 | aridity (0..15) << 17 | glaciation (0..7) << 21 (decision 126)
 *                 | forest density (0..255) << 24 (decision 44)
 *   lake     f32, lake surface (m) where a lake is within about one global
 *            cell, NO_LAKE elsewhere. The level is defined on dry ground near
 *            the lake too, so level − height is a signed depth whose zero
 *            crossing is the shoreline, following the fine terrain (decision 40).
 */
import { Noise3 } from '../../core/noise';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import { TILE_BORDER, TILE_STRIDE, TILE_TEXELS } from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { DELTA_FIELDS, RIVER_INDEX_LEVEL, RIVER_SEGMENT_FIELDS, RiverIndex } from '../riverIndex';
import type { GlobalGrid } from './globalGrid';
import { WORKGROUP_SIZE } from './gpuContext';
import { bicubicSamplerWgsl } from './gridWgsl';
import { NOISE_WGSL, packPermutations } from './noiseWgsl';
import { LANDFORM } from './erosion';
import { Biome } from '../biomes';
import { buildLandformMasks, LANDFORM_MASK_WGSL } from './landformMasks';

export const TILE_SYNTH_TUNING = {
  /** First detail octave, in global cells: just below what the global grid resolves (the detail stage covers 3+ cells). */
  firstOctaveCells: 1.5,
  /** Finest baked detail wavelength (m); finer detail is the renderer's job. */
  minWavelength: 100,
  /** Roughness exponent: octave amplitude ∝ wavelength^H. */
  roughness: 0.8,
  /**
   * Detail amplitude of the first octave (reference m) on plains, and per meter of
   * uplift. On land it is multiplied by the landform gain as well as reliefScale
   * (decision 121); on the sea floor by reliefScale only.
   */
  detailPlains: 6,
  detailPerUplift: 0.008,
  /**
   * Landscape position (decision 121): the global height minus its mean on a ring
   * `positionRing` global cells out, over `positionScale` m plus `positionSlope` × the
   * height change along the slope across the ring. Detail is `valleyDetail` of full
   * on valley floors and `ridgeDetail` on ridges.
   */
  positionRing: 2,
  positionScale: 8,
  positionSlope: 0.5,
  valleyDetail: 0.25,
  ridgeDetail: 1,
  /** Forest thins on global slopes (m/m, physical) between these. */
  forestSlope: [0.7, 1.05] as [number, number],
  /** Plains detail falls to this fraction where the global slope is below flatSlope[0]. */
  lowlandDetail: 0.15,
  /** Global slopes (m/m) over which plains detail ramps from lowlandDetail to full. */
  flatSlope: [0.002, 0.015] as [number, number],
  /**
   * High mountains (decision 126): ridged octaves of `alpineRelief` m at
   * `alpineWavelength` × the first detail wavelength, over ground from
   * `alpineHeight[0]` to `alpineHeight[1]` m (physical) with mountain uplift.
   */
  alpineHeight: [1500, 4000] as [number, number],
  alpineRelief: 900,
  alpineWavelength: 1.6,
  /** Gully depth per (slope × wavelength), the share kept on valley floors, the slope at which depth stops growing, and the per-octave decay. */
  gullies: 0.35,
  gullyValley: 0.3,
  gullySlopeCap: 1.2,
  gullyDecay: 0.85,
  /** Floodplain half-width in channel widths, and at least this many meters. */
  floodplainWidths: 8,
  floodplainMin: 250,
  /** Rise of the valley floor away from the bank (m per m). */
  bankSlope: 0.04,
  /** Distance (m) beyond which a river no longer shapes the terrain. */
  riverReach: 2500,
  /** Forest clumping: noise wavelengths (m) and strength. */
  forestClumps: [1600, 500] as [number, number],
  forestClumping: 0.9,
  /** Forest thins out over this height band around the treeline (physical m). */
  treelineBand: 30,
  /**
   * Arid landforms (decision 126). Aridity (landform mask x) is remapped from
   * `aridRange` to 0..1. Rock is layered in strata `strataThickness` m thick; each
   * layer is stepped into a bench and a cliff by s ↦ s^p with p from
   * `strataSharpness` (per layer), where the regional layering noise (wavelength
   * `strataRegion` m) is high. Buttes and mesas rise `butteHeight` m from dry plains
   * and plateaus (global slope below `butteFlat`), where fBm noise of wavelength
   * `butteWavelength` m exceeds a threshold that varies over `butteRegion` m.
   */
  aridRange: [0.35, 0.85] as [number, number],
  strataThickness: 75,
  strataSharpness: [1.6, 3.5] as [number, number],
  strataRegion: 30_000,
  butteWavelength: 3500,
  butteRegion: 45_000,
  butteThreshold: 0.3,
  butteDensity: 0.3,
  butteEdge: 0.012,
  butteApron: 0.2,
  butteHeight: 320,
  butteFlat: [0.02, 0.07] as [number, number],
  /**
   * Skerry coasts (decision 126): where glaciation (landform mask y) is high, ground
   * within `skerryDepth` m of sea level is scaled by `skerryShelf` toward it and
   * rounded knobs `skerryHeight` m tall, first wavelength `skerryWavelength` m, rise
   * through it.
   */
  skerryDepth: 160,
  /**
   * Falls (decision 126): rivers at least `fallMinWidth` m wide whose bed falls
   * `fallGradient` (m/m over ±`fallProbe` m, ramped) step down in pools and drops one
   * stratum (`strataThickness`) high, each drop over about `fallRun` m.
   */
  fallGradient: [0.012, 0.03] as [number, number],
  fallProbe: 400,
  fallRun: 140,
  fallMinWidth: 15,
  /** Width of the gorge the steps cut, in river widths beyond the bank (plus 60 m). */
  fallGorge: 4,
  /** Deltas build only on ground lower than this (m), fading between the two. */
  deltaHigh: [12, 40] as [number, number],
  /** Green corridor along rivers in dry land (decision 126): half-width in river widths, clamped (m). */
  greenWidths: 9,
  greenMin: 250,
  greenMax: 2300,
  skerryShelf: 0.12,
  skerryHeight: 30,
  skerryWavelength: 900,
  /** Depth (m) of the skerry shelf where the land proximity reaches 0. */
  skerrySeaDepth: 70,
};

/** Deepest level with baked tiles (about 48 m samples at R = 1,000 km). */
export const MAX_BAKED_LEVEL = 7;

/** Lake level of a sample with no lake nearby. */
export const NO_LAKE = -1e30;
/** The same, in the half-float global table. */
const NO_LAKE_HALF = -60_000;

/** IEEE half-float bits of x (round to nearest even), for packing global tables. */
export function toHalf(x: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = x;
  const b = u32[0]!;
  const sign = (b >>> 16) & 0x8000;
  const exp = ((b >>> 23) & 0xff) - 127 + 15;
  let mant = b & 0x7fffff;
  if (exp >= 31) return sign | 0x7c00; // overflow → ±inf
  if (exp <= 0) {
    if (exp < -10) return sign; // underflow → ±0
    mant |= 0x800000;
    const shift = 14 - exp;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return sign | h;
  }
  let h = (exp << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  return sign | h;
}

export interface TileData {
  key: TileKey;
  /** TILE_STRIDE² physical heights (m). */
  height: Float32Array;
  /** TILE_STRIDE² packed materials (see module doc). */
  material: Uint32Array;
  /** TILE_STRIDE² lake surface heights (m), NO_LAKE where no lake is near. */
  lake: Float32Array;
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
  /** Eroded height per global cell (m), the CPU copy of the grid's "height" map. */
  height: Float32Array;
  /** Forest base density per global cell, 0..255 (decision 44). */
  forest: Uint8Array;
  /** Treeline height per global cell (physical m). */
  treeline: Float32Array;
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
  /** Per global cell: packed material, and the lake level's f32 bits (WebGPU allows 8 storage buffers). */
  private readonly material: GPUBuffer;
  /** Per global cell: landform masks, four unorm8 (landformMasks.ts). */
  private readonly masks: GPUBuffer;
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
    // Per cell: biome | lake << 16 | forest << 24, then two half floats: the lake
    // surface (the Priority-Flood fill level, terrain + depth) and the treeline.
    // Half floats give about 1 m at these heights: lake levels are flat per lake and
    // lakes are at least 3 m deep, so that is enough.
    const packed = new Uint32Array(grid.cellCount * 2);
    for (let c = 0; c < grid.cellCount; c++) {
      const depth = opts.lakeDepth[c]!;
      packed[c * 2] = opts.biome[c]! | (depth > 0 ? 1 << 16 : 0) | (opts.forest[c]! << 24);
      const level = depth > 0 ? opts.height[c]! + depth : NO_LAKE_HALF;
      packed[c * 2 + 1] = toHalf(level) | (toHalf(Math.max(-60_000, opts.treeline[c]!)) << 16);
    }
    this.material = gpu.storageFrom(packed, 'tiles.globalMaterial');
    this.masks = buildLandformMasks(grid, opts.biome, opts.height, opts.treeline);

    const code = /* wgsl */ `${grid.wgsl}
struct Tile { face: i32, level: i32, x: i32, y: i32, segStart: u32, segCount: u32, octaves: u32,
  deltaStart: u32, deltaCount: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<storage, read> perm: array<u32>;
@group(0) @binding(1) var<storage, read> gHeight: array<f32>;
@group(0) @binding(2) var<storage, read> gUplift: array<f32>;
@group(0) @binding(3) var<storage, read> gMaterial: array<vec2u>;
@group(0) @binding(4) var<storage, read> segs: array<f32>;
@group(0) @binding(5) var<storage, read> tiles: array<Tile>;
// Per sample: height and lake level (f32 bits), material, unused.
@group(0) @binding(6) var<storage, read_write> outSample: array<vec4u>;
@group(0) @binding(7) var<storage, read> gMasks: array<u32>;
${NOISE_WGSL}
${LANDFORM_MASK_WGSL}
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
const NO_LAKE: f32 = ${NO_LAKE};
const NO_LAKE_HALF: f32 = ${f(NO_LAKE_HALF)};

// Lake surface near d: the highest level among the 3×3 global cells around d's cell
// whose centers lie within about one cell of d, or NO_LAKE.
fn lakeLevelAt(d: vec3f) -> f32 {
  let c0 = dirCell(d);
  let reach = cos(1.1 * 2.0 * QUARTER_PI / f32(N));
  var level = NO_LAKE;
  for (var k = -1; k < 8; k++) {
    var c = c0;
    if (k >= 0) { c = neighbor(c0, k); }
    if (c < 0) { continue; }
    let l = unpack2x16float(gMaterial[c].y).x;
    if (l > NO_LAKE_HALF * 0.5 && l > level && dot(cellDir(c), d) > reach) { level = l; }
  }
  return level;
}

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

// Ridged noise for high mountains: crests where the noise crosses zero, squared to sharpen them.
fn alpineRidge(q: vec3f) -> f32 {
  let r = 1.0 - abs(noise3(q, 0u));
  return r * r;
}

fn hash1(k: f32) -> f32 {
  return f32(pcg3(vec3u(bitcast<u32>(i32(k)), 0x9e37u, 0x79b9u)).x & 0xffffu) / 65535.0;
}

fn pcg3(v0: vec3u) -> vec3u {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

// Erosion filter: Gabor waves varying along t (across the slope), on a jittered 3D lattice.
// Returns the wave sum and its sine sum (the derivative along t is −2π × the latter).
fn gully(q: vec3f, t: vec3f, salt: u32) -> vec2f {
  let cell = floor(q);
  var sum = 0.0;
  var dsum = 0.0;
  var wsum = 0.0;
  for (var k = 0; k < 27; k++) {
    let o = vec3f(f32(k % 3 - 1), f32((k / 3) % 3 - 1), f32(k / 9 - 1));
    let lc = cell + o;
    let h = pcg3(bitcast<vec3u>(vec3i(lc)) + vec3u(salt));
    let jitter = vec3f(h & vec3u(0xffffu)) / 65535.0;
    let dlt = q - (lc + jitter);
    let w = exp(-2.0 * dot(dlt, dlt));
    let phase = TWO_PI * dot(dlt, t);
    sum += w * cos(phase);
    dsum += w * sin(phase);
    wsum += w;
  }
  return vec2f(sum, dsum) / max(wsum, 1e-6);
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
  let lakeLevel = lakeLevelAt(d);
  // Lake beds are sediment-filled: no detail where the smooth surface lies below the
  // lake, so a lake reads as one body of water rather than puddles in rough ground.
  let dryBed = 1.0 - clamp((lakeLevel - base) / 2.0, 0.0, 1.0);
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
  let jitCell = gMaterial[dirCell(normalize(d + 1.4 * cellAngle * jit))];
  let mat = jitCell.x;
  let treeline = unpack2x16float(jitCell.y).y;
  let sampleSpacing = R * 2.0 * QUARTER_PI / denom;
  var riverCover = 0.0;
  var forest = 0.0;
  // Landform masks for the renderer: aridity in bits 17–20, glaciation in 21–23.
  let masks = landformMasks(d);
  let maskBits = (u32(round(masks.x * 15.0)) << 17u) | (u32(round(masks.y * 7.0)) << 21u);
  var biomeOut = mat & 0xffu;
  // Green ground by water in dry land (decision 126): along rivers and on deltas.
  var fertile = 0.0;

  if (base > 0.0) {
    // Rivers: the nearest channel (relative to its floodplain) shapes the terrain.
    var nearest = 1.0e9;
    var bestDist = 1.0e9;
    var bestWidth = 0.0;
    var bestPoint = d;
    var bestAlong = vec3f(0.0);
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
      // Coverage for drawing: at least ~2.5 samples wide with soft edges, so thin
      // rivers stay continuous at this level (the carved channel keeps its true width).
      let spacing = R * 2.0 * QUARTER_PI / denom;
      let halfVis = max(0.5 * w, 1.25 * spacing);
      riverCover = max(riverCover, 1.0 - smoothstep(halfVis - 0.75 * spacing, halfVis + 0.75 * spacing, dist));
      if (dist / plain < nearest) {
        nearest = dist / plain;
        bestDist = dist;
        bestWidth = w;
        bestAlong = ab;
        bestPoint = p;
      }
    }
    let fade = smoothstep(0.0, 1.0, nearest);
    // A green corridor along rivers through dry land, wider for wider rivers, with a
    // ragged edge (irrigation and gallery woods; the Nile's valley).
    let belt = clamp(${f(t.greenWidths)} * bestWidth, ${f(t.greenMin)}, ${f(t.greenMax)})
      * (1.0 + 0.35 * noise3(d * (R / 1500.0) + vec3f(8.1, 2.2, 6.6), 512u));
    fertile = 1.0 - smoothstep(0.75 * belt, belt, bestDist);
    var carve = 1.0e9;
    var reachW = 0.0;
    if (bestDist < ${f(t.riverReach)}) {
      // The water surface follows the smooth global height under the channel.
      let smoothSurf = heightAt(normalize(bestPoint)) - 0.5;
      var surf = smoothSurf;
      // Falls (decision 126): on steep reaches the water surface steps down the
      // rock layers in pools and drops, each drop over about fallRun m.
      let along = normalize(bestAlong + vec3f(1e-9, 0.0, 0.0)) * (${f(t.fallProbe)} / R);
      let fallGrad = abs(heightAt(normalize(bestPoint + along)) - heightAt(normalize(bestPoint - along)))
        / (2.0 * ${f(t.fallProbe)});
      let T = ${f(t.strataThickness)};
      let stepW = smoothstep(${f(t.fallGradient[0])}, ${f(t.fallGradient[1])}, fallGrad)
        * smoothstep(3.0 * T, 1.2 * T, sampleSpacing) * step(${f(t.fallMinWidth)}, bestWidth);
      if (stepW > 0.0 && surf > T) {
        let xs = surf / T;
        let ks = floor(xs);
        let eps = clamp(${f(t.fallRun)} * fallGrad / T, 0.005, 0.5);
        surf = mix(surf, (ks + smoothstep(1.0 - eps, 1.0, xs - ks)) * T, stepW);
      }
      let half = 0.5 * bestWidth;
      let depth = 1.0 + 0.02 * bestWidth;
      if (bestDist < half) {
        let x = bestDist / half;
        carve = surf - depth * (1.0 - x * x);
      } else {
        // The steps cut a gorge a few widths across; the valley beyond keeps its slope.
        let banks = mix(surf, smoothSurf, smoothstep(half, half + ${f(t.fallGorge)} * bestWidth + 60.0, bestDist));
        carve = banks + (bestDist - half) * ${f(t.bankSlope)};
      }
      reachW = 1.0 - smoothstep(0.6 * ${f(t.riverReach)}, ${f(t.riverReach)}, bestDist);
    }

    // Global slope: shapes the gullies, and calms detail on flat lowlands.
    let e0 = normalize(cross(vec3f(0.0, 1.0, 0.0), d) + vec3f(1e-7, 0.0, 0.0));
    let n0 = cross(d, e0);
    let dl = 0.5 * QUARTER_PI * 2.0 / f32(N);
    let he = heightAt(normalize(d + dl * e0)) - heightAt(normalize(d - dl * e0));
    let hn = heightAt(normalize(d + dl * n0)) - heightAt(normalize(d - dl * n0));
    let grad = (he * e0 + hn * n0) / (2.0 * dl * R);
    let slope = length(grad);

    // Detail octaves.
    let up = upliftAt(d);
    let mountain = smoothstep(500.0, 2500.0, up);
    let lowland = mix(${f(t.lowlandDetail)}, 1.0, smoothstep(${f(t.flatSlope[0])}, ${f(t.flatSlope[1])}, slope));
    // Landscape position: above the ring mean on ridges, below it in valleys.
    let ring = ${f(t.positionRing)} * 2.0 * QUARTER_PI / f32(N);
    let ringMean = 0.25 * (heightAt(normalize(d + ring * e0)) + heightAt(normalize(d - ring * e0))
      + heightAt(normalize(d + ring * n0)) + heightAt(normalize(d - ring * n0)));
    let relScale = ${f(t.positionScale)} + ${f(t.positionSlope)} * slope * ring * R;
    let position = smoothstep(-1.0, 1.0, (base - ringMean) / relScale);
    // Detail continues the global grid's landform relief (decision 121): reference
    // amplitude × reliefScale × the landform gain, so slopes stay Earth-like.
    let a0 = (${f(t.detailPlains)} * lowland + ${f(t.detailPerUplift)} * max(up, 0.0)) * RELIEF
      * ${f(LANDFORM.gain)} * mix(${f(t.valleyDetail)}, ${f(t.ridgeDetail)}, position);
    var detail = 0.0;
    var lambda = LAMBDA0;
    for (var o = 0u; o < tile.octaves; o++) {
      let q = d * (R / lambda) + f32(o) * vec3f(17.31, 9.17, 3.71);
      let n = noise3(q, 0u);
      let ridge = 0.45 - 2.0 * abs(n);
      detail += a0 * pow(lambda / LAMBDA0, ${f(t.roughness)}) * mix(n, ridge, mountain);
      lambda *= 0.5;
    }

    // Erosion filter (decision 126): gullies across the slope, so they run downhill,
    // with depth ∝ slope × wavelength. Each octave follows the gradient accumulated
    // so far (global slope plus the coarser gullies), so finer gullies bend into
    // coarser ones and branch like tributaries, and the ground between them is left
    // as sharp spurs. Gullies sharpen into creases: valleys V-shaped, ridges rounded
    // by the cosine's crest. Fewer on valley floors (landscape position).
    // High mountains (decision 126): ridged octaves whose crests become arêtes and
    // horns, strongest on high, uplifted ground and on ridges. Their gradient feeds
    // the erosion filter below, so gullies cut down between the crests.
    var peaks = 0.0;
    var g = grad;
    let alpine = smoothstep(${f(t.alpineHeight[0])}, ${f(t.alpineHeight[1])}, base) * mountain
      * mix(0.35, 1.0, position) * fade * dryBed;
    if (alpine > 0.0) {
      lambda = LAMBDA0 * ${f(t.alpineWavelength)};
      var pa = ${f(t.alpineRelief)} * alpine;
      for (var o = 0u; o < 2u; o++) {
        if (lambda < 2.0 * sampleSpacing) { break; }
        let q = d * (R / lambda) + vec3f(23.9, 71.3, 5.7) * f32(o + 1u);
        let dq = 0.15;
        let rc = alpineRidge(q);
        let gx = (alpineRidge(q + dq * e0) - alpineRidge(q - dq * e0)) / (2.0 * dq);
        let gy = (alpineRidge(q + dq * n0) - alpineRidge(q - dq * n0)) / (2.0 * dq);
        peaks += pa * (rc - 0.4);
        g += pa * (gx * e0 + gy * n0) / lambda;
        lambda *= 0.5;
        pa *= 0.45;
      }
    }

    var gullies = 0.0;
    lambda = LAMBDA0;
    var gAmp = ${f(t.gullies)} * mix(${f(t.gullyValley)}, 1.0, position);
    for (var o = 0u; o < tile.octaves; o++) {
      let gs = length(g);
      if (gs > 1e-5) {
        let across = normalize(cross(d, g / gs));
        let q = d * (R / lambda);
        let w = gully(q, across, o * 7919u);
        let depth = gAmp * min(gs, ${f(t.gullySlopeCap)}) * lambda;
        // Creases: 1 − |sin| style valleys from the wave (−1 at gully floors).
        gullies += depth * w.x;
        g += depth * (-TWO_PI / lambda) * w.y * across;
      }
      lambda *= 0.5;
      gAmp *= ${f(t.gullyDecay)};
    }

    h = base + (detail + gullies) * fade * dryBed + peaks;

    // Arid landforms (decision 126): buttes and mesas on dry plains and plateaus,
    // then the layered rock stepped into benches and cliffs.
    let arid = smoothstep(${f(t.aridRange[0])}, ${f(t.aridRange[1])}, masks.x) * dryBed;
    if (arid > 0.0) {
      let flat = 1.0 - smoothstep(${f(t.butteFlat[0])}, ${f(t.butteFlat[1])}, slope);
      let bq = d * (R / ${f(t.butteWavelength)}) + vec3f(41.3, 7.9, 23.1);
      let m = 0.62 * noise3(bq, 512u) + 0.28 * noise3(bq * 2.31, 512u) + 0.1 * noise3(bq * 5.07, 512u);
      let region = noise3(d * (R / ${f(t.butteRegion)}) + vec3f(5.1, 77.7, 3.3), 512u);
      let theta = ${f(t.butteThreshold)} - ${f(t.butteDensity)} * smoothstep(0.0, 0.7, region);
      let cap = smoothstep(theta - ${f(t.butteEdge)}, theta + ${f(t.butteEdge)}, m);
      let apron = smoothstep(theta - ${f(t.butteApron)}, theta, m);
      let tall = ${f(t.butteHeight)} * (0.6 + 0.8 * (0.5 + 0.5 * noise3(d * (R / 9000.0) + vec3f(3.0, 1.0, 9.0), 512u)));
      // Buttes need a few samples across; coarse tiles leave them out.
      let resolvedB = smoothstep(4.0, 10.0, ${f(t.butteWavelength)} / sampleSpacing);
      h += arid * flat * resolvedB * tall * (0.75 * cap + 0.25 * apron * apron);

      let layered = 0.5 + 0.5 * noise3(d * (R / ${f(t.strataRegion)}) + vec3f(12.7, 3.1, 55.5), 512u);
      let T = ${f(t.strataThickness)};
      let resolvedT = smoothstep(3.0 * T, 1.2 * T, sampleSpacing);
      let strength = arid * smoothstep(0.2, 0.5, layered) * resolvedT;
      if (strength > 0.0 && h > 0.0) {
        let x = h / T;
        let k = floor(x);
        let s = x - k;
        let p = mix(${f(t.strataSharpness[0])}, ${f(t.strataSharpness[1])}, hash1(k));
        h = mix(h, (k + pow(s, p)) * T, strength);
      }
    }
    // Rivers shape the terrain within reach; carving never raises it.
    // Not under lakes: a river crossing a lake has no channel in the lake bed.
    h = mix(h, min(h, carve), reachW * dryBed);
    // Coastal plains stay land, so detail does not pepper the coast with islands.
    h = select(h, max(h, 0.05), base > 0.5);

    // Forest (decision 44): the cell's base density, cut by the treeline at the fine
    // height, steep slopes and water, then clumped into stands and clearings by noise
    // where the clumps are resolved (coarse tiles keep the mean).
    forest = f32((mat >> 24u) & 0xffu) / 255.0;
    forest *= smoothstep(treeline + ${f(t.treelineBand)}, treeline - ${f(t.treelineBand)}, h);
    forest *= 1.0 - smoothstep(${f(t.forestSlope[0])}, ${f(t.forestSlope[1])}, slope);
    forest *= 1.0 - riverCover;
    forest *= select(1.0, 0.0, h < lakeLevel || h <= 0.0);
    var clump = 0.0;
    var clumpAmp = 1.0;
    var resolved = 0.0;
    for (var o = 0; o < 2; o++) {
      let lam = select(${f(t.forestClumps[1])}, ${f(t.forestClumps[0])}, o == 0);
      let r = smoothstep(2.0, 4.0, lam / sampleSpacing);
      clump += clumpAmp * r * noise3(d * (R / lam) + vec3f(91.3, 47.1, 13.7 + f32(o) * 29.0), 0u);
      resolved = max(resolved, r);
      clumpAmp *= 0.5;
    }
    let clumped = smoothstep(0.38, 0.62, forest + ${f(t.forestClumping)} * clump) * step(0.01, forest);
    forest = mix(forest, clumped, resolved);
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

  // Deltas (decision 126): a low fan from an apex upstream of the mouth out into
  // the sea, a few meters above it, cut by distributaries that fan out and branch.
  for (var k = 0u; k < tile.deltaCount; k++) {
    let o = (tile.deltaStart + k) * SEG_FIELDS;
    let mouth = vec3f(segs[o], segs[o + 1u], segs[o + 2u]);
    let sea = vec3f(segs[o + 3u], segs[o + 4u], segs[o + 5u]);
    let width = segs[o + 6u];
    let rd = segs[o + 7u];
    let apex = normalize(mouth - sea * (0.3 * rd / R));
    let v = (d - apex) * R;
    let x = dot(v, sea);
    let y = dot(v, cross(apex, sea));
    let r = length(vec2f(x, y));
    let theta = atan2(y, x);
    let salt = f32(k) * 13.7 + mouth.x * 1000.0;
    let lobes = 1.0 + 0.18 * noise3(vec3f(theta * 2.2, salt, 0.5), 512u)
      + 0.08 * noise3(vec3f(theta * 7.0, salt, 3.5), 512u);
    let edge = rd * lobes;
    let side = 1.15 + 0.25 * noise3(vec3f(r / 3000.0, salt, 7.5), 512u);
    let fan = (1.0 - smoothstep(0.8 * edge, edge, r)) * (1.0 - smoothstep(side - 0.3, side, abs(theta)))
      // Deltas build on low ground and out into the sea; higher ground stays.
      * (1.0 - smoothstep(${f(t.deltaHigh[0])}, ${f(t.deltaHigh[1])}, h));
    if (fan <= 0.0) { continue; }
    let rel = r / rd;
    var surface = 0.8 + 5.0 * (1.0 - rel) + 0.6 * noise3(d * (R / 700.0), 512u);
    // Distributaries: channels along warped rays from the apex, splitting with distance.
    var channel = 0.0;
    for (var j = 0; j < 7; j++) {
      let base_j = (f32(j) / 6.0 - 0.5) * 2.0;
      let born = 0.12 + 0.35 * abs(base_j) * abs(base_j);
      let warp = 0.13 * noise3(vec3f(r / 2600.0, f32(j) * 3.1, salt), 512u);
      let off = abs(theta + warp - base_j) * r;
      let cw = width * mix(0.45, 0.18, rel) + 25.0;
      channel = max(channel, (1.0 - smoothstep(0.6 * cw, cw, off)) * smoothstep(born, born + 0.05, rel));
    }
    surface = mix(surface, -2.5, channel);
    h = mix(h, surface, fan);
    fertile = max(fertile, fan * (1.0 - channel));
    if (h > 0.0 && biomeOut <= ${Biome.SeaIce}u) { biomeOut = ${Biome.Savanna}u; }
  }
  if (h > 0.0 && fertile > 0.0) {
    // Dry biomes turn green; the corridor's inner part is wooded in clumps.
    let dry = smoothstep(0.3, 0.7, masks.x) + select(0.0, 1.0, biomeOut == ${Biome.Savanna}u);
    if (dry > 0.0 && fertile > 0.5) {
      biomeOut = ${Biome.TemperateGrassland}u;
      let groves = smoothstep(0.1, 0.4, noise3(d * (R / 450.0) + vec3f(1.0, 9.0, 4.0), 0u));
      forest = max(forest, 0.6 * groves * smoothstep(0.6, 1.0, fertile) * (1.0 - riverCover));
    }
  } else if (h <= 0.0) {
    forest = 0.0;
  }

  // Skerry coasts (decision 126): on glaciated, low coasts the shore zone is
  // flattened toward sea level and rounded rock knobs (roches moutonnées) rise
  // through it, as islands at sea and as inlets and ponds on land.
  let iceHere = masks.y;
  // Within reach of the shore (land proximity at sea, sea proximity on land) and low.
  let shoreReach = select(smoothstep(0.55, 1.0, masks.w), smoothstep(0.12, 0.45, masks.z), base <= 0.0);
  let skerry = shoreReach * smoothstep(0.45, 0.85, iceHere) * (1.0 - smoothstep(0.3, 0.6, masks.x))
    * (1.0 - smoothstep(0.6 * ${f(t.skerryDepth)}, ${f(t.skerryDepth)}, base))
    * select(1.0, 0.0, lakeLevel > base - 1.0);
  if (skerry > 0.0) {
    var knob = 0.0;
    var kl = ${f(t.skerryWavelength)};
    var ka = 1.0;
    for (var o = 0; o < 5; o++) {
      let r = smoothstep(2.0, 4.0, kl / sampleSpacing);
      let n = noise3(d * (R / kl) + vec3f(61.7, 14.3, 29.9) + f32(o) * vec3f(5.3, 1.1, 7.7), 512u);
      // Rounded knobs: the noise's positive lobes, softened.
      knob += ka * r * (n + 0.35 * abs(n));
      kl *= 0.42;
      ka *= 0.55;
    }
    // The sea floor shoals toward the shore whatever its depth; land is flattened.
    let floor = select(base * ${f(t.skerryShelf)}, -${f(t.skerrySeaDepth)} * (1.0 - masks.z) - 4.0, base <= 0.0);
    let shelf = floor + ${f(t.skerryHeight)} * knob;
    h = mix(h, shelf, skerry);
    // New islands are bare, ice-polished rock, with pines on the higher knobs.
    if (h > 0.0 && biomeOut <= ${Biome.SeaIce}u) {
      biomeOut = ${Biome.Alpine}u;
      forest = 0.55 * smoothstep(6.0, 16.0, h)
        * smoothstep(0.0, 0.3, noise3(d * (R / 300.0) + vec3f(4.4, 8.8, 1.2), 0u) + 0.2);
    }
    if (h <= 0.0) { forest = 0.0; }
  }
  outSample[slot] = vec4u(bitcast<u32>(h), bitcast<u32>(lakeLevel),
    biomeOut | (u32(riverCover * 255.0) << 8u) | (mat & 0x10000u) | maskBits
    | (u32(clamp(forest, 0.0, 1.0) * 255.0) << 24u), 0u);
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
    const TILE_WORDS = 12;
    const tileWords = new Int32Array(keys.length * TILE_WORDS);
    const segIds: number[] = [];
    const deltaIds: number[][] = [];
    keys.forEach((k, slot) => {
      if (k.level > MAX_BAKED_LEVEL) throw new RangeError(`Level ${k.level} > ${MAX_BAKED_LEVEL}`);
      const ids =
        k.level >= RIVER_INDEX_LEVEL
          ? this.opts.index.forTile(k, t.riverReach, this.opts.radius)
          : [];
      const w = slot * TILE_WORDS;
      tileWords[w] = k.face;
      tileWords[w + 1] = k.level;
      tileWords[w + 2] = k.x;
      tileWords[w + 3] = k.y;
      tileWords[w + 4] = segIds.length;
      tileWords[w + 5] = ids.length;
      tileWords[w + 6] = this.octavesAt(k.level);
      segIds.push(...ids);
      deltaIds.push(this.opts.index.deltasForTile(k, this.opts.radius));
    });
    // Delta records follow the segments in the same buffer (same stride).
    let deltaAt = segIds.length;
    deltaIds.forEach((ids, slot) => {
      tileWords[slot * TILE_WORDS + 7] = deltaAt;
      tileWords[slot * TILE_WORDS + 8] = ids.length;
      deltaAt += ids.length;
    });
    const src = this.opts.index.segments.data;
    const segData = new Float32Array(Math.max(1, deltaAt) * RIVER_SEGMENT_FIELDS);
    segIds.forEach((s, i) => {
      for (let k = 0; k < RIVER_SEGMENT_FIELDS; k++) {
        segData[i * RIVER_SEGMENT_FIELDS + k] = src[s * RIVER_SEGMENT_FIELDS + k]!;
      }
    });
    const deltas = this.opts.index.deltas;
    let at = segIds.length;
    for (const ids of deltaIds) {
      for (const id of ids) {
        for (let k = 0; k < DELTA_FIELDS; k++) {
          segData[at * RIVER_SEGMENT_FIELDS + k] = deltas[id * DELTA_FIELDS + k]!;
        }
        at++;
      }
    }

    const tilesBuf = gpu.storageFrom(tileWords, 'tiles.params');
    const segBuf = gpu.storageFrom(segData, 'tiles.segments');
    const out = gpu.storage(keys.length * SAMPLES * 16, 'tiles.samples');
    gpu.dispatch(
      this.pipeline,
      [
        this.perm,
        this.grid.get('height'),
        this.grid.get('uplift'),
        this.material,
        segBuf,
        tilesBuf,
        out,
        this.masks,
      ],
      [Math.ceil(SAMPLES / WORKGROUP_SIZE), 1, keys.length],
    );
    const raw = await gpu.read(out);
    for (const b of [tilesBuf, segBuf, out]) b.destroy();
    const asF32 = new Float32Array(raw);
    const asU32 = new Uint32Array(raw);
    const heights = new Float32Array(keys.length * SAMPLES);
    const lakes = new Float32Array(keys.length * SAMPLES);
    const materials = new Uint32Array(keys.length * SAMPLES);
    for (let i = 0; i < heights.length; i++) {
      heights[i] = asF32[i * 4]!;
      lakes[i] = asF32[i * 4 + 1]!;
      materials[i] = asU32[i * 4 + 2]!;
    }

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
        lake: lakes.slice(slot * SAMPLES, (slot + 1) * SAMPLES),
        minHeight: lo,
        maxHeight: hi,
      };
    });
  }

  dispose(): void {
    this.perm.destroy();
    this.material.destroy();
    this.masks.destroy();
  }
}
