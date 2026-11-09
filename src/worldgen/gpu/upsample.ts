/** Seam-aware bicubic upsampling of a tectonic-grid map onto the global grid (no warp). */
import type { GlobalGrid } from './globalGrid';
import { LINEAR_ID_WGSL } from './gpuContext';
import { bicubicSamplerWgsl, gridWgsl } from './gridWgsl';

/** Fills global map `name` from a tectonic map with `n` cells per face edge. */
export function upsampleMap(grid: GlobalGrid, n: number, data: Float32Array, name: string): void {
  if (data.length !== 6 * n * n) throw new RangeError(`Map has ${data.length} cells, not 6·${n}²`);
  const gpu = grid.gpu;
  const code = /* wgsl */ `${grid.wgsl}${gridWgsl(n, 't_')}${LINEAR_ID_WGSL}
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
${bicubicSamplerWgsl('sampleSrc', 'src', 't_')}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = linearId(gid, nwg);
  if (id >= CELL_COUNT) { return; }
  let c = i32(id);
  let inv = 1.0 / f32(N);
  dst[id] = sampleSrc(cellFace(c), (f32(cellI(c)) + 0.5) * inv, (f32(cellJ(c)) + 0.5) * inv);
}`;
  const src = gpu.storageFrom(data, `upsample.${name}`);
  gpu.dispatchLinear(gpu.kernel(code), [src, grid.map(name)], grid.cellCount);
  gpu.flush();
  src.destroy();
}
