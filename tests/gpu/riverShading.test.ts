/** River coverage in TSL (decision 46), run as a compute kernel on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, float, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { latLonToDirection } from '../../src/core/coords';
import { tileForDirection } from '../../src/core/tiles';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { RiverShading } from '../../src/render/common/water/riverShading';
import { RiverTables } from '../../src/render/common/water/riverTables';
import { RiverIndex } from '../../src/worldgen/riverIndex';
import { straightRiver } from '../helpers/rivers';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('river coverage (TSL on Dawn)', () => {
  it('covers the river by its width, crisp at fine footprints, faded when sub-pixel', async () => {
    const R = PLANET_RADIUS;
    const tables = new RiverTables(new RiverIndex(straightRiver(40)), R);
    const shading = new RiverShading(tables, R);
    // Physical coverage for the checks (the app draws thin rivers more legibly).
    shading.legibility.value = 0;
    shading.minPixels.value = 1;
    const range = tables.rangeFor(tileForDirection(latLonToDirection(0, 10.25 * DEG), 9));
    // Points north of the river (at lon 10.25°), at these distances (m), with footprints (m/px).
    const cases: [number, number][] = [
      [0, 1],
      [15, 1],
      [19.4, 1],
      [20.6, 1],
      [30, 1],
      [0, 400],
      [300, 400],
    ];
    const input = new Float32Array(cases.length * 4);
    cases.forEach(([dist, fp], i) => {
      const d = latLonToDirection(dist / R, 10.25 * DEG).scale(R + 50);
      input.set([d.x, d.y, d.z, fp], i * 4);
    });
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const inBuf = instancedArray(input, 'vec4');
    const outBuf = instancedArray(cases.length, 'vec4');
    const kernel = Fn(() => {
      const p = inBuf.element(instanceIndex);
      const c = shading.coverage(
        p.xyz,
        float(range.start) as Node<'float'>,
        float(range.count) as Node<'float'>,
        p.w,
      );
      outBuf.element(instanceIndex).assign(vec4(c, 0, 0, 0));
    })().compute(cases.length);
    await head.renderer.computeAsync(kernel);
    const out = new Float32Array(await head.renderer.getArrayBufferAsync(outBuf.value));
    head.dispose();
    const cover = cases.map((_, i) => out[i * 4]!);
    expect(gpu!.errors).toEqual([]);
    expect(cover[0]).toBeCloseTo(1, 3); // on the centerline
    expect(cover[1]).toBeCloseTo(1, 3); // inside the 20 m half-width
    expect(cover[2]).toBeGreaterThan(0.8); // just inside the bank
    expect(cover[3]).toBeLessThan(0.2); // just outside
    expect(cover[4]).toBe(0);
    // A 40 m river in 400 m pixels: about 40/400 of the pixel, not 0 or 1.
    expect(cover[5]).toBeGreaterThan(0.05);
    expect(cover[5]).toBeLessThan(0.2);
    // Under a pixel from the river: only the antialiasing ramp's tail.
    expect(cover[6]).toBeLessThan(0.05);
  });
});
