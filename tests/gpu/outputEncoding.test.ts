/**
 * The headless renderer must encode to sRGB exactly once, as the browser canvas does
 * (decision 100): linear 0.0135 is sRGB 30/255.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene } from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('headless renderer output', () => {
  it('encodes linear color to sRGB once', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const scene = new Scene();
    scene.backgroundNode = vec3(0.0135, 0.214, 1);
    head.renderer.render(scene, new PerspectiveCamera());
    await gpu!.finish();
    const rgb = await head.readRgb();
    // sRGB(0.0135) = 30, sRGB(0.214) = 128, sRGB(1) = 255; half-float rounding allows ±2.
    expect(Math.abs(rgb[0]! - 30)).toBeLessThanOrEqual(2);
    expect(Math.abs(rgb[1]! - 128)).toBeLessThanOrEqual(2);
    expect(rgb[2]).toBe(255);
    head.dispose();
  }, 120_000);
});
