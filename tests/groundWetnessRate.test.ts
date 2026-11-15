/**
 * The ground's wetness under time acceleration: it gets wet and dries in game time, so a
 * shower's wet ground does not last into the next game day at 60× or 600×.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { wetnessStep } from '../src/render/sim/globeScene';
import { WeatherState, WETNESS_DRY } from '../src/render/sim/weather/weatherState';
import { WeatherView } from '../src/sim/weather/frame';
import { presetFrame } from '../src/sim/weather/presets';
import type { WeatherPreset } from '../src/sim/weather/presets';
import { createSimWorld } from '../src/sim/world';
import { syntheticConfig } from './helpers/weatherWorld';

const world = createSimWorld(syntheticConfig());
world.sim.advanceTo(20 * HOUR);
const grid = world.weather.grid;
const [live0, live1] = world.weather.view().frames;
function viewOf(preset: WeatherPreset): WeatherView {
  const view = new WeatherView(grid);
  view.add(presetFrame(preset, live0!, grid));
  view.add(presetFrame(preset, live1!, grid));
  return view;
}
const dir = latLonToDirection(20 * DEG, 30 * DEG, new Vec3d());

describe('ground wetness and the game clock', () => {
  it('counts game seconds where the clock runs fast, real seconds otherwise', () => {
    // 1×: the frame's game time is its real time.
    expect(wetnessStep(1 / 60, 1 / 60)).toBe(1 / 60);
    // 60× and 600×.
    expect(wetnessStep(1 / 60, 1)).toBe(1);
    expect(wetnessStep(1 / 60, 10)).toBe(10);
    // Paused: no time at all, whatever the clock did.
    expect(wetnessStep(0, 0)).toBe(0);
    expect(wetnessStep(0, 500)).toBe(0);
    // A clock that stands (a preview), was set back, or is not known yet: real time.
    expect(wetnessStep(0.1, 0)).toBe(0.1);
    expect(wetnessStep(0.1, -3600)).toBe(0.1);
    expect(wetnessStep(0.1, Number.NaN)).toBe(0.1);
  });

  it('dries the ground within minutes of game time at 600×', () => {
    // 60 frames a second at 600×: ten game seconds a frame.
    const frames = (state: WeatherState, view: WeatherView, from: number, count: number) => {
      let t = from;
      for (let i = 0; i < count; i++) {
        t += 10;
        state.update(view, dir, 500, t, 1 / 60, wetnessStep(1 / 60, 10));
      }
      return t;
    };
    const state = new WeatherState();
    let t = 20.2 * HOUR;
    state.update(viewOf('clear'), dir, 500, t, 1 / 60);
    // A shower of ten game minutes (one real second) soaks the ground.
    t = frames(state, viewOf('rain'), t, 60);
    expect(state.wetness.value).toBeGreaterThan(0.95);
    // Three game minutes after it (a third of a real second), most of it has dried.
    t = frames(state, viewOf('clear'), t, WETNESS_DRY / 10);
    expect(state.wetness.value).toBeLessThan(0.4);
    // After a quarter of a game hour (1.5 real seconds) the ground is dry.
    t = frames(state, viewOf('clear'), t, 72);
    expect(state.wetness.value).toBeLessThan(0.01);
    // In real seconds it had stayed wet through all of that: what the owner saw before.
    const real = new WeatherState();
    real.update(viewOf('rain'), dir, 500, t, 1 / 60);
    for (let i = 0; i < 90; i++) real.update(viewOf('clear'), dir, 500, t, 1 / 60);
    expect(real.wetness.value).toBeGreaterThan(0.95);
    // The animation clock stays in real seconds.
    expect(state.clock.value).toBeCloseTo(1 / 60 + (60 + 18 + 72) / 60, 6);
  });
});
