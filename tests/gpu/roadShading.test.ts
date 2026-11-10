/** Road and pavement coverage in TSL (decision 65), run as a compute kernel on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, float, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { latLonToDirection } from '../../src/core/coords';
import { tileForDirection } from '../../src/core/tiles';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { RoadShading } from '../../src/render/infra/roadShading';
import { RiverTables } from '../../src/render/water/riverTables';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('road coverage (TSL on Dawn)', () => {
  it('draws asphalt and concrete by width and flags concrete', async () => {
    const R = PLANET_RADIUS;
    // A 10 m road along the equator, and a 45 m runway 1 km north of it (negative width).
    const seg = (lat: number, w: number) => {
      const a = latLonToDirection(lat, 10 * DEG);
      const b = latLonToDirection(lat, 10.05 * DEG);
      return [a.x, a.y, a.z, b.x, b.y, b.z, w, w];
    };
    const data = Float64Array.from([...seg(0, 10), ...seg(1000 / R, -45)]);
    const tables = new RiverTables({ segments: { count: 2, data } }, R);
    const shading = new RoadShading(tables, R);
    shading.style.legibility.value = 0;
    shading.style.minPixels.value = 1;
    const range = tables.rangeFor(tileForDirection(latLonToDirection(0, 10.025 * DEG), 9));
    // North offsets from the equator (m), footprint 1 m.
    const offsets = [0, 4, 8, 1000, 1020, 1030];
    const input = new Float32Array(offsets.length * 4);
    offsets.forEach((o, i) => {
      const d = latLonToDirection(o / R, 10.025 * DEG).scale(R + 50);
      input.set([d.x, d.y, d.z, 1], i * 4);
    });
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const inBuf = instancedArray(input, 'vec4');
    const outBuf = instancedArray(offsets.length, 'vec4');
    const kernel = Fn(() => {
      const p = inBuf.element(instanceIndex);
      const c = shading.coverage(
        p.xyz,
        float(range.start) as Node<'float'>,
        float(range.count) as Node<'float'>,
        p.w,
      );
      outBuf.element(instanceIndex).assign(vec4(c.x, c.y, 0, 0));
    })().compute(offsets.length);
    await head.renderer.computeAsync(kernel);
    const out = new Float32Array(await head.renderer.getArrayBufferAsync(outBuf.value));
    head.dispose();
    const at = (i: number) => [out[i * 4]!, out[i * 4 + 1]!];
    expect(gpu!.errors).toEqual([]);
    expect(at(0)[0]).toBeCloseTo(1, 3); // road centerline: asphalt
    expect(at(0)[1]).toBe(0);
    expect(at(1)[0]).toBeGreaterThan(0.9); // inside the 5 m half-width
    expect(at(2)[0]).toBe(0); // beyond it
    expect(at(3)[0]).toBeCloseTo(1, 3); // runway centerline: concrete
    expect(at(3)[1]).toBeCloseTo(1, 3);
    expect(at(4)[1]).toBeGreaterThan(0.9); // inside the 22.5 m half-width
    expect(at(5)[0]).toBe(0);
  });
});
