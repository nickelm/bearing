/**
 * A thin layer over a raw GPUDevice for world-generation compute (decision 26).
 *
 * Kernels are plain WGSL. In the browser the device is three's own
 * (`renderer.backend.device`), so results can feed render textures. In tests
 * and offline tools it comes from Dawn's Node bindings (the `webgpu` package).
 *
 * Linear dispatch: a kernel over `count` items uses 64-wide workgroups laid
 * out in 2D, because one dispatch dimension is capped at 65,535 workgroups
 * (6 · 2048² cells need about 393k). Kernels recover the linear index with
 * `linearId(gid, nwg)` from LINEAR_ID_WGSL.
 */

export const WORKGROUP_SIZE = 64;
const MAX_GROUPS_X = 32768;

/** Prepend to any kernel that uses linear dispatch. */
export const LINEAR_ID_WGSL = /* wgsl */ `
fn linearId(gid: vec3u, nwg: vec3u) -> u32 {
  return gid.x + gid.y * nwg.x * ${WORKGROUP_SIZE}u;
}
`;

export type Binding = GPUBuffer | { buffer: GPUBuffer; offset?: number; size?: number };

export class GpuContext {
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  private encoder: GPUCommandEncoder | null = null;
  private pendingDispatches = 0;

  /** Uncaptured device errors (validation, out of memory) since creation. */
  readonly errors: string[] = [];

  constructor(readonly device: GPUDevice) {
    device.addEventListener('uncapturederror', (e) => {
      const message = (e as GPUUncapturedErrorEvent).error.message;
      this.errors.push(message);
      console.error('WebGPU error:', message);
    });
  }

  /** Compiles (once per source) a compute pipeline with an auto layout. */
  kernel(code: string, entryPoint = 'main'): GPUComputePipeline {
    const key = `${entryPoint}\n${code}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const module = this.device.createShaderModule({ code });
      p = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
      this.pipelines.set(key, p);
    }
    return p;
  }

  /** A zero-filled storage buffer that can be copied to and from. Size is rounded up to 4 bytes. */
  storage(byteLength: number, label?: string): GPUBuffer {
    return this.device.createBuffer({
      label,
      size: Math.max(4, Math.ceil(byteLength / 4) * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
  }

  /** A storage buffer initialized from `data`. */
  storageFrom(data: ArrayBufferView, label?: string): GPUBuffer {
    const b = this.storage(data.byteLength, label);
    this.write(b, data);
    return b;
  }

  /** A uniform buffer initialized from `data` (padded to 16 bytes). */
  uniformFrom(data: ArrayBufferView, label?: string): GPUBuffer {
    const b = this.device.createBuffer({
      label,
      size: Math.max(16, Math.ceil(data.byteLength / 16) * 16),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.write(b, data);
    return b;
  }

  write(buffer: GPUBuffer, data: ArrayBufferView, offset = 0): void {
    this.device.queue.writeBuffer(
      buffer,
      offset,
      data.buffer as ArrayBuffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  /** Records one dispatch. Bindings go to group 0, in binding order. Call flush() to submit. */
  dispatch(
    pipeline: GPUComputePipeline,
    bindings: readonly Binding[],
    groups: readonly [number, number?, number?],
  ): void {
    const entries: GPUBindGroupEntry[] = bindings.map((b, binding) => ({
      binding,
      resource: 'buffer' in b ? b : { buffer: b },
    }));
    const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    this.encoder ??= this.device.createCommandEncoder();
    const pass = this.encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(groups[0], groups[1] ?? 1, groups[2] ?? 1);
    pass.end();
    this.pendingDispatches++;
  }

  /** Records a dispatch over `count` items with the 2D linear layout. */
  dispatchLinear(pipeline: GPUComputePipeline, bindings: readonly Binding[], count: number): void {
    this.dispatch(pipeline, bindings, linearGroups(count));
  }

  /** Records a buffer-to-buffer copy. */
  copy(src: GPUBuffer, dst: GPUBuffer, byteLength = src.size, srcOffset = 0, dstOffset = 0): void {
    this.encoder ??= this.device.createCommandEncoder();
    this.encoder.copyBufferToBuffer(src, srcOffset, dst, dstOffset, byteLength);
  }

  get pending(): number {
    return this.pendingDispatches;
  }

  /** Submits everything recorded so far. */
  flush(): void {
    if (!this.encoder) return;
    this.device.queue.submit([this.encoder.finish()]);
    this.encoder = null;
    this.pendingDispatches = 0;
  }

  /**
   * Submits recorded work and resolves when the GPU has finished it.
   *
   * Implemented as a 4-byte readback rather than queue.onSubmittedWorkDone(),
   * which crashes Dawn's Node bindings (webgpu 0.6.2, Windows). Queue order
   * guarantees the copy runs after all earlier submissions.
   */
  async finish(): Promise<void> {
    this.fence ??= this.storage(4, 'fence');
    await this.read(this.fence, 4);
  }

  private fence: GPUBuffer | null = null;

  /** Flushes, then copies `byteLength` bytes of `buffer` back to the CPU. */
  async read(buffer: GPUBuffer, byteLength = buffer.size, offset = 0): Promise<ArrayBuffer> {
    const size = Math.ceil(byteLength / 4) * 4;
    const staging = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.copy(buffer, staging, size, offset, 0);
    this.flush();
    await staging.mapAsync(GPUMapMode.READ);
    const out = staging.getMappedRange().slice(0, byteLength);
    staging.unmap();
    staging.destroy();
    return out;
  }
}

/** Workgroup counts for `count` items: 64-wide groups, x capped, the rest in y. */
export function linearGroups(count: number): [number, number] {
  const groups = Math.max(1, Math.ceil(count / WORKGROUP_SIZE));
  const x = Math.min(groups, MAX_GROUPS_X);
  return [x, Math.ceil(groups / x)];
}
