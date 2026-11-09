/**
 * A tiny GPU compute round-trip run once at startup. It proves that TSL compute
 * nodes compile, dispatch and read back on this machine, since world generation
 * will depend on that path.
 */
import type { WebGPURenderer } from 'three/webgpu';
import { Fn, float, instanceIndex, instancedArray } from 'three/tsl';

export async function runComputeSmokeTest(
  renderer: WebGPURenderer,
  count = 1024,
): Promise<boolean> {
  const buffer = instancedArray(count, 'float');
  const fill = Fn(() => {
    buffer.element(instanceIndex).assign(float(instanceIndex).mul(2).add(1));
  })().compute(count);

  await renderer.computeAsync(fill);
  const data = new Float32Array(await renderer.getArrayBufferAsync(buffer.value));
  for (let i = 0; i < count; i++) {
    if (data[i] !== 2 * i + 1) return false;
  }
  return true;
}
