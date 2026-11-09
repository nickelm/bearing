/**
 * The global grid (decision 21): N × N cells per face as flat GPU storage
 * buffers, one buffer per map, with CubeGrid's index layout. Neighbors come
 * from gridWgsl's table-free addressing.
 */
import { CUBE_FACE_COUNT } from '../../core/coords';
import type { GpuContext } from './gpuContext';
import { gridWgsl } from './gridWgsl';

export type MapType = 'f32' | 'u32' | 'i32';

export class GlobalGrid {
  readonly cellCount: number;
  /** WGSL helpers for this N (prepend to kernels). */
  readonly wgsl: string;
  private readonly maps = new Map<string, { buffer: GPUBuffer; type: MapType }>();

  constructor(
    readonly gpu: GpuContext,
    readonly n: number,
  ) {
    this.cellCount = CUBE_FACE_COUNT * n * n;
    this.wgsl = gridWgsl(n);
  }

  /** Bytes per map (all maps are 4 bytes per cell). */
  get mapBytes(): number {
    return this.cellCount * 4;
  }

  /** Total bytes held in maps. */
  get bytes(): number {
    return this.maps.size * this.mapBytes;
  }

  has(name: string): boolean {
    return this.maps.has(name);
  }

  /** Allocates (or returns) a zero-filled map. */
  map(name: string, type: MapType = 'f32'): GPUBuffer {
    let m = this.maps.get(name);
    if (!m) {
      m = { buffer: this.gpu.storage(this.mapBytes, `grid.${name}`), type };
      this.maps.set(name, m);
    }
    return m.buffer;
  }

  /** Replaces a map's contents from the CPU. */
  upload(name: string, data: Float32Array | Uint32Array | Int32Array): GPUBuffer {
    if (data.length !== this.cellCount) {
      throw new RangeError(`Map ${name} has ${data.length} values, grid has ${this.cellCount}`);
    }
    const type: MapType =
      data instanceof Float32Array ? 'f32' : data instanceof Uint32Array ? 'u32' : 'i32';
    const b = this.map(name, type);
    this.gpu.write(b, data);
    return b;
  }

  async readF32(name: string): Promise<Float32Array> {
    return new Float32Array(await this.gpu.read(this.get(name)));
  }

  async readU32(name: string): Promise<Uint32Array> {
    return new Uint32Array(await this.gpu.read(this.get(name)));
  }

  async readI32(name: string): Promise<Int32Array> {
    return new Int32Array(await this.gpu.read(this.get(name)));
  }

  get(name: string): GPUBuffer {
    const m = this.maps.get(name);
    if (!m) throw new Error(`No grid map "${name}"`);
    return m.buffer;
  }

  /** Swaps the buffers behind two maps (ping-pong). */
  swap(a: string, b: string): void {
    const ma = this.maps.get(a);
    const mb = this.maps.get(b);
    if (!ma || !mb) throw new Error(`swap: missing map ${a} or ${b}`);
    this.maps.set(a, mb);
    this.maps.set(b, ma);
  }

  release(name: string): void {
    this.maps.get(name)?.buffer.destroy();
    this.maps.delete(name);
  }

  dispose(): void {
    for (const m of this.maps.values()) m.buffer.destroy();
    this.maps.clear();
  }
}
