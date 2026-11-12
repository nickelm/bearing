/** Rock and snow by face (decision 125): LandShading's cover functions as a compute kernel on Dawn. */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { LandShading } from '../../src/render/sim/terrain/landShading';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();
type F = Node<'float'>;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

describe.skipIf(!gpu)('rock and snow by face (TSL on Dawn)', () => {
  it('switches whole faces when faceted and blends when smooth', async () => {
    const land = new LandShading();
    // (steep, noise, jitter, temperature °C); moisture 0.5 throughout.
    const cases: number[][] = [];
    for (let k = 0; k <= 40; k++) cases.push([k * 0.025, 0, 0.5, 5 - k * 0.25]);
    for (let k = 0; k < 40; k++) cases.push([0.5, (k % 5) * 0.1 - 0.2, (k * 0.37) % 1, -2.5]);
    const n = cases.length;
    const input = instancedArray(Float32Array.from(cases.flat()), 'vec4');
    const out = instancedArray(n, 'vec4');
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const kernel = Fn(() => {
      const c = input.element(instanceIndex) as unknown as Node<'vec4'>;
      const [steep, noise, jitter, t] = [c.x, c.y, c.z, c.w] as F[];
      const moisture = vec4(0.5).x as F;
      const one = vec4(1).x as F;
      const zero = vec4(0).x as F;
      out
        .element(instanceIndex)
        .assign(
          vec4(
            land.rockCover(steep!, noise!, jitter!, one),
            land.rockCover(steep!, noise!, jitter!, zero),
            land.snowCover(t!, steep!, moisture, jitter!, one),
            land.snowCover(t!, steep!, moisture, jitter!, zero),
          ),
        );
    })().compute(n);
    await head.renderer.computeAsync(kernel);
    const r = new Float32Array(await head.renderer.getArrayBufferAsync(out.value));
    head.dispose();
    expect(gpu!.errors).toEqual([]);

    cases.forEach(([steep, noise, jitter, t], i) => {
      const [rockFace, rockSmooth, snowFace, snowSmooth] = r.subarray(i * 4, i * 4 + 4);
      // Faceted: all or nothing.
      expect([0, 1]).toContain(rockFace);
      expect([0, 1]).toContain(snowFace);
      // Smooth: the blends of before (decision 43).
      expect(rockSmooth).toBeCloseTo(smoothstep(0.35, 0.7, steep! + noise! * 0.15), 5);
      const snow =
        smoothstep(0, -5, t!) * (1 - smoothstep(0.9, 1.5, steep!)) * smoothstep(0.03, 0.2, 0.5);
      expect(snowSmooth).toBeCloseTo(snow, 5);
      // A face is rock where the smooth cover is past about half, snow likewise.
      if (jitter === 0.5 && noise === 0) {
        expect(rockFace).toBe(steep! >= 0.52 ? 1 : 0);
        expect(snowFace).toBe(snow >= 0.5 ? 1 : 0);
      }
    });
    // The jitter dithers the line: at the threshold, some faces are rock and some not.
    const dithered = cases.slice(41).map((_, k) => r[(41 + k) * 4]!);
    expect(dithered).toContain(0);
    expect(dithered).toContain(1);
  });
});
