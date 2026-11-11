/**
 * WebGPU is required, with no fallback. Erosion, terrain baking and line-of-sight
 * queries depend on compute shaders.
 *
 * Note: three's WebGPURenderer silently falls back to a WebGL 2 backend when
 * WebGPU is unavailable, logging only a console warning. We therefore check
 * twice: before creating the renderer, and again after `renderer.init()`.
 */
import type { WebGPURenderer } from 'three/webgpu';

/** Device limits that world generation raises to the adapter's maximum (decision 22). */
export type RequiredLimits = Record<string, number>;

/**
 * Returns the device limits to request when WebGPU is usable, otherwise a
 * reason string. The global grid at 2048² per face needs storage buffers of
 * about 100 MB, close to the default 128 MB binding limit, so we ask for what
 * the adapter offers.
 */
export async function probeWebGpu(): Promise<
  { adapter: GPUAdapter; limits: RequiredLimits } | { problem: string }
> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    return { problem: 'This browser does not expose WebGPU (navigator.gpu is undefined).' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return {
        problem:
          'WebGPU is present, but no GPU adapter is available. It may be disabled or blocklisted.',
      };
    }
    const l = adapter.limits;
    return {
      adapter,
      limits: {
        maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
        maxBufferSize: l.maxBufferSize,
        maxComputeWorkgroupsPerDimension: l.maxComputeWorkgroupsPerDimension,
        maxStorageBuffersPerShaderStage: l.maxStorageBuffersPerShaderStage,
      },
    };
  } catch (err) {
    return { problem: `Requesting a WebGPU adapter failed: ${String(err)}` };
  }
}

/**
 * Creates the device for the renderer on the probed adapter, with the raised
 * limits and every standard feature the adapter offers. Three's backend would
 * otherwise request its own adapter without a power preference, and on a laptop
 * with two GPUs the browser then hands out the integrated one (decision 69).
 */
export async function requestRendererDevice(
  adapter: GPUAdapter,
  limits: RequiredLimits,
): Promise<GPUDevice> {
  const features = [...adapter.features].filter(
    (f) => !f.startsWith('chromium-'),
  ) as GPUFeatureName[];
  return adapter.requestDevice({ requiredLimits: limits, requiredFeatures: features });
}

/** A short description of the adapter for the status panel, e.g. "nvidia blackwell". */
export function describeAdapter(adapter: GPUAdapter): string {
  const i = adapter.info;
  const name = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');
  return `${name || 'unknown GPU'}${i.isFallbackAdapter ? ' (software fallback)' : ''}`;
}

/** The raw GPUDevice behind three's WebGPU backend. Call after init(). */
export function rendererDevice(renderer: WebGPURenderer): GPUDevice {
  const device = (renderer.backend as unknown as { device?: GPUDevice }).device;
  if (!device) throw new Error('WebGPU backend has no device');
  return device;
}

/** True only if the renderer actually ended up on the WebGPU backend. Call after init(). */
export function isOnWebGpuBackend(renderer: WebGPURenderer): boolean {
  const backend = renderer.backend as { isWebGPUBackend?: boolean };
  return backend.isWebGPUBackend === true;
}

function fatalElement(): HTMLElement {
  const el =
    document.getElementById('fatal') ?? document.body.appendChild(document.createElement('div'));
  el.id = 'fatal';
  el.hidden = false;
  return el;
}

/** Shows a generic startup failure. */
export function showFatalError(reason: string): void {
  const el = fatalElement();
  el.innerHTML = `<h1>Bearing failed to start</h1><p class="reason"></p>
    <p>See the browser console for details.</p>`;
  el.querySelector('.reason')!.textContent = reason;
}

/** Replaces the page with an explanation of why Bearing cannot run. */
export function showWebGpuRequired(reason: string): void {
  const el = fatalElement();
  el.innerHTML = `
    <h1>Bearing needs WebGPU</h1>
    <p>Bearing generates and renders its planet with GPU compute shaders
       (erosion, terrain baking, line of sight), which require WebGPU.
       There is no WebGL fallback.</p>
    <p class="reason"></p>
    <p>Use a current desktop version of Chrome, Edge, Firefox or Safari with
       hardware acceleration enabled. You can check support at
       <a href="https://webgpureport.org" target="_blank" rel="noopener">webgpureport.org</a>.</p>`;
  el.querySelector('.reason')!.textContent = `Details: ${reason}`;
}
