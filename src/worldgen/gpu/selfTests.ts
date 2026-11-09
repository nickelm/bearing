/**
 * GPU self-tests: checks of WGSL kernels against their CPU references.
 *
 * The same functions run in Vitest on Dawn (tests/gpu/selfTests.test.ts) and
 * in the browser on the render device (debug GUI → Self-tests), so a kernel
 * that is right in Node but miscompiled by a browser's shader compiler still
 * shows up. Each test resolves to null on success or a failure message.
 */
import { CubeGrid, NEIGHBOR_OFFSETS } from '../../core/cubeGrid';
import { neighborCell } from '../../core/faceAdjacency';
import { Noise3 } from '../../core/noise';
import { rng } from '../../core/rng';
import { GlobalGrid } from './globalGrid';
import { LINEAR_ID_WGSL } from './gpuContext';
import type { GpuContext } from './gpuContext';
import { NOISE_WGSL, PERMUTATION_SIZE, packPermutations } from './noiseWgsl';

export interface GpuSelfTest {
  name: string;
  run(gpu: GpuContext): Promise<string | null>;
}

async function gridAddressing(gpu: GpuContext, n: number): Promise<string | null> {
  const g = new GlobalGrid(gpu, n);
  const cpu = new CubeGrid(n);
  const dir = gpu.storage(g.cellCount * 16);
  const back = g.map('back', 'i32');
  const nb = gpu.storage(g.cellCount * 8 * 4);
  try {
    const head = `${g.wgsl}${LINEAR_ID_WGSL}`;
    const dirCode = `${head}
@group(0) @binding(0) var<storage, read_write> dir: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> back: array<i32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = linearId(gid, nwg);
  if (id >= CELL_COUNT) { return; }
  let d = cellDir(i32(id));
  dir[id] = vec4f(d, 0.0);
  back[id] = dirCell(d);
}`;
    const nbCode = `${head}
@group(0) @binding(0) var<storage, read_write> nb: array<i32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = linearId(gid, nwg);
  if (id >= CELL_COUNT * 8u) { return; }
  nb[id] = neighbor(i32(id / 8u), i32(id % 8u));
}`;
    gpu.dispatchLinear(gpu.kernel(dirCode), [dir, back], g.cellCount);
    gpu.dispatchLinear(gpu.kernel(nbCode), [nb], g.cellCount * 8);
    const neighbors = new Int32Array(await gpu.read(nb));
    const dirs = new Float32Array(await gpu.read(dir));
    const backs = await g.readI32('back');
    let maxErr = 0;
    for (let c = 0; c < g.cellCount; c++) {
      for (let k = 0; k < 8; k++) {
        const [di, dj] = NEIGHBOR_OFFSETS[k]!;
        const want = neighborCell(n, c, di, dj);
        if (neighbors[c * 8 + k] !== want) {
          return `cell ${c} neighbor ${k}: GPU ${neighbors[c * 8 + k]}, CPU ${want}`;
        }
      }
      for (let a = 0; a < 3; a++) {
        maxErr = Math.max(maxErr, Math.abs(dirs[c * 4 + a]! - cpu.centers[c * 3 + a]!));
      }
      if (backs[c] !== c) return `direction of cell ${c} maps back to ${backs[c]}`;
    }
    if (maxErr > 2e-6) return `cell directions differ by up to ${maxErr.toExponential(2)}`;
    return null;
  } finally {
    g.dispose();
    dir.destroy();
    nb.destroy();
  }
}

/** GPU noise vs core/noise.ts at seeded random points, two tables to exercise `base`. */
async function noiseAgreement(gpu: GpuContext): Promise<string | null> {
  const r = rng('self-test', 'noise');
  const noises = [new Noise3(r.fork('a')), new Noise3(r.fork('b'))];
  const count = 4096;
  const pts = new Float32Array(count * 4);
  for (let k = 0; k < count; k++) {
    // Mix of small and large magnitudes, both signs.
    const scale = k % 2 === 0 ? 3 : 60;
    pts[k * 4] = r.range(-scale, scale);
    pts[k * 4 + 1] = r.range(-scale, scale);
    pts[k * 4 + 2] = r.range(-scale, scale);
  }
  const perm = gpu.storageFrom(packPermutations(noises));
  const inBuf = gpu.storageFrom(pts);
  const outBuf = gpu.storage(count * 16);
  try {
    const code = `${LINEAR_ID_WGSL}
@group(0) @binding(0) var<storage, read> perm: array<u32>;
@group(0) @binding(1) var<storage, read> pts: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outv: array<vec4f>;
${NOISE_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = linearId(gid, nwg);
  if (id >= ${count}u) { return; }
  let q = pts[id].xyz;
  let base = (id % 2u) * ${PERMUTATION_SIZE}u;
  outv[id] = vec4f(noise3(q, base), fbm3(q, base, 5, 2.0, 0.5), ridged3(q, base, 4, 2.0, 0.5), 0.0);
}`;
    gpu.dispatchLinear(gpu.kernel(code), [perm, inBuf, outBuf], count);
    const out = new Float32Array(await gpu.read(outBuf));
    let maxErr = 0;
    let worst = '';
    for (let k = 0; k < count; k++) {
      const n = noises[k % 2]!;
      const x = pts[k * 4]!;
      const y = pts[k * 4 + 1]!;
      const z = pts[k * 4 + 2]!;
      const want = [n.noise(x, y, z), n.fbm(x, y, z, 5), n.ridged(x, y, z, 4)];
      for (let a = 0; a < 3; a++) {
        const e = Math.abs(out[k * 4 + a]! - want[a]!);
        if (e > maxErr) {
          maxErr = e;
          worst = `point ${k} (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}) fn ${a}: GPU ${out[k * 4 + a]}, CPU ${want[a]}`;
        }
      }
    }
    // float32 coordinates near 60 carry ~4e-6 error; noise gradients are O(1) per octave.
    return maxErr > 2e-4 ? `max error ${maxErr.toExponential(2)} at ${worst}` : null;
  } finally {
    perm.destroy();
    inBuf.destroy();
    outBuf.destroy();
  }
}

export const GPU_SELF_TESTS: GpuSelfTest[] = [
  { name: 'grid addressing (n = 3)', run: (gpu) => gridAddressing(gpu, 3) },
  { name: 'grid addressing (n = 64)', run: (gpu) => gridAddressing(gpu, 64) },
  { name: 'noise (Perlin, fBm, ridged)', run: noiseAgreement },
];

/** Runs one self-test and converts exceptions and device errors into failures. */
export async function runSelfTest(gpu: GpuContext, t: GpuSelfTest): Promise<string | null> {
  const before = gpu.errors.length;
  try {
    const result = await t.run(gpu);
    await gpu.finish();
    if (gpu.errors.length > before) return `GPU error: ${gpu.errors.slice(before).join(' | ')}`;
    return result;
  } catch (err) {
    return `threw: ${String(err)}`;
  }
}
