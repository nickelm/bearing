/**
 * The live weather's cloud field as both views read it (decision 89): the
 * simulation view's cloud layer bakes coverage and precipitation from the weather
 * model into a cube-face atlas (decisions 68, 69), and the strategic map draws its
 * stylized clouds from the same bake. The app hands the cloud layer to the map
 * through this interface, so `strategic/` never imports `sim/`.
 */
import type { Node, WebGPURenderer } from 'three/webgpu';

export interface WeatherField {
  /** Baked (coverage 0..1, precipitation fraction 0..1) at a direction (any length). */
  sampleCoverage(direction: Node<'vec3'>): Node<'vec2'>;
  /** Re-bakes when the field has moved; call once per frame from the active view. */
  bake(renderer: WebGPURenderer, nowMs: number): boolean;
}
