import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { Channel } from '../src/sim/weather/frame';
import { presetFrame } from '../src/sim/weather/presets';
import { StandaloneWeather } from '../src/sim/weather/standalone';
import { createSimWorld } from '../src/sim/world';
import { syntheticConfig } from './helpers/weatherWorld';

describe('standalone weather', () => {
  it('gives the frames the full sim has at the same game time', () => {
    const config = syntheticConfig();
    const sim = createSimWorld(config);
    const alone = new StandaloneWeather(config);
    for (const t of [0, 0.4 * HOUR, HOUR, 5.3 * HOUR, 6 * HOUR - 1, 26.7 * HOUR, 49 * HOUR]) {
      sim.sim.advanceTo(t);
      const expected = sim.weather.view().frames;
      const got = alone.view(t).frames;
      expect(got.map((f) => f?.hour)).toEqual(expected.map((f) => f?.hour));
      expect(got[0]!.hour).toBe(Math.floor(t / HOUR));
      expect(got[0]!.data).toEqual(expected[0]!.data);
      expect(got[1]!.data).toEqual(expected[1]!.data);
      // The same interpolated weather, then.
      const d = new Vec3d(0.3, 0.6, -0.5).normalize();
      expect(alone.view(t).report(d, t)).toEqual(sim.weather.view().report(d, t));
    }
  });

  it('prepares in small units and reports when the frames exist', () => {
    const config = syntheticConfig();
    const alone = new StandaloneWeather(config);
    const t = 40.2 * HOUR;
    expect(alone.ready(t)).toBe(false);
    // A zero budget does one unit of work per call: the model, a batch of ticks, a part of a frame.
    let calls = 0;
    while (!alone.prepare(t, 0)) {
      expect(alone.ready(t)).toBe(false);
      expect(++calls).toBeLessThan(100);
    }
    expect(calls).toBeGreaterThanOrEqual(10);
    expect(alone.ready(t)).toBe(true);
    const version = alone.version;
    const view = alone.view(t);
    expect(alone.version).toBe(version + 1);
    expect(alone.view(t + 60)).toBe(view);
    expect(alone.version).toBe(version + 1);
    const whole = new StandaloneWeather(config).view(t);
    expect(view.frames[0]!.data).toEqual(whole.frames[0]!.data);
    expect(view.frames[1]!.data).toEqual(whole.frames[1]!.data);

    // In the second half of the hour, prepare computes the next hour ahead of time.
    expect(alone.ready(t + HOUR)).toBe(false);
    expect(alone.prepare(40.7 * HOUR)).toBe(true);
    expect(alone.ready(41 * HOUR)).toBe(true);
    // With a small budget too, over several frames, while the current hour stays ready.
    const sliced = new StandaloneWeather(config, 'rain');
    sliced.view(40.2 * HOUR);
    for (let i = 0; i < 1000 && !sliced.ready(41 * HOUR); i++) {
      expect(sliced.prepare(40.7 * HOUR, 0.05)).toBe(true);
    }
    expect(sliced.ready(41 * HOUR)).toBe(true);
    // The view keeps its frames until it is asked for the new hour.
    expect(view.frames.map((f) => f?.hour)).toEqual([40, 41]);
    expect(alone.view(41.1 * HOUR).frames.map((f) => f?.hour)).toEqual([41, 42]);
    expect(alone.version).toBe(version + 2);
  });

  it('goes back in time to the same weather', () => {
    const config = syntheticConfig();
    const alone = new StandaloneWeather(config);
    const early = alone.view(3.5 * HOUR).frames.map((f) => f!.data.slice());
    alone.view(30 * HOUR);
    const again = alone.view(3.5 * HOUR).frames;
    expect(again.map((f) => f?.hour)).toEqual([3, 4]);
    expect(again[0]!.data).toEqual(early[0]);
    expect(again[1]!.data).toEqual(early[1]);
    // Before the campaign starts, the first hour's weather stands in.
    expect(alone.view(-500).frames.map((f) => f?.hour)).toEqual([0, 1]);
  });

  it('shows a preset, and the live weather again', () => {
    const config = syntheticConfig();
    const alone = new StandaloneWeather(config, 'blizzard');
    expect(alone.preset).toBe('blizzard');
    const t = 7.25 * HOUR;
    const d = new Vec3d(0.1, 0.2, 0.9).normalize();
    const cold = alone.view(t);
    const version = alone.version;
    expect(cold.report(d, t).snow).toBe(1);
    expect(cold.report(d, t).temperature).toBeLessThan(-5);
    expect(cold.sample(Channel.Visibility, d, t)).toBeLessThan(600);

    alone.preset = 'live';
    const live = alone.view(t);
    expect(alone.version).toBe(version + 1);
    const reference = new StandaloneWeather(config).view(t);
    expect(live.frames[0]!.data).toEqual(reference.frames[0]!.data);
    expect(live.frames[1]!.data).toEqual(reference.frames[1]!.data);
    // The preset frames are the pure function of the live ones.
    alone.preset = 'duststorm';
    const dusty = alone.view(t).frames;
    expect(dusty[1]!.data).toEqual(presetFrame('duststorm', reference.frames[1]!, alone.grid).data);
    // Setting the same preset again changes nothing.
    const v = alone.version;
    alone.preset = 'duststorm';
    alone.view(t);
    expect(alone.version).toBe(v);
  });
});
