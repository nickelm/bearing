/**
 * Cloud coverage from the weather texture (decisions 55, 59, 68), run as a
 * TSL compute kernel on Dawn: the mean coverage follows the weather's cover
 * fraction, and the detail field moves.
 */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import { directionToFace, randomUnitVector } from '../../src/core/coords';
import { rng } from '../../src/core/rng';
import { HOUR, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { CloudLayer } from '../../src/render/sim/clouds/cloudLayer';
import { WeatherTexture } from '../../src/render/sim/clouds/weatherTexture';
import { PlanetLighting } from '../../src/render/sim/lighting/planetLighting';
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

  it('bakes coverage that matches the field, continuous across face seams', async () => {
    const weather = new WeatherTexture();
    const clouds = new CloudLayer(PLANET_RADIUS, new PlanetLighting(), weather);
    const head = await headlessRenderer(gpu!.device, 64, 64);
    weather.fill(0.5, 0.25);
    clouds.time.value = 5 * HOUR;
    clouds.baked.bake(head.renderer, clouds.time.value, 'test', 0);

    // Random directions, plus pairs straddling face seams (a tiny step apart).
    const r = rng(2, 'test/clouds-bake');
    const d = new Vec3d();
    const pairs = 512;
    const dirs = new Float32Array(pairs * 2 * 4);
    for (let i = 0; i < pairs; i++) {
      randomUnitVector(r, d);
      if (i % 2 === 0) {
        // Push onto the seam between the two largest components.
        const a = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)];
        const order = [0, 1, 2].sort((p, q) => a[q]! - a[p]!);
        const c = [d.x, d.y, d.z];
        c[order[1]!] = Math.sign(c[order[1]!]!) * a[order[0]!]!;
        d.set(c[0]!, c[1]!, c[2]!).normalize();
      }
      dirs.set([d.x, d.y, d.z, 0], i * 8);
      const e = new Vec3d(d.x + 1e-4, d.y - 1e-4, d.z + 5e-5).normalize();
      dirs.set([e.x, e.y, e.z, 0], i * 8 + 4);
    }
    const input = instancedArray(dirs, 'vec4');
    const output = instancedArray(pairs * 2, 'vec4');
    const kernel = Fn(() => {
      const dir = input.element(instanceIndex).xyz;
      const b = clouds.baked.sample(dir);
      output.element(instanceIndex).assign(vec4(clouds.coverage(dir), b.x, b.y, 0));
    })().compute(pairs * 2);
    await head.renderer.computeAsync(kernel);
    const out = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
    head.dispose();
    expect(gpu!.errors).toEqual([]);

    let diff = 0;
    for (let i = 0; i < pairs * 2; i++) {
      diff += Math.abs(out[i * 4]! - out[i * 4 + 1]!);
      // Precipitation comes through the bake too.
      expect(out[i * 4 + 2]!).toBeCloseTo(0.25, 1);
    }
    // Steps of about 150 m: the baked field must change about as little as the true one,
    // on face seams (even pairs) too, where the two faces' lattices meet.
    let bakedStep = 0;
    let trueStep = 0;
    let worst = 0;
    for (let i = 0; i < pairs; i += 2) {
      const j = Math.abs(out[i * 8 + 1]! - out[i * 8 + 5]!);
      bakedStep += j;
      trueStep += Math.abs(out[i * 8]! - out[i * 8 + 4]!);
      worst = Math.max(worst, j);
    }
    // About 2 km texels against a field with ~2 km detail: close on average, on every face.
    const faceDiff = [0, 0, 0, 0, 0, 0];
    const faceCount = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < pairs * 2; i++) {
      const f = directionToFace(new Vec3d(dirs[i * 4]!, dirs[i * 4 + 1]!, dirs[i * 4 + 2]!));
      faceDiff[f] += Math.abs(out[i * 4]! - out[i * 4 + 1]!);
      faceCount[f]++;
    }
    for (let f = 0; f < 6; f++) expect(faceDiff[f]! / faceCount[f]!).toBeLessThan(0.08);
    expect(diff / (pairs * 2)).toBeLessThan(0.06);
    expect(bakedStep / (pairs / 2)).toBeLessThan(trueStep / (pairs / 2) + 0.01);
    expect(worst).toBeLessThan(0.2);
  }, 120_000);
});
