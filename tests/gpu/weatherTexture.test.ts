/**
 * The weather texture's fields (cover, precipitation, cloud base, fog, snow,
 * dust, storm) sampled in a TSL compute kernel on Dawn, against the same
 * fields interpolated on the CPU from the two hourly frames.
 */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import { randomUnitVector } from '../../src/core/coords';
import { rng } from '../../src/core/rng';
import { HOUR } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { WeatherTexture } from '../../src/render/sim/clouds/weatherTexture';
import { fogAt, WeatherState } from '../../src/render/sim/weather/weatherState';
import { Channel, WeatherView } from '../../src/sim/weather/frame';
import type { WeatherFrame } from '../../src/sim/weather/frame';
import { presetFrame } from '../../src/sim/weather/presets';
import { createSimWorld } from '../../src/sim/world';
import { syntheticConfig } from '../helpers/weatherWorld';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('weather texture (TSL on Dawn)', () => {
  it('gives every field as the frames have it, between the hours and across seams', async () => {
    const config = syntheticConfig();
    const world = createSimWorld(config);
    world.sim.advanceTo(40 * HOUR);
    const grid = world.weather.grid;
    const n = grid.count;
    // Live weather with a blizzard, a thunderstorm and a dust storm set into it, so every field occurs.
    const mixed = (live: WeatherFrame): WeatherFrame => {
      const data = live.data.slice();
      const regions = [
        {
          frame: presetFrame('blizzard', live, grid),
          inside: (s: number) => grid.directions[s * 3]! < -0.2,
        },
        {
          frame: presetFrame('storm', live, grid),
          inside: (s: number) => grid.directions[s * 3 + 1]! > 0.6,
        },
        {
          frame: presetFrame('duststorm', live, grid),
          inside: (s: number) => grid.directions[s * 3 + 2]! > 0.6,
        },
      ];
      for (let s = 0; s < n; s++) {
        const region = regions.find((q) => q.inside(s));
        if (!region) continue;
        for (let c = 0; c * n < data.length; c++) data[c * n + s] = region.frame.data[c * n + s]!;
      }
      return { hour: live.hour, data };
    };
    const view = new WeatherView(grid);
    for (const f of world.weather.view().frames) view.add(mixed(f!));
    const [a, b] = view.frames as [WeatherFrame, WeatherFrame];
    const t = 40.37 * HOUR;
    const blend = view.blend(t);
    expect(blend).toBeCloseTo(0.37, 6);

    const weather = new WeatherTexture();
    weather.setGround(config.climate.ground);
    weather.setFrames(view);
    weather.update(view, t);

    const points = 2048;
    const dirs = new Float32Array(points * 4);
    const r = rng(5, 'test/weather-texture');
    const d = new Vec3d();
    const list: Vec3d[] = [];
    for (let i = 0; i < points; i++) {
      randomUnitVector(r, d);
      if (i % 4 === 0) {
        // On the seam between the two largest components.
        const abs = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)];
        const order = [0, 1, 2].sort((p, q) => abs[q]! - abs[p]!);
        const c = [d.x, d.y, d.z];
        c[order[1]!] = Math.sign(c[order[1]!]!) * abs[order[0]!]! * (1 - 1e-4);
        d.set(c[0]!, c[1]!, c[2]!).normalize();
      }
      // The kernel gets the float32 direction: interpolate on the CPU at the same one.
      dirs.set([d.x, d.y, d.z, 0], i * 4);
      list.push(new Vec3d(dirs[i * 4]!, dirs[i * 4 + 1]!, dirs[i * 4 + 2]!));
    }
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const input = instancedArray(dirs, 'vec4');
    const first = instancedArray(points, 'vec4');
    const second = instancedArray(points, 'vec4');
    const kernel = Fn(() => {
      const w = weather.sample(input.element(instanceIndex).xyz);
      first.element(instanceIndex).assign(vec4(w.cover, w.precip, w.base, w.fog));
      second.element(instanceIndex).assign(vec4(w.snow, w.dust, w.storm, 0));
    })().compute(points);
    await head.renderer.computeAsync(kernel);
    const out1 = new Float32Array(await head.renderer.getArrayBufferAsync(first.value));
    const out2 = new Float32Array(await head.renderer.getArrayBufferAsync(second.value));
    head.dispose();
    expect(gpu!.errors).toEqual([]);

    // The CPU's version: a per-sample value, blended in time, then bilinear in space.
    const idx = new Int32Array(4);
    const w = new Float64Array(4);
    const lerp = (x: number, y: number) => x + (y - x) * blend;
    const timeBlend = (c: number, s: number) => lerp(a.data[c * n + s]!, b.data[c * n + s]!);
    const precipFull = 0.004 / HOUR;
    const fields: ((s: number) => number)[] = [
      (s) => timeBlend(Channel.Cover, s),
      (s) =>
        lerp(
          Math.min(1, a.data[Channel.Precipitation * n + s]! / precipFull),
          Math.min(1, b.data[Channel.Precipitation * n + s]! / precipFull),
        ),
      (s) => timeBlend(Channel.CloudBase, s) + config.climate.ground[s]!,
      // Fog is checked against what WeatherState gives at the same place (fogAt), below.
      () => 0,
      (s) => timeBlend(Channel.Storm, s) - timeBlend(Channel.Snow, s),
      (s) => timeBlend(Channel.Dust, s),
    ];
    const names = ['cover', 'precip', 'base', 'fog', 'snow', 'dust', 'storm'];
    // Half floats and the sampler's fixed-point weights: about 1% of a field's range.
    const tolerance = [0.012, 0.012, 40, 2.5e-4, 0.012, 0.012, 0.012];
    const worst = new Float64Array(7);
    const seen = new Float64Array(7);
    for (let i = 0; i < points; i++) {
      grid.bilinear(list[i]!, idx, w);
      const cpu = fields.map((fn) => [0, 1, 2, 3].reduce((sum, k) => sum + fn(idx[k]!) * w[k]!, 0));
      const signed = cpu[4]!;
      const expected = [
        cpu[0]!,
        cpu[1]!,
        cpu[2]!,
        fogAt(view, list[i]!, t),
        Math.max(-signed, 0),
        cpu[5]!,
        Math.max(signed, 0),
      ];
      const got = [
        out1[i * 4]!,
        out1[i * 4 + 1]!,
        out1[i * 4 + 2]!,
        out1[i * 4 + 3]!,
        out2[i * 4]!,
        out2[i * 4 + 1]!,
        out2[i * 4 + 2]!,
      ];
      for (let k = 0; k < 7; k++) {
        worst[k] = Math.max(worst[k]!, Math.abs(got[k]! - expected[k]!));
        seen[k] = Math.max(seen[k]!, expected[k]!);
      }
    }
    for (let k = 0; k < 7; k++) {
      expect(worst[k]!, names[k]).toBeLessThan(tolerance[k]!);
      // Every field was exercised.
      expect(seen[k]!, names[k]).toBeGreaterThan(k === 2 ? 1000 : k === 3 ? 0.005 : 0.3);
    }
    // The uniform at the camera and the texture's fog are one quantity.
    const state = new WeatherState();
    let foggy = 0;
    for (let i = 0; i < points; i += 16) {
      state.update(view, list[i]!, 100, t, 0);
      expect(Math.abs(state.fog.value - out1[i * 4 + 3]!)).toBeLessThan(tolerance[3]!);
      if (state.fog.value > 0.002) foggy++;
    }
    expect(foggy).toBeGreaterThan(5);
  }, 120_000);

  it('fills every field with one value', async () => {
    const weather = new WeatherTexture();
    const points = 64;
    const dirs = new Float32Array(points * 4);
    const r = rng(6, 'test/weather-texture-fill');
    const d = new Vec3d();
    for (let i = 0; i < points; i++) {
      randomUnitVector(r, d);
      dirs.set([d.x, d.y, d.z, 0], i * 4);
    }
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const input = instancedArray(dirs, 'vec4');
    const first = instancedArray(points, 'vec4');
    const second = instancedArray(points, 'vec4');
    const kernel = Fn(() => {
      const w = weather.sample(input.element(instanceIndex).xyz);
      first.element(instanceIndex).assign(vec4(w.cover, w.precip, w.base, w.fog));
      second.element(instanceIndex).assign(vec4(w.snow, w.dust, w.storm, 0));
    })().compute(points);
    const read = async () => {
      await head.renderer.computeAsync(kernel);
      const a = new Float32Array(await head.renderer.getArrayBufferAsync(first.value));
      const b = new Float32Array(await head.renderer.getArrayBufferAsync(second.value));
      return Array.from({ length: points }, (_, i) => [
        ...a.subarray(i * 4, i * 4 + 4),
        ...b.subarray(i * 4, i * 4 + 3),
      ]);
    };
    const close = (rows: number[][], expected: number[]) => {
      for (const row of rows) {
        for (let k = 0; k < 7; k++) {
          // Half floats: 2 m of base, 1% of the thinnest fog asked for, 0.002 of the rest.
          const tolerance = k === 2 ? 2 : k === 3 ? 4e-5 : 2e-3;
          expect(Math.abs(row[k]! - expected[k]!), `field ${k}`).toBeLessThan(tolerance);
        }
      }
    };
    // Before any weather: clear, with a base to put cloud at once there is some.
    close(await read(), [0, 0, 1500, 0, 0, 0, 0]);
    // As before the new fields existed.
    weather.fill(0.5, 0.25);
    close(await read(), [0.5, 0.25, 1500, 0, 0, 0, 0]);
    weather.fill(1, 1, { base: 600, fog: 0.004, dust: 0.3, storm: 0.8 });
    close(await read(), [1, 1, 600, 0.004, 0, 0.3, 0.8]);
    weather.fill(0.9, 0.4, { base: 250, fog: 0.013, snow: 1 });
    close(await read(), [0.9, 0.4, 250, 0.013, 1, 0, 0]);
    head.dispose();
    expect(gpu!.errors).toEqual([]);
  }, 120_000);
});
