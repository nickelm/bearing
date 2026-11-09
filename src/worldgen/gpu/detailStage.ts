/**
 * Stage: upsample the tectonic maps onto the global grid and add detail noise
 * (design doc, pipeline step 3; decision 21).
 *
 * For each global cell:
 *  1. Domain-warp its direction. The warp is strongest near coasts and on
 *     mountain ranges, so coastlines turn fractal and ranges bend.
 *  2. Sample tectonic height and uplift at the warped direction (seam-aware
 *     bicubic, clamped so it doesn't ring).
 *  3. Add ridged multifractal noise, amplified by uplift (peaks, spurs and
 *     passes on ranges), plus gentle fBm everywhere.
 *
 * Noise works in Earth-like reference meters and is multiplied by
 * reliefScale (decision 14). Octaves stop before their wavelength drops below
 * about three global cells, so nothing aliases. Randomness comes from
 * rng(seed, "detail") only.
 */
import { Noise3 } from '../../core/noise';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import type { GlobalGrid } from './globalGrid';
import { LINEAR_ID_WGSL } from './gpuContext';
import { bicubicSamplerWgsl, gridWgsl } from './gridWgsl';
import { NOISE_WGSL, PERMUTATION_SIZE, packPermutations } from './noiseWgsl';

/** Tuning knobs, in reference meters and unit-sphere frequencies (1 = one cycle per radian). */
export const DETAIL_TUNING = {
  /** Domain warp displacement at full strength (radians; 0.008 ≈ 8 km at R = 1,000 km). */
  warpAmplitude: 0.008,
  /** Warp everywhere, as a fraction of the full strength. */
  warpBaseline: 0.2,
  warpFrequency: 30,
  /** Reference-height half-width of the coastal warp band. */
  coastWidth: 300,
  /** Uplift (reference m) at which ranges warp fully. */
  ridgeUplift: [500, 2500] as const,
  ridgedFrequency: 60,
  /** Ridged amplitude on plains and in the ocean (reference m). */
  ridgedPlains: 60,
  ridgedOcean: 150,
  /** Extra ridged amplitude per meter of uplift. */
  ridgedPerUplift: 0.45,
  gentleFrequency: 20,
  gentleAmplitude: 70,
};

export interface TectonicMaps {
  /** Cells per face edge of the tectonic CubeGrid. */
  n: number;
  /** Physical height above sea level (m). */
  height: Float32Array;
  /** Boundary uplift (reference m). */
  uplift: Float32Array;
}

/** Octaves of noise with base frequency f0 whose wavelength stays above `minCells` global cells. */
export function octavesFor(f0: number, gridN: number, minCells = 3, max = 8): number {
  // A face spans π/2 radians, so a cell spans (π/2)/N; wavelength of octave o is 2π/(f0·2^o).
  const cell = Math.PI / 2 / gridN;
  let o = 0;
  while (o < max && (2 * Math.PI) / (f0 * 2 ** o) >= minCells * cell) o++;
  return Math.max(1, o);
}

/** Mean of `noise.ridged` over the sphere, estimated from fixed sample directions. */
function ridgedMean(noise: Noise3, frequency: number, octaves: number): number {
  const r = rng('detail-calibration', 'directions');
  let sum = 0;
  const samples = 4000;
  for (let k = 0; k < samples; k++) {
    const y = r.range(-1, 1);
    const az = r.range(0, 2 * Math.PI);
    const s = Math.sqrt(1 - y * y);
    sum += noise.ridged(
      s * Math.cos(az) * frequency,
      y * frequency,
      s * Math.sin(az) * frequency,
      octaves,
    );
  }
  return sum / samples;
}

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/**
 * Fills `grid` maps "height" (physical m) and "uplift" (reference m) from the
 * tectonic maps. Returns once the work is recorded; read a map to wait for it.
 */
export function runDetailStage(
  grid: GlobalGrid,
  tectonic: TectonicMaps,
  seed: WorldSeed,
  reliefScale: number,
  tuning = DETAIL_TUNING,
): void {
  const gpu = grid.gpu;
  const r = rng(seed, 'detail');
  const warp = new Noise3(r.fork('warp'));
  const ridged = new Noise3(r.fork('ridged'));
  const gentle = new Noise3(r.fork('gentle'));
  const ridgedOctaves = octavesFor(tuning.ridgedFrequency, grid.n);
  const gentleOctaves = octavesFor(tuning.gentleFrequency, grid.n);
  const mean = ridgedMean(ridged, tuning.ridgedFrequency, ridgedOctaves);
  const T = tectonic.n;
  const t = tuning;

  const code = /* wgsl */ `${grid.wgsl}${gridWgsl(T, 't_')}${LINEAR_ID_WGSL}
@group(0) @binding(0) var<storage, read> perm: array<u32>;
@group(0) @binding(1) var<storage, read> tHeight: array<f32>;
@group(0) @binding(2) var<storage, read> tUplift: array<f32>;
@group(0) @binding(3) var<storage, read_write> height: array<f32>;
@group(0) @binding(4) var<storage, read_write> uplift: array<f32>;
${NOISE_WGSL}
${bicubicSamplerWgsl('sampleHeight', 'tHeight', 't_')}
${bicubicSamplerWgsl('sampleUplift', 'tUplift', 't_')}

const RELIEF: f32 = ${f(reliefScale)};
const P_WARP: u32 = 0u;
const P_RIDGED: u32 = ${PERMUTATION_SIZE}u;
const P_GENTLE: u32 = ${2 * PERMUTATION_SIZE}u;

fn sampleAt(d: vec3f) -> vec2f {
  let face = dirFace(d);
  let uv = projectToFace(d, face);
  return vec2f(sampleHeight(face, uv.x, uv.y), sampleUplift(face, uv.x, uv.y));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = linearId(gid, nwg);
  if (id >= CELL_COUNT) { return; }
  let d = cellDir(i32(id));

  // 1. Warp, strongest on coasts and ranges.
  let s0 = sampleAt(d);
  let hRef0 = s0.x / RELIEF;
  let coast = exp(-(hRef0 * hRef0) / (${f(t.coastWidth)} * ${f(t.coastWidth)}));
  let ridge = smoothstep(${f(t.ridgeUplift[0])}, ${f(t.ridgeUplift[1])}, s0.y);
  let strength = ${f(t.warpBaseline)} + (1.0 - ${f(t.warpBaseline)}) * clamp(coast + 0.6 * ridge, 0.0, 1.0);
  let q = d * ${f(t.warpFrequency)};
  let w = vec3f(
    fbm3(q + vec3f(11.7, 0.0, 0.0), P_WARP, 4, 2.0, 0.5),
    fbm3(q + vec3f(0.0, 23.1, 0.0), P_WARP, 4, 2.0, 0.5),
    fbm3(q + vec3f(0.0, 0.0, 37.9), P_WARP, 4, 2.0, 0.5));
  let dw = normalize(d + ${f(t.warpAmplitude)} * strength * w);

  // 2. Tectonic maps at the warped position.
  let s = sampleAt(dw);

  // 3. Detail noise in reference meters.
  let landish = smoothstep(-400.0, 200.0, s.x / RELIEF);
  let amp = mix(${f(t.ridgedOcean)}, ${f(t.ridgedPlains)}, landish) + ${f(t.ridgedPerUplift)} * max(s.y, 0.0);
  let rd = ridged3(dw * ${f(t.ridgedFrequency)}, P_RIDGED, ${ridgedOctaves}, 2.0, 0.5) - ${f(mean)};
  let gn = fbm3(dw * ${f(t.gentleFrequency)}, P_GENTLE, ${gentleOctaves}, 2.0, 0.5) * ${f(t.gentleAmplitude)};
  height[id] = s.x + (amp * rd + gn) * RELIEF;
  uplift[id] = s.y;
}`;

  const perm = gpu.storageFrom(packPermutations([warp, ridged, gentle]), 'detail.perm');
  const tHeight = gpu.storageFrom(tectonic.height, 'tectonic.height');
  const tUplift = gpu.storageFrom(tectonic.uplift, 'tectonic.uplift');
  gpu.dispatchLinear(
    gpu.kernel(code),
    [perm, tHeight, tUplift, grid.map('height'), grid.map('uplift')],
    grid.cellCount,
  );
  gpu.flush();
  // Safe to destroy after submit: WebGPU keeps buffers alive until queued work completes.
  perm.destroy();
  tHeight.destroy();
  tUplift.destroy();
}
