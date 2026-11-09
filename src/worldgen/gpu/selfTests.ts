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
import { GlobalGrid } from './globalGrid';
import { LINEAR_ID_WGSL } from './gpuContext';
import type { GpuContext } from './gpuContext';

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

export const GPU_SELF_TESTS: GpuSelfTest[] = [
  { name: 'grid addressing (n = 3)', run: (gpu) => gridAddressing(gpu, 3) },
  { name: 'grid addressing (n = 64)', run: (gpu) => gridAddressing(gpu, 64) },
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
