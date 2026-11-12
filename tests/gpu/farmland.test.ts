/** Farmland in the simulation view (decision 127): LandShading's farm cover and field colors on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { Color } from 'three/webgpu';
import { FIELD_CELL, LandShading } from '../../src/render/sim/terrain/landShading';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();
type F = Node<'float'>;
type V3 = Node<'vec3'>;

async function run(
  input: Float32Array,
  body: (row: Node<'vec4'>) => Node<'vec4'>,
): Promise<Float32Array> {
  const n = input.length / 4;
  const inBuf = instancedArray(input, 'vec4');
  const out = instancedArray(n, 'vec4');
  const head = await headlessRenderer(gpu!.device, 64, 64);
  const kernel = Fn(() => {
    out
      .element(instanceIndex)
      .assign(body(inBuf.element(instanceIndex) as unknown as Node<'vec4'>));
  })().compute(n);
  await head.renderer.computeAsync(kernel);
  const r = new Float32Array(await head.renderer.getArrayBufferAsync(out.value));
  head.dispose();
  return r;
}

describe.skipIf(!gpu)('farmland (TSL on Dawn)', () => {
  it('farms settled, farmable, flat lowland, whole faces at a time', async () => {
    const land = new LandShading();
    // (settled, farmable, steep, elevation m), jitter 0.5.
    const cases = [
      [0.6, 1, 0.02, 300], // farmland
      [0.1, 1, 0.02, 300], // unsettled
      [0.6, 0, 0.02, 300], // not a farmable biome
      [0.6, 1, 0.3, 300], // steep
      [0.6, 1, 0.02, 2500], // high
      [0.35, 1, 0.02, 300], // half settled: the face decides
    ];
    const r = await run(Float32Array.from(cases.flat()), (c) => {
      const half = vec4(0.5).x as F;
      const args = [c.x, c.y, c.z, c.w] as F[];
      return vec4(
        land.farmCover(args[0]!, args[1]!, args[2]!, args[3]!, half, vec4(1).x as F),
        land.farmCover(args[0]!, args[1]!, args[2]!, args[3]!, half, vec4(0).x as F),
        0,
        0,
      );
    });
    expect(gpu!.errors).toEqual([]);
    const faceted = cases.map((_, i) => r[i * 4]);
    const smooth = cases.map((_, i) => r[i * 4 + 1]!);
    expect(faceted).toEqual([1, 0, 0, 0, 0, 1]);
    expect(smooth[0]).toBeCloseTo(1, 5);
    for (const k of [1, 2, 3, 4]) expect(smooth[k]).toBe(0);
    expect(smooth[5]).toBeGreaterThan(0);
    expect(smooth[5]).toBeLessThan(1);
  });

  it('paints fields of a few hundred meters in the four crop colors, blended when far', async () => {
    const land = new LandShading();
    const crops = [land.wheat, land.fallow, land.greenCrop, land.pasture].map((u) =>
      (u.value as Color).clone(),
    );
    // A line of points 10 m apart across several fields, at 1 m and 2 km footprints.
    const points: number[] = [];
    for (let k = 0; k < 300; k++) points.push(100 + k * 10, 1700, 900, 1);
    for (let k = 0; k < 300; k++) points.push(100 + k * 10, 1700, 900, 2000);
    const r = await run(Float32Array.from(points), (c) =>
      vec4(land.fieldColor(c.xyz as V3, vec4(0.5).x as F, c.w as F), 0),
    );
    expect(gpu!.errors).toEqual([]);
    const color = (i: number) => [r[i * 4]!, r[i * 4 + 1]!, r[i * 4 + 2]!];
    // Near: each color is a crop color within ±6%, and fields span many points.
    const nearest = (c: number[]) =>
      crops.reduce(
        (best, crop, k) => {
          const ratio = c[0]! / crop.r;
          const err = Math.max(Math.abs(c[1]! / crop.g - ratio), Math.abs(c[2]! / crop.b - ratio));
          return err < best.err ? { k, err, ratio } : best;
        },
        { k: -1, err: Infinity, ratio: 0 },
      );
    let changes = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const m = nearest(color(i));
      expect(m.err).toBeLessThan(1e-3);
      expect(Math.abs(m.ratio - 1)).toBeLessThanOrEqual(0.061);
      seen.add(m.k);
      if (i > 0 && color(i).some((x, c) => x !== color(i - 1)[c])) changes++;
    }
    // 3 km of line crosses about 3000 / FIELD_CELL fields: a few to a few dozen boundaries.
    expect(changes).toBeGreaterThan(3000 / FIELD_CELL / 3);
    expect(changes).toBeLessThan((3 * 3000) / FIELD_CELL);
    expect(seen.size).toBeGreaterThanOrEqual(2);
    // Far: the same fields drawn 60% toward the mean, so their spread shrinks.
    const spread = (from: number) => {
      const g = Array.from({ length: 300 }, (_, i) => color(from + i)[1]!);
      return Math.max(...g) - Math.min(...g);
    };
    expect(spread(300)).toBeLessThan(spread(0) * 0.45);
  });
});
