/**
 * Cloud coverage over time (decisions 55, 58), run as a TSL compute kernel on
 * Dawn: no place may be overcast all the time, and the clouds must move.
 */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import { randomUnitVector } from '../../src/core/coords';
import { rng } from '../../src/core/rng';
import { HOUR, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { ClimateTexture } from '../../src/render/climateTexture';
import { CloudLayer } from '../../src/render/clouds/cloudLayer';
import { PlanetLighting } from '../../src/render/lighting/planetLighting';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('cloud coverage (TSL on Dawn)', () => {
  it('clears everywhere regularly, wet places included, and moves', async () => {
    const world = generateWorld({ ...DEFAULT_PLANET_PARAMS, seed: 3 }, { resolution: 32 });
    const climate = new ClimateTexture();
    climate.setWorld(world);
    const clouds = new CloudLayer(PLANET_RADIUS, new PlanetLighting(), climate);

    const points = 512;
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
    const sample = async (t: number) => {
      clouds.time.value = t;
      await head.renderer.computeAsync(kernel);
      const out = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
      return Array.from({ length: points }, (_, i) => out[i * 4]!);
    };

    const times = Array.from({ length: 24 }, (_, k) => k * 12 * HOUR);
    const series = [];
    for (const t of times) series.push(await sample(t));
    const nearby = await sample(times[1]! + HOUR);
    head.dispose();
    expect(gpu!.errors).toEqual([]);

    // Fraction of samples at each point with mostly clear sky.
    let worstClear = 1;
    let mean = 0;
    for (let i = 0; i < points; i++) {
      let clear = 0;
      for (const s of series) {
        if (s[i]! < 0.3) clear++;
        mean += s[i]! / (points * series.length);
      }
      if (process.env.DEBUG && clear / series.length < 0.25) {
        console.log(
          'cloudy point lat',
          ((Math.asin(dirs[i * 4 + 1]!) * 180) / Math.PI).toFixed(1),
          'clear',
          clear,
        );
      }
      worstClear = Math.min(worstClear, clear / series.length);
    }
    // No place is overcast all the time: even the cloudiest sees sun about one time in six.
    expect(worstClear).toBeGreaterThanOrEqual(0.15);
    expect(mean).toBeGreaterThan(0.15);
    expect(mean).toBeLessThan(0.55);

    // The field moves: coverage changes between samples 12 h apart, and only a little in 1 h.
    const change = (a: number[], b: number[]) =>
      a.reduce((sum, x, i) => sum + Math.abs(x - b[i]!), 0) / points;
    expect(change(series[0]!, series[1]!)).toBeGreaterThan(0.05);
    expect(change(series[1]!, nearby)).toBeLessThan(change(series[0]!, series[1]!));
  }, 120_000);
});
