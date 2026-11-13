/**
 * The weather texture's CPU side, without a GPU: what `setFrames`, `update`,
 * `setGround` and `fill` write into the field texture (base, fog, dust,
 * storm − snow), and when the fields are blended again.
 */
import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three/webgpu';
import { HOUR, KM } from '../src/core/units';
import { WeatherTexture } from '../src/render/sim/clouds/weatherTexture';
import { KOSCHMIEDER } from '../src/render/sim/weather/weatherState';
import { Channel, WeatherView } from '../src/sim/weather/frame';
import { presetFrame } from '../src/sim/weather/presets';
import type { WeatherPreset } from '../src/sim/weather/presets';
import { createSimWorld } from '../src/sim/world';
import { syntheticConfig } from './helpers/weatherWorld';

const config = syntheticConfig();
const world = createSimWorld(config);
world.sim.advanceTo(20 * HOUR);
const grid = world.weather.grid;
const n = grid.count;
const [live0, live1] = world.weather.view().frames;

function viewOf(first: WeatherPreset, second: WeatherPreset = first): WeatherView {
  const view = new WeatherView(grid);
  view.add(presetFrame(first, live0!, grid));
  view.add(presetFrame(second, live1!, grid));
  return view;
}

/** Texel s of the field texture: base (m), fog (1/m), dust, storm − snow. */
function texel(weather: WeatherTexture, s: number): [number, number, number, number] {
  const half = weather.fields.image.data as Uint16Array;
  return [
    DataUtils.fromHalfFloat(half[s * 4]!) * KM,
    DataUtils.fromHalfFloat(half[s * 4 + 1]!) / KM,
    DataUtils.fromHalfFloat(half[s * 4 + 2]!),
    DataUtils.fromHalfFloat(half[s * 4 + 3]!),
  ];
}

describe('weather texture fields', () => {
  it("has one texel per weather sample, in the grid's order", () => {
    const weather = new WeatherTexture();
    expect(weather.fields.image.width).toBe(grid.m);
    expect(weather.fields.image.height).toBe(grid.m);
    expect(weather.fields.image.depth).toBe(6);
    expect((weather.fields.image.data as Uint16Array).length).toBe(4 * n);
    expect(texel(weather, 0)).toEqual([1500, 0, 0, 0]);
    expect(texel(weather, n - 1)).toEqual([1500, 0, 0, 0]);
    weather.dispose();
  });

  it('blends base and fog between the frames at the time of the update', () => {
    const weather = new WeatherTexture();
    // Clear air (base 3,000 m, no fog) turning into fog (base 2,500 m, visibility 200 m).
    const view = viewOf('clear', 'fog');
    const fog = KOSCHMIEDER / 200;
    weather.setFrames(view);
    weather.update(view, 20 * HOUR);
    for (const s of [0, 777, n - 1]) {
      const [base, k] = texel(weather, s);
      expect(base).toBeCloseTo(3000, 0);
      expect(k).toBe(0);
    }
    weather.update(view, 20.5 * HOUR);
    expect(weather.blend.value).toBe(0.5);
    for (const s of [0, 777, n - 1]) {
      const [base, k] = texel(weather, s);
      expect(Math.abs(base - 2750)).toBeLessThan(2);
      // Half the fog at half past, not the clear air a visibility of 30 km would mean.
      expect(k / fog).toBeGreaterThan(0.499);
      expect(k / fog).toBeLessThan(0.501);
    }
    weather.update(view, 21 * HOUR);
    expect(texel(weather, 777)[1] / fog).toBeGreaterThan(0.999);
    expect(Math.abs(texel(weather, 777)[0] - 2500)).toBeLessThan(2);
  });

  it('blends the fields again only when the blend has moved enough', () => {
    const weather = new WeatherTexture();
    const view = viewOf('clear', 'fog');
    weather.setFrames(view);
    weather.update(view, 20.5 * HOUR);
    const uploads = weather.fields.version;
    const frames = weather.version;
    const before = texel(weather, 100);
    // Ten game seconds on: a third of the step.
    weather.update(view, 20.5 * HOUR + 10);
    expect(weather.blend.value).toBeGreaterThan(0.5);
    expect(weather.fields.version).toBe(uploads);
    expect(texel(weather, 100)).toEqual(before);
    // Half a minute on: more than 1/128 of the hour.
    weather.update(view, 20.5 * HOUR + 30);
    expect(weather.fields.version).toBe(uploads + 1);
    expect(texel(weather, 100)[1]).toBeGreaterThan(before[1]);
    // Back in time too.
    weather.update(view, 20.2 * HOUR);
    expect(weather.fields.version).toBe(uploads + 2);
    expect(texel(weather, 100)[1]).toBeLessThan(before[1]);
    // None of it counts as new frames, and the two-frame texture was not uploaded again.
    expect(weather.version).toBe(frames);
  });

  it('raises the cloud base by the ground under each sample', () => {
    const weather = new WeatherTexture();
    const view = viewOf('overcast');
    weather.setFrames(view);
    weather.update(view, 20.25 * HOUR);
    const ground = config.climate.ground;
    let highest = 0;
    for (let s = 0; s < n; s++) if (ground[s]! > ground[highest]!) highest = s;
    expect(ground[highest]!).toBeGreaterThan(100);
    const above = texel(weather, highest)[0];
    weather.setGround(ground);
    expect(texel(weather, highest)[0] - above).toBeCloseTo(ground[highest]!, -1);
    weather.setGround(null);
    expect(texel(weather, highest)[0]).toBe(above);
    expect(() => weather.setGround(new Float32Array(n - 1))).toThrow(RangeError);
  });

  it('packs storm and snow into one signed channel, and keeps dust', () => {
    const weather = new WeatherTexture();
    for (const [preset, sign] of [
      ['storm', 1],
      ['blizzard', -1],
      ['duststorm', 0],
    ] as const) {
      const view = viewOf(preset);
      weather.setFrames(view);
      weather.update(view, 20.4 * HOUR);
      const [a, b] = view.frames;
      for (let s = 0; s < n; s += 97) {
        const at = (channel: number) =>
          a!.data[channel * n + s]! * 0.6 + b!.data[channel * n + s]! * 0.4;
        const [, , dust, signed] = texel(weather, s);
        expect(dust).toBeCloseTo(at(Channel.Dust), 2);
        expect(signed).toBeCloseTo(at(Channel.Storm) - at(Channel.Snow), 2);
        expect(Math.sign(signed)).toBe(sign);
      }
    }
  });

  it('refuses frames of another layout, and goes back to uniform fields with fill', () => {
    const weather = new WeatherTexture();
    const short = new WeatherView(grid);
    short.add({ hour: 20, data: live0!.data.slice(0, Channel.Dust * n) });
    expect(() => weather.setFrames(short)).toThrow(RangeError);
    const view = viewOf('fog');
    weather.setFrames(view);
    weather.update(view, 20.5 * HOUR);
    weather.fill(0.4, 0.1, { base: 800, fog: 0.002, snow: 1 });
    const uploads = weather.fields.version;
    expect(texel(weather, 5)[0]).toBeCloseTo(800, 0);
    expect(texel(weather, 5)[1]).toBeCloseTo(0.002, 5);
    expect(texel(weather, 5)[3]).toBe(-1);
    // The frames are forgotten: an update no longer blends them over the filled values.
    weather.update(view, 20.9 * HOUR);
    expect(weather.fields.version).toBe(uploads);
  });
});
