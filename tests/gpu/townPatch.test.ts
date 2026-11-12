/** Town built-up patches from their urban extent polygons (V3), run as a compute kernel on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, float, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { latLonToDirection } from '../../src/core/coords';
import { tileForDirection } from '../../src/core/tiles';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { BUILT_TOWN, offsetPoint, townRadiusToward } from '../../src/render/sim/infra/infraScene';
import type { BuiltSite } from '../../src/render/sim/infra/infraScene';
import { LightShading, LightTables } from '../../src/render/sim/infra/roadShading';
import { URBAN_VERTICES } from '../../src/worldgen/strategic/graph';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('town patch outline (TSL on Dawn)', () => {
  it('follows the urban extent polygon by bearing', async () => {
    const R = PLANET_RADIUS;
    const c = latLonToDirection(41 * DEG, -7 * DEG);
    // A lopsided town: 1.2 km to the west, 3.4 km to the east.
    const outline = new Float32Array(URBAN_VERTICES);
    for (let k = 0; k < URBAN_VERTICES; k++)
      outline[k] = 2300 + 1100 * Math.cos((2 * Math.PI * k) / URBAN_VERTICES);
    // A second, outline-free record first, so the town's outline index is not trivially 0.
    const outlines = new Float32Array(2 * URBAN_VERTICES);
    outlines.set(outline, URBAN_VERTICES);
    const lights = Float32Array.from([...[c.x, c.y, c.z, 4000, 0.5, 1500, BUILT_TOWN, 2]]);
    const tables = new LightTables(lights, R, outlines);
    const shading = new LightShading(tables, R);
    const range = tables.rangeFor(tileForDirection(c, 9));
    const site: BuiltSite = {
      kind: 'town',
      point: c,
      radius: 3400,
      population: 1e5,
      heading: 0,
      runwayLength: 0,
      key: 't',
      outline,
    };
    // Points at 0.8 and 1.25 of the outline radius on 16 bearings (heading = compass).
    const pts: { inside: boolean }[] = [];
    const input: number[] = [];
    for (let k = 0; k < 16; k++) {
      const heading = (2 * Math.PI * k) / 16;
      const dir = offsetPoint(c, heading, 1000, 0, R);
      const r = townRadiusToward(site, dir);
      for (const [f, inside] of [
        [0.8, true],
        [1.25, false],
      ] as const) {
        const d = offsetPoint(c, heading, f * r, 0, R).scale(R + 100);
        input.push(d.x, d.y, d.z, 0);
        pts.push({ inside });
      }
    }
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const inBuf = instancedArray(Float32Array.from(input), 'vec4');
    const outBuf = instancedArray(pts.length, 'vec4');
    const kernel = Fn(() => {
      const p = inBuf.element(instanceIndex).xyz;
      const s = shading.sample(
        p as Node<'vec3'>,
        float(range.start) as Node<'float'>,
        float(range.count) as Node<'float'>,
        float(1) as Node<'float'>,
        float(0.5) as Node<'float'>,
      );
      outBuf.element(instanceIndex).assign(vec4(s.x, s.y, s.z, s.w));
    })().compute(pts.length);
    await head.renderer.computeAsync(kernel);
    const out = new Float32Array(await head.renderer.getArrayBufferAsync(outBuf.value));
    head.dispose();
    expect(gpu!.errors).toEqual([]);
    pts.forEach((p, i) => {
      const town = out[i * 4]!;
      if (p.inside) expect(town).toBeGreaterThan(0.5);
      else expect(town).toBe(0);
    });
  });
});
