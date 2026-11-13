import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  CHANNEL_COUNT,
  Channel,
  dustVisibility,
  MM_PER_HOUR,
  WeatherView,
  WIND_LEVELS,
} from '../src/sim/weather/frame';
import type { WeatherFrame } from '../src/sim/weather/frame';
import {
  applyPreset,
  GALE,
  PRESET_LABELS,
  PRESET_TABLE,
  PRESET_WIND_GAIN,
  presetFrame,
  presetVariation,
  WEATHER_PRESETS,
} from '../src/sim/weather/presets';
import type { WeatherPreset } from '../src/sim/weather/presets';
import { createSimWorld } from '../src/sim/world';
import { syntheticConfig } from './helpers/weatherWorld';

const world = createSimWorld(syntheticConfig());
world.sim.advanceTo(30 * HOUR);
const grid = world.weather.grid;
const n = grid.count;
const live: WeatherFrame = world.weather.frame(30);
const later: WeatherFrame = world.weather.frame(31);

/** Minimum, maximum and mean of a channel. */
function stats(frame: WeatherFrame, channel: number): { min: number; max: number; mean: number } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let s = 0; s < n; s++) {
    const v = frame.data[channel * n + s]!;
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  return { min, max, mean: sum / n };
}

const speed = (frame: WeatherFrame, level: number, s: number) =>
  Math.hypot(
    frame.data[(Channel.WindEast0 + 2 * level) * n + s]!,
    frame.data[(Channel.WindEast0 + 2 * level + 1) * n + s]!,
  );

describe('weather presets', () => {
  it('lists the presets with a label and nominal values each', () => {
    expect(WEATHER_PRESETS).toEqual([
      'live',
      'clear',
      'fair',
      'overcast',
      'drizzle',
      'rain',
      'storm',
      'snow',
      'blizzard',
      'fog',
      'duststorm',
    ]);
    for (const preset of WEATHER_PRESETS) {
      expect(PRESET_LABELS[preset].length).toBeGreaterThan(8);
      expect(PRESET_LABELS[preset]).not.toContain('\n');
      if (preset !== 'live') expect(PRESET_TABLE[preset].label).toBe(PRESET_LABELS[preset]);
    }
    // From drizzle to a skyfall.
    expect(PRESET_TABLE.drizzle.precipitation).toBeLessThan(1 * MM_PER_HOUR);
    expect(PRESET_TABLE.storm.precipitation).toBeGreaterThanOrEqual(30 * MM_PER_HOUR);
  });

  it('leaves the live weather alone', () => {
    const copy = live.data.slice();
    expect(presetFrame('live', live, grid)).toBe(live);
    for (const preset of WEATHER_PRESETS) presetFrame(preset, live, grid);
    expect(live.data).toEqual(copy);
  });

  it('shows each preset around its nominal values, on the same hour and grid', () => {
    for (const preset of WEATHER_PRESETS) {
      if (preset === 'live') continue;
      const spec = PRESET_TABLE[preset];
      const f = presetFrame(preset, live, grid);
      expect(f.hour).toBe(live.hour);
      expect(f.data.length).toBe(CHANNEL_COUNT * n);
      expect(f.data.every(Number.isFinite), preset).toBe(true);
      // The same again from the same input: no hidden state, no random numbers.
      expect(presetFrame(preset, live, grid).data).toEqual(f.data);

      const cover = stats(f, Channel.Cover);
      expect(cover.min).toBeGreaterThanOrEqual(Math.max(0, spec.cover - spec.coverSpread) - 1e-6);
      expect(cover.max).toBeLessThanOrEqual(Math.min(1, spec.cover + spec.coverSpread) + 1e-6);
      const rate = stats(f, Channel.Precipitation);
      const spread = 2 ** spec.variation;
      expect(rate.min).toBeGreaterThanOrEqual((spec.precipitation / spread) * 0.999);
      expect(rate.max).toBeLessThanOrEqual(spec.precipitation * spread * 1.001);
      const base = stats(f, Channel.CloudBase);
      expect(base.min).toBeGreaterThan(spec.cloudBase * 0.7);
      expect(base.max).toBeLessThan(spec.cloudBase * 1.3);
      const visibility = stats(f, Channel.Visibility);
      expect(visibility.min).toBeGreaterThan(spec.visibility / 2);
      expect(visibility.max).toBeLessThan(spec.visibility * 2);
      const temperature = stats(f, Channel.Temperature);
      expect(temperature.min).toBeGreaterThanOrEqual(spec.temperature[0]);
      expect(temperature.max).toBeLessThanOrEqual(spec.temperature[1]);
      // The snow fraction follows the temperature range.
      const snow = stats(f, Channel.Snow);
      if (spec.precipitation > 0) {
        expect(snow.min).toBe(spec.snow);
        expect(snow.max).toBe(spec.snow);
      }
      const dust = stats(f, Channel.Dust);
      const storm = stats(f, Channel.Storm);
      expect(dust.max).toBeLessThanOrEqual(1);
      expect(storm.max).toBeLessThanOrEqual(1);
      if (spec.dust === 0) expect(dust.max).toBe(0);
      else expect(dust.min).toBeGreaterThan(0.7 * spec.dust);
      if (spec.storm === 0) expect(storm.max).toBe(0);
      else expect(storm.min).toBeGreaterThan(0.7 * spec.storm);
      // The pressure is the live frame's.
      expect(f.data.subarray(Channel.Pressure * n, (Channel.Pressure + 1) * n)).toEqual(
        live.data.subarray(Channel.Pressure * n, (Channel.Pressure + 1) * n),
      );
      // Storm and snow never share a sample (the weather texture packs them into one channel).
      for (let s = 0; s < n; s++) {
        expect(f.data[Channel.Storm * n + s]! * f.data[Channel.Snow * n + s]!).toBe(0);
      }
    }
  });

  it('keeps the wind direction and holds the speed within the limits', () => {
    for (const preset of WEATHER_PRESETS) {
      if (preset === 'live') continue;
      const spec = PRESET_TABLE[preset];
      const f = presetFrame(preset, live, grid);
      let turned = 0;
      let changed = 0;
      for (let s = 0; s < n; s++) {
        for (let k = 0; k < WIND_LEVELS.length; k++) {
          const e0 = live.data[(Channel.WindEast0 + 2 * k) * n + s]!;
          const n0 = live.data[(Channel.WindEast0 + 2 * k + 1) * n + s]!;
          const e1 = f.data[(Channel.WindEast0 + 2 * k) * n + s]!;
          const n1 = f.data[(Channel.WindEast0 + 2 * k + 1) * n + s]!;
          const v0 = Math.hypot(e0, n0);
          const v1 = speed(f, k, s);
          expect(v1).toBeGreaterThanOrEqual(spec.windMin * PRESET_WIND_GAIN[k]! * 0.9999);
          expect(v1).toBeLessThanOrEqual(spec.windMax * PRESET_WIND_GAIN[k]! * 1.0001);
          if (Math.abs(v1 - v0) > 1e-3) changed++;
          // Same direction: the cross product vanishes and the dot product is positive.
          if (v0 > 0.01 && v1 > 0.01) {
            if (Math.abs(e0 * n1 - n0 * e1) > 1e-3 * v0 * v1 || e0 * e1 + n0 * n1 <= 0) turned++;
          }
        }
      }
      expect(turned, preset).toBe(0);
      if (spec.windMin === 0 && spec.windMax === Infinity) expect(changed, preset).toBe(0);
    }
    // Storm, blizzard and duststorm blow at gale force or more near the ground.
    for (const preset of ['storm', 'blizzard', 'duststorm'] as const) {
      expect(PRESET_TABLE[preset].windMin).toBeGreaterThanOrEqual(GALE);
      const f = presetFrame(preset, live, grid);
      for (let s = 0; s < n; s += 7) expect(speed(f, 0, s)).toBeGreaterThanOrEqual(GALE);
    }
    // Fog is nearly calm.
    const fog = presetFrame('fog', live, grid);
    for (let s = 0; s < n; s += 7) expect(speed(fog, 0, s)).toBeLessThanOrEqual(2.0001);
  });

  it('has the temperatures the weather needs', () => {
    expect(stats(presetFrame('snow', live, grid), Channel.Temperature).max).toBeLessThan(0);
    expect(stats(presetFrame('blizzard', live, grid), Channel.Temperature).max).toBeLessThan(-5);
    expect(stats(presetFrame('duststorm', live, grid), Channel.Temperature).min).toBeGreaterThan(
      28,
    );
    expect(stats(presetFrame('rain', live, grid), Channel.Temperature).min).toBeGreaterThan(2);
    const dust = presetFrame('duststorm', live, grid);
    expect(stats(dust, Channel.Precipitation).max).toBe(0);
    for (let s = 0; s < n; s += 5) {
      expect(dust.data[Channel.Visibility * n + s]!).toBeLessThanOrEqual(
        dustVisibility(dust.data[Channel.Dust * n + s]!) * 1.0001,
      );
    }
    expect(stats(dust, Channel.Visibility).max).toBeLessThan(500);
  });

  it('varies smoothly over hundreds of kilometers, except clear and fog', () => {
    // The pattern: within −1..1, both signs, and smooth from one sample to the next.
    let lo = 0;
    let hi = 0;
    let step = 0;
    for (let s = 0; s + 1 < n; s++) {
      const d = grid.directions;
      const a = presetVariation(d[s * 3]!, d[s * 3 + 1]!, d[s * 3 + 2]!, 30);
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
      // Neighbors in a row of one face are about 65 km apart.
      if ((s + 1) % grid.m !== 0) {
        const b = presetVariation(d[s * 3 + 3]!, d[s * 3 + 4]!, d[s * 3 + 5]!, 30);
        step = Math.max(step, Math.abs(a - b));
      }
    }
    expect(lo).toBeLessThan(-0.8);
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeGreaterThan(0.8);
    expect(hi).toBeLessThanOrEqual(1);
    expect(step).toBeLessThan(0.5);

    const spreadOf = (preset: WeatherPreset, channel: number) => {
      const s = stats(presetFrame(preset, live, grid), channel);
      return s.max - s.min;
    };
    for (const preset of ['clear', 'fog'] as const) {
      for (const channel of [Channel.Cover, Channel.CloudBase, Channel.Visibility]) {
        expect(spreadOf(preset, channel)).toBe(0);
      }
    }
    expect(spreadOf('fair', Channel.Cover)).toBeGreaterThan(0.25);
    expect(spreadOf('overcast', Channel.CloudBase)).toBeGreaterThan(100);
    for (const preset of ['drizzle', 'rain', 'storm', 'snow', 'blizzard'] as const) {
      const rate = stats(presetFrame(preset, live, grid), Channel.Precipitation);
      expect(rate.max / rate.min).toBeGreaterThan(1.5);
    }
    expect(spreadOf('duststorm', Channel.Dust)).toBeGreaterThan(0.05);
    // The pattern drifts from hour to hour, a little.
    const d = new Vec3d(0.3, 0.5, 0.8).normalize();
    const now = presetVariation(d.x, d.y, d.z, 30);
    const next = presetVariation(d.x, d.y, d.z, 31);
    expect(next).not.toBe(now);
    expect(Math.abs(next - now)).toBeLessThan(0.3);
  });

  it('turns a whole view into the preset', () => {
    const source = new WeatherView(grid);
    source.add(live);
    source.add(later);
    const target = new WeatherView(grid);
    applyPreset('rain', source, target);
    expect(target.frames.map((f) => f?.hour)).toEqual([30, 31]);
    const d = new Vec3d(0.2, 0.7, 0.6).normalize();
    const r = target.report(d, 30.5 * HOUR);
    expect(r.cloudCover).toBe(1);
    expect(r.precipitation / MM_PER_HOUR).toBeGreaterThan(1.5);
    expect(r.precipitation / MM_PER_HOUR).toBeLessThan(8);
    expect(r.snow).toBe(0);
    expect(r.storm).toBe(0);
    expect(Number.isFinite(r.ceiling)).toBe(true);
    applyPreset('live', source, target);
    expect(target.frames).toEqual([live, later]);
  });
});
