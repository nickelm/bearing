/** Render-only country lanes and villages (decision 66), as a compute kernel on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, float, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { latLonToDirection } from '../../src/core/coords';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { localNetwork, RoadStyle } from '../../src/render/infra/roadShading';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('local lanes (TSL on Dawn)', () => {
  it('draws lanes and village lights on habitable land, none on barren land', async () => {
    const R = PLANET_RADIUS;
    // A 40 × 40 km patch sampled every 100 m, at 1 m per pixel.
    const side = 400;
    const input = new Float32Array(side * side * 4);
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const d = latLonToDirection(
          (20 + (j * 100) / R / DEG) * DEG,
          (30 + (i * 100) / R / DEG) * DEG,
        );
        input.set([d.x * (R + 100), d.y * (R + 100), d.z * (R + 100), 1], (j * side + i) * 4);
      }
    }
    const run = async (hab: number) => {
      const head = await headlessRenderer(gpu!.device, 64, 64);
      const style = new RoadStyle();
      style.legibility.value = 1;
      style.minPixels.value = 60; // 30 m either side, so 100 m samples catch lanes
      const inBuf = instancedArray(input, 'vec4');
      const outBuf = instancedArray(side * side, 'vec4');
      const kernel = Fn(() => {
        const p = inBuf.element(instanceIndex);
        const v = localNetwork(p.xyz, float(hab) as Node<'float'>, p.w, R, style);
        outBuf.element(instanceIndex).assign(vec4(v.x, v.y, 0, 0));
      })().compute(side * side);
      await head.renderer.computeAsync(kernel);
      const out = new Float32Array(await head.renderer.getArrayBufferAsync(outBuf.value));
      head.dispose();
      let lane = 0;
      let lit = 0;
      for (let k = 0; k < side * side; k++) {
        if (out[k * 4]! > 0.5) lane++;
        if (out[k * 4 + 1]! > 0.25) lit++;
      }
      return { lane: lane / (side * side), lit: lit / (side * side) };
    };
    const fertile = await run(0.6);
    const barren = await run(0.05);
    expect(gpu!.errors).toEqual([]);
    console.log('fertile', fertile, 'barren', barren);
    // Lanes 60 m wide every few km cover a few percent of the land.
    expect(fertile.lane).toBeGreaterThan(0.01);
    expect(fertile.lane).toBeLessThan(0.2);
    expect(fertile.lit).toBeGreaterThan(0.001);
    expect(barren.lane).toBe(0);
    expect(barren.lit).toBe(0);
  });
});
