/**
 * Cloud coverage from the weather texture (decisions 55, 59, 68), run as a
 * TSL compute kernel on Dawn: the mean coverage follows the weather's cover
 * fraction, and the detail field moves.
 */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import { randomUnitVector } from '../../src/core/coords';
import { rng } from '../../src/core/rng';
import { HOUR, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { CloudLayer } from '../../src/render/clouds/cloudLayer';
import { WeatherTexture } from '../../src/render/clouds/weatherTexture';
import { PlanetLighting } from '../../src/render/lighting/planetLighting';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('cloud coverage (TSL on Dawn)', () => {
  it('follows the weather cover fraction, and the detail moves', async () => {
    const weather = new WeatherTexture();
    const clouds = new CloudLayer(PLANET_RADIUS, new PlanetLighting(), weather);

    const points = 1024;
    const dirs = new Float32Array(points * 4);
    const r = rng(1, 'test/clouds');
    const d = new Vec3d();
    for (let i = 0; i < points; i++) {
      randomUnitVector(r, d);
      dirs.set([d.x, d.y, d.z, 0], i * 4);
    }
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const input = instancedArray(dirs, 'vec4');
    const output = instancedArray(points, 'vec4');
    const kernel = Fn(() => {
      output
        .element(instanceIndex)
        .assign(vec4(clouds.coverage(input.element(instanceIndex).xyz), 0, 0, 0));
    })().compute(points);
    const sample = async (cover: number, t: number) => {
      weather.fill(cover);
      clouds.time.value = t;
      await head.renderer.computeAsync(kernel);
      const out = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
      return Array.from({ length: points }, (_, i) => out[i * 4]!);
    };
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

    const clear = await sample(0, 0);
    const overcast = await sample(1, 0);
    const half = await sample(0.5, 0);
    const later = await sample(0.5, 12 * HOUR);
    const soon = await sample(0.5, HOUR);
    head.dispose();
    expect(gpu!.errors).toEqual([]);

    expect(mean(clear)).toBeLessThan(0.02);
    expect(mean(overcast)).toBeGreaterThan(0.97);
    expect(mean(half)).toBeGreaterThan(0.3);
    expect(mean(half)).toBeLessThan(0.7);

    // The detail field moves: more change over 12 h than over 1 h.
    const change = (a: number[], b: number[]) =>
      a.reduce((sum, x, i) => sum + Math.abs(x - b[i]!), 0) / points;
    expect(change(half, later)).toBeGreaterThan(0.05);
    expect(change(half, soon)).toBeLessThan(change(half, later));
  }, 120_000);
});
