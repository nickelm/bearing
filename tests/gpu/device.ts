/**
 * A real GPU for Vitest via Dawn's Node bindings (the `webgpu` package).
 * Resolves to null when no adapter is available (e.g. CI without a GPU), so
 * GPU tests can `describe.skipIf(!gpu)`.
 */
import { GpuContext } from '../../src/worldgen/gpu/gpuContext';

let cached: Promise<GpuContext | null> | null = null;
let instance: GPU | null = null;

export function testGpu(): Promise<GpuContext | null> {
  cached ??= (async () => {
    try {
      const { create, globals } = await import('webgpu');
      Object.assign(globalThis, globals);
      // Keep a reference: if the GPU object is collected, Dawn tears down its instance.
      instance = create([]);
      const gpu = instance;
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize,
          maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
        },
      });
      return new GpuContext(device);
    } catch (err) {
      console.warn('No WebGPU for tests:', err);
      return null;
    }
  })();
  return cached;
}

/**
 * Runs `fn`, waits for the GPU, and throws if any device error was raised meanwhile.
 * Uses the uncapturederror event (GpuContext.errors) because error scopes crash
 * Dawn's Node bindings once a buffer has been mapped (webgpu 0.6.2, Windows).
 */
export async function expectNoGpuErrors<T>(gpu: GpuContext, fn: () => Promise<T>): Promise<T> {
  const before = gpu.errors.length;
  const result = await fn();
  await gpu.finish();
  if (gpu.errors.length > before) {
    throw new Error(`GPU errors: ${gpu.errors.slice(before).join(' | ')}`);
  }
  return result;
}
