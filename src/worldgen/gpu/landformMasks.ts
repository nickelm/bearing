/**
 * Landform masks for tile synthesis (decision 126): smooth fields on the
 * global grid that say which kind of landscape the tiles should carve.
 *
 *   x  aridity   deserts and dry shrubland: layered rock, terraces, buttes
 *                (the Colorado Plateau: Grand Canyon, Monument Valley)
 *   y  glaciation ground an ice age would have covered: land above or near
 *                the treeline, tundra, taiga and ice, spread about 15 km
 *                downhill and around (the Alps, Scandinavia), for rounded
 *                knobs, skerry coasts and smoothed valley floors
 *   z  land proximity, at sea: 1 at the coast, falling by `coastDecay` per cell
 *   w  sea proximity, on land: the same toward the sea
 *      (skerry coasts need the distance to the shore, which the sea floor's
 *      depth does not give: it plunges within a cell of the coast)
 *
 * Each source comes from the global biome and treeline maps, is spread by a
 * max filter where noted, then blurred with seam-aware passes on the GPU, so
 * the masks change over kilometers rather than at cell edges. The result is
 * one u32 per cell (four unorm8 channels), sampled bilinearly by the tiles.
 */
import { Biome } from '../biomes';
import type { GlobalGrid } from './globalGrid';
import { LINEAR_ID_WGSL } from './gpuContext';

export const LANDFORM_MASK_TUNING = {
  /** Aridity per biome; others are 0. */
  arid: {
    [Biome.HotDesert]: 1,
    [Biome.ColdDesert]: 1,
    [Biome.Shrubland]: 0.75,
    [Biome.Savanna]: 0.25,
    [Biome.TemperateGrassland]: 0.2,
  } as Record<number, number>,
  /** Glaciation per biome; above the treeline counts as 1. */
  ice: {
    [Biome.IceSheet]: 1,
    [Biome.Alpine]: 1,
    [Biome.Tundra]: 1,
    [Biome.Taiga]: 0.85,
  } as Record<number, number>,
  /** Glaciation reaches this far (m, physical) below the treeline: ice-age glaciers ran lower. */
  iceBelowTreeline: 900,
  /** Max-filter passes (cells) for glaciation: glaciers flowed out of the cold ground. */
  iceSpread: 8,
  /** Blur passes per mask. */
  blurPasses: 6,
  /** Proximity decay per cell, and passes (cells) for the land and sea proximity. */
  coastDecay: 0.86,
  landReach: 14,
  seaReach: 6,
};

/** Builds the packed mask buffer (one u32 per global cell). The caller owns it. */
export function buildLandformMasks(
  grid: GlobalGrid,
  biome: Uint8Array,
  height: Float32Array,
  treeline: Float32Array,
): GPUBuffer {
  const t = LANDFORM_MASK_TUNING;
  const gpu = grid.gpu;
  const count = grid.cellCount;
  const arid = new Float32Array(count);
  const ice = new Float32Array(count);
  const land = new Float32Array(count);
  const sea = new Float32Array(count);
  for (let c = 0; c < count; c++) {
    const b = biome[c]!;
    arid[c] = t.arid[b] ?? 0;
    const h = height[c]!;
    land[c] = h > 0 ? 1 : 0;
    sea[c] = h > 0 ? 0 : 1;
    const above = h > 0 ? (h - treeline[c]! + t.iceBelowTreeline) / t.iceBelowTreeline : 0;
    // Dry ground has no glaciers however high it lies relative to its (low) treeline.
    ice[c] = Math.max(t.ice[b] ?? 0, Math.min(1, Math.max(0, above)) * (1 - arid[c]!));
  }
  const head = /* wgsl */ `${grid.wgsl}${LINEAR_ID_WGSL}`;
  const main = (body: string) => /* wgsl */ `
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = linearId(gid, nwg);
  if (id >= CELL_COUNT) { return; }
  let c = i32(id);
${body}
}`;
  const spread = (decay: number) =>
    gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> vIn: array<f32>;
@group(0) @binding(1) var<storage, read_write> vOut: array<f32>;
${main(`  var m = vIn[id];
  for (var k = 0; k < 8; k++) {
    let nb = neighbor(c, k);
    if (nb >= 0) { m = max(m, ${decay} * vIn[nb]); }
  }
  vOut[id] = m;`)}`);
  const dilate = spread(0.97);
  const coast = spread(t.coastDecay);
  const blur = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> vIn: array<f32>;
@group(0) @binding(1) var<storage, read_write> vOut: array<f32>;
${main(`  var sum = 2.0 * vIn[id];
  var wsum = 2.0;
  for (var k = 0; k < 8; k++) {
    let nb = neighbor(c, k);
    if (nb >= 0) { sum += vIn[nb]; wsum += 1.0; }
  }
  vOut[id] = sum / wsum;`)}`);
  const pack = gpu.kernel(`${head}
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read> z: array<f32>;
@group(0) @binding(3) var<storage, read> w: array<f32>;
@group(0) @binding(4) var<storage, read_write> out: array<u32>;
${main(`  out[id] = pack4x8unorm(clamp(vec4f(a[id], b[id], z[id], w[id]), vec4f(0.0), vec4f(1.0)));`)}`);

  const names = ['mask.arid', 'mask.ice', 'mask.land', 'mask.sea', 'mask.tmp'];
  grid.upload('mask.arid', arid);
  grid.upload('mask.ice', ice);
  grid.upload('mask.land', land);
  grid.upload('mask.sea', sea);
  grid.map('mask.tmp');
  const passes = (kernel: GPUComputePipeline, name: string, n: number) => {
    for (let p = 0; p < n; p++) {
      gpu.dispatchLinear(kernel, [grid.get(name), grid.get('mask.tmp')], count);
      grid.swap(name, 'mask.tmp');
    }
  };
  passes(dilate, 'mask.ice', t.iceSpread);
  passes(blur, 'mask.ice', t.blurPasses);
  passes(blur, 'mask.arid', t.blurPasses);
  passes(coast, 'mask.land', t.landReach);
  passes(blur, 'mask.land', 2);
  passes(coast, 'mask.sea', t.seaReach);
  passes(blur, 'mask.sea', 2);
  const out = gpu.storage(count * 4, 'tiles.landformMasks');
  gpu.dispatchLinear(
    pack,
    [grid.get('mask.arid'), grid.get('mask.ice'), grid.get('mask.land'), grid.get('mask.sea'), out],
    count,
  );
  gpu.flush();
  for (const n of names) grid.release(n);
  return out;
}

/**
 * WGSL: `landformMasks(d)`, the bilinear mask vector at direction d, reading
 * `gMasks: array<u32>` on the global grid (needs the grid's WGSL).
 */
export const LANDFORM_MASK_WGSL = /* wgsl */ `
fn landformMasks(d: vec3f) -> vec4f {
  let face = dirFace(d);
  let uv = projectToFace(d, face);
  let fi = uv.x * f32(N) - 0.5;
  let fj = uv.y * f32(N) - 0.5;
  let i0 = i32(floor(fi));
  let j0 = i32(floor(fj));
  let tx = fi - floor(fi);
  let ty = fj - floor(fj);
  let a = unpack4x8unorm(gMasks[wrapCellSafe(face, i0, j0)]);
  let b = unpack4x8unorm(gMasks[wrapCellSafe(face, i0 + 1, j0)]);
  let c = unpack4x8unorm(gMasks[wrapCellSafe(face, i0, j0 + 1)]);
  let e = unpack4x8unorm(gMasks[wrapCellSafe(face, i0 + 1, j0 + 1)]);
  return mix(mix(a, b, tx), mix(c, e, tx), ty);
}
`;
