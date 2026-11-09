/**
 * WebGPU is required, with no fallback. Erosion, terrain baking and line-of-sight
 * queries depend on compute shaders.
 *
 * Note: three's WebGPURenderer silently falls back to a WebGL 2 backend when
 * WebGPU is unavailable, logging only a console warning. We therefore check
 * twice: before creating the renderer, and again after `renderer.init()`.
 */
import type { WebGPURenderer } from 'three/webgpu';

/** Returns null when WebGPU is usable, otherwise a reason string. */
export async function probeWebGpu(): Promise<string | null> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    return 'This browser does not expose WebGPU (navigator.gpu is undefined).';
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return 'WebGPU is present, but no GPU adapter is available. It may be disabled or blocklisted.';
    }
  } catch (err) {
    return `Requesting a WebGPU adapter failed: ${String(err)}`;
  }
  return null;
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
