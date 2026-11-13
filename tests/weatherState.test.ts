import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  CLOCK_WRAP,
  dustExtinction,
  fogAt,
  fogExtinction,
  frameFog,
  FOG_CLEAR_VISIBILITY,
  KOSCHMIEDER,
  precipitationIntensity,
  SKYFALL_RATE,
  stepWetness,
  WeatherState,
  wetnessTarget,
  windToWorld,
} from '../src/render/sim/weather/weatherState';
import { Channel, DUST_VISIBILITY, MM_PER_HOUR, WeatherView } from '../src/sim/weather/frame';
import { presetFrame } from '../src/sim/weather/presets';
import type { WeatherPreset } from '../src/sim/weather/presets';
import { createSimWorld } from '../src/sim/world';
import { syntheticConfig } from './helpers/weatherWorld';

describe('precipitationIntensity', () => {
  it('maps drizzle, rain and a skyfall onto 0..1 logarithmically', () => {
    expect(precipitationIntensity(0)).toBe(0);
    expect(precipitationIntensity(-1)).toBe(0);
    expect(precipitationIntensity(Number.NaN)).toBe(0);
    expect(precipitationIntensity(0.5 * MM_PER_HOUR)).toBeCloseTo(0.2, 1);
    expect(precipitationIntensity(4 * MM_PER_HOUR)).toBeCloseTo(0.55, 1);
    expect(precipitationIntensity(SKYFALL_RATE)).toBeCloseTo(1, 10);
    expect(precipitationIntensity(80 * MM_PER_HOUR)).toBe(1);
    // Monotonic, and each decade adds about as much as the one before.
    let last = 0;
    for (let mm = 0.01; mm < 30; mm *= 1.3) {
      const i = precipitationIntensity(mm * MM_PER_HOUR);
      expect(i).toBeGreaterThan(last);
      last = i;
    }
    const step = (a: number, b: number) =>
      precipitationIntensity(b * MM_PER_HOUR) - precipitationIntensity(a * MM_PER_HOUR);
    expect(step(3, 30) / step(0.3, 3)).toBeGreaterThan(0.8);
    expect(step(3, 30) / step(0.3, 3)).toBeLessThan(1.6);
    // The faintest drizzle still shows.
    expect(precipitationIntensity(0.05 * MM_PER_HOUR)).toBeGreaterThan(0.02);
  });
});

describe('fogExtinction', () => {
  it('follows the visibility and vanishes in clear air', () => {
    expect(fogExtinction(300)).toBeCloseTo(KOSCHMIEDER / 300, 10);
    expect(fogExtinction(5000)).toBeCloseTo(KOSCHMIEDER / 5000, 10);
    expect(fogExtinction(FOG_CLEAR_VISIBILITY)).toBe(0);
    expect(fogExtinction(40_000)).toBe(0);
    expect(fogExtinction(Infinity)).toBe(0);
    // No step where it ends: continuous and falling all the way.
    let last = Infinity;
    for (let v = 1000; v <= 21_000; v += 100) {
      const k = fogExtinction(v);
      expect(k).toBeLessThanOrEqual(last);
      if (Number.isFinite(last)) expect(last - k).toBeLessThan(0.1 * last + 2e-6);
      last = k;
    }
    expect(fogExtinction(19_900)).toBeLessThan(2e-6);
  });

  it('leaves out the dust, which is drawn on its own', () => {
    expect(dustExtinction(0)).toBe(0);
    expect(dustExtinction(1)).toBeCloseTo(KOSCHMIEDER / DUST_VISIBILITY, 10);
    // Visibility set by the dust alone: no fog left.
    expect(fogExtinction(DUST_VISIBILITY, 1)).toBeCloseTo(0, 10);
    expect(fogExtinction(DUST_VISIBILITY / 0.25, 0.5)).toBeCloseTo(0, 10);
    // Fog thicker than the dust keeps the rest.
    expect(fogExtinction(200, 0.3)).toBeCloseTo(KOSCHMIEDER / 200 - dustExtinction(0.3), 10);
  });
});

describe('windToWorld', () => {
  const out = new Vec3d();
  it('turns east and north components into the world frame', () => {
    // Latitude 0, longitude 0 is +Z: east is +X, north is +Y (rule 3).
    windToWorld(new Vec3d(0, 0, 1), 10, 0, out);
    expect([out.x, out.y, out.z]).toEqual([10, 0, -0]);
    windToWorld(new Vec3d(0, 0, 2), 0, 7, out);
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.y).toBeCloseTo(7, 12);
    expect(out.z).toBeCloseTo(0, 12);
    // Longitude 90° E is +X: east is −Z.
    windToWorld(new Vec3d(1, 0, 0), 5, 0, out);
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(-5, 12);
  });

  it('is horizontal, keeps the speed, and points toward higher longitude and latitude', () => {
    const d = new Vec3d();
    const moved = new Vec3d();
    for (const [lat, lon] of [
      [40, 20],
      [-63, 150],
      [5, -110],
      [80, 77],
    ] as const) {
      latLonToDirection(lat * DEG, lon * DEG, d);
      windToWorld(d, 3, 0, out);
      expect(out.x * d.x + out.y * d.y + out.z * d.z).toBeCloseTo(0, 12);
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(3, 12);
      latLonToDirection(lat * DEG, (lon + 0.01) * DEG, moved);
      expect(
        out.x * (moved.x - d.x) + out.y * (moved.y - d.y) + out.z * (moved.z - d.z),
      ).toBeGreaterThan(0);

      windToWorld(d, 0, 4, out);
      expect(out.x * d.x + out.y * d.y + out.z * d.z).toBeCloseTo(0, 12);
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(4, 12);
      latLonToDirection((lat + 0.01) * DEG, lon * DEG, moved);
      expect(
        out.x * (moved.x - d.x) + out.y * (moved.y - d.y) + out.z * (moved.z - d.z),
      ).toBeGreaterThan(0);

      windToWorld(d, 3, 4, out);
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(5, 12);
    }
    // At the pole east is +X by convention; the result is finite and horizontal.
    windToWorld(new Vec3d(0, 1, 0), 2, 3, out);
    expect(out.y).toBeCloseTo(0, 12);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(Math.hypot(2, 3), 12);
  });
});

describe('ground wetness', () => {
  it('rises within about half a minute of rain and dries over minutes', () => {
    const rain = precipitationIntensity(4 * MM_PER_HOUR);
    expect(wetnessTarget(rain)).toBe(1);
    expect(wetnessTarget(0)).toBe(0);
    // Drizzle dampens the ground without soaking it.
    const drizzle = wetnessTarget(precipitationIntensity(0.4 * MM_PER_HOUR));
    expect(drizzle).toBeGreaterThan(0.3);
    expect(drizzle).toBeLessThan(0.7);

    let w = 0;
    for (let i = 0; i < 30 * 60; i++) w = stepWetness(w, rain, 1 / 60);
    expect(w).toBeGreaterThan(0.9);
    // Dry weather: still wet after a minute, mostly dry after ten.
    for (let i = 0; i < 60 * 60; i++) w = stepWetness(w, 0, 1 / 60);
    expect(w).toBeGreaterThan(0.6);
    for (let i = 0; i < 9 * 60 * 60; i++) w = stepWetness(w, 0, 1 / 60);
    expect(w).toBeLessThan(0.06);
    expect(w).toBeGreaterThan(0);
  });

  it('does not depend on the frame rate, and stands still without time', () => {
    const rain = 0.4;
    let a = 0.1;
    let b = 0.1;
    for (let i = 0; i < 20; i++) a = stepWetness(a, rain, 0.5);
    for (let i = 0; i < 1000; i++) b = stepWetness(b, rain, 0.01);
    expect(a).toBeCloseTo(b, 9);
    expect(stepWetness(0.37, rain, 0)).toBe(0.37);
    expect(stepWetness(0.37, rain, -5)).toBe(0.37);
    // Never beyond its range.
    expect(stepWetness(0.99, 1, 1e6)).toBeLessThanOrEqual(1);
    expect(stepWetness(0.01, 0, 1e6)).toBeGreaterThanOrEqual(0);
  });
});

describe('WeatherState', () => {
  const world = createSimWorld(syntheticConfig());
  world.sim.advanceTo(12 * HOUR);
  const grid = world.weather.grid;
  const t = 12.5 * HOUR;
  const dir = latLonToDirection(35 * DEG, -10 * DEG, new Vec3d());
  const viewOf = (preset: WeatherPreset) => {
    const view = new WeatherView(grid);
    for (const f of world.weather.view().frames) view.add(presetFrame(preset, f!, grid));
    return view;
  };

  it('is clear without a view, and the clock runs and wraps', () => {
    const state = new WeatherState();
    state.update(null, dir, 1000, t, 0.25);
    expect(state.local).toBeNull();
    for (const u of [state.rain, state.snow, state.dust, state.storm, state.fog, state.wetness]) {
      expect(u.value).toBe(0);
    }
    expect(state.wind.value.length()).toBe(0);
    expect(state.clock.value).toBeCloseTo(0.25, 6);
    state.update(null, dir, 1000, t, CLOCK_WRAP - 0.125);
    expect(state.clock.value).toBeCloseTo(0.125, 6);
    // A view without frames is clear air too.
    state.update(new WeatherView(grid), dir, 1000, t, 0);
    expect(state.local).toBeNull();
    // The lightning fields exist for the scheduler to write.
    expect(state.flash.value).toBe(0);
    expect(state.flashPosition.value.length()).toBe(0);
  });

  it('reads the weather at the camera from the view', () => {
    const state = new WeatherState();
    const view = viewOf('live');
    state.update(view, dir, 3000, t, 1 / 60);
    const report = view.report(dir, t);
    expect(state.local).toEqual(report);
    expect(state.rain.value).toBe(precipitationIntensity(report.precipitation * (1 - report.snow)));
    expect(state.snow.value).toBe(precipitationIntensity(report.precipitation * report.snow));
    expect(state.fog.value).toBe(fogAt(view, dir, t));
    expect(state.dust.value).toBe(report.dust);
    expect(state.storm.value).toBe(report.storm);
    // The wind at the camera's altitude, in the world frame.
    const wind = view.wind(dir, 3000, t);
    const expected = windToWorld(dir, wind.east, wind.north, new Vec3d());
    expect(state.wind.value.x).toBeCloseTo(expected.x, 9);
    expect(state.wind.value.y).toBeCloseTo(expected.y, 9);
    expect(state.wind.value.z).toBeCloseTo(expected.z, 9);
    const surface = view.wind(dir, 10, t);
    state.update(view, dir, 10, t, 1 / 60);
    expect(state.wind.value.length()).toBeCloseTo(Math.hypot(surface.east, surface.north), 9);
  });

  it('blends the fog as extinction, in space and in time', () => {
    const n = grid.count;
    const [a, b] = world.weather.view().frames;
    const clear = presetFrame('clear', a!, grid);
    const fog = KOSCHMIEDER / 200;
    // A fog bank over one weather sample and its border copies, in clear air.
    const bank = { hour: clear.hour, data: clear.data.slice() };
    const center = grid.index(4, 12, 12);
    const here = grid.direction(center);
    const next = grid.direction(center + 1);
    bank.data[Channel.Visibility * n + center] = 200;
    const view = new WeatherView(grid);
    view.add(bank);
    expect(fogAt(view, here, t)).toBeCloseTo(fog, 9);
    expect(fogAt(view, next, t)).toBe(0);
    // Halfway to the next sample there is half the fog; the interpolated visibility says clear air.
    const between = new Vec3d(here.x + next.x, here.y + next.y, here.z + next.z).normalize();
    expect(fogAt(view, between, t) / fog).toBeGreaterThan(0.45);
    expect(fogAt(view, between, t) / fog).toBeLessThan(0.55);
    expect(fogExtinction(view.sample(Channel.Visibility, between, t))).toBe(0);
    // It thins evenly toward the edge.
    let last = fog;
    for (let i = 1; i <= 10; i++) {
      const p = new Vec3d(
        here.x + (next.x - here.x) * (i / 10),
        here.y + (next.y - here.y) * (i / 10),
        here.z + (next.z - here.z) * (i / 10),
      );
      const k = fogAt(view, p, t);
      expect(last - k).toBeGreaterThan(0.07 * fog);
      expect(last - k).toBeLessThan(0.13 * fog);
      last = k;
    }

    // Fog that forms during an hour grows evenly through it.
    const forming = new WeatherView(grid);
    forming.add(clear);
    forming.add(presetFrame('fog', b!, grid));
    expect(fogAt(forming, dir, a!.hour * HOUR)).toBe(0);
    expect(fogAt(forming, dir, (a!.hour + 0.25) * HOUR)).toBeCloseTo(0.25 * fog, 9);
    expect(fogAt(forming, dir, (a!.hour + 0.5) * HOUR)).toBeCloseTo(0.5 * fog, 9);
    expect(fogAt(forming, dir, b!.hour * HOUR)).toBeCloseTo(fog, 9);
    const state = new WeatherState();
    state.update(forming, dir, 100, (a!.hour + 0.5) * HOUR, 0);
    expect(state.fog.value).toBeCloseTo(0.5 * fog, 9);
    // The report keeps the interpolated visibility, for flight operations.
    expect(state.local!.visibility).toBeCloseTo((60_000 + 200) / 2, 3);
    // No frames, no fog.
    expect(fogAt(new WeatherView(grid), dir, t)).toBe(0);

    // The per-sample table the weather texture blends is the same function.
    const table = frameFog(bank.data, n);
    expect(table[center]).toBeCloseTo(fog, 6);
    expect(table[center + 1]).toBe(0);
    const dusty = presetFrame('duststorm', a!, grid);
    const dustTable = frameFog(dusty.data, n);
    for (let s = 0; s < n; s += 11) {
      expect(dustTable[s]).toBeCloseTo(
        fogExtinction(dusty.data[Channel.Visibility * n + s]!, dusty.data[Channel.Dust * n + s]!),
        9,
      );
    }
  });

  it('ignores a missing or negative time step', () => {
    const state = new WeatherState();
    const rain = viewOf('rain');
    state.update(rain, dir, 500, t, 2);
    state.update(viewOf('clear'), dir, 500, t, Number.NaN);
    state.update(viewOf('clear'), dir, 500, t, -3);
    expect(state.clock.value).toBe(2);
    expect(state.wetness.value).toBe(1);
  });

  it('shows each preset as the effects expect it', () => {
    const state = new WeatherState();
    const at = (preset: WeatherPreset) => {
      state.reset();
      state.update(viewOf(preset), dir, 500, t, 1 / 60);
      return state;
    };
    at('clear');
    expect(state.rain.value + state.snow.value + state.dust.value + state.storm.value).toBe(0);
    expect(state.fog.value).toBe(0);
    expect(state.wetness.value).toBe(0);

    at('drizzle');
    expect(state.rain.value).toBeGreaterThan(0.1);
    expect(state.rain.value).toBeLessThan(0.3);
    expect(state.snow.value).toBe(0);

    at('rain');
    expect(state.rain.value).toBeGreaterThan(0.4);
    expect(state.rain.value).toBeLessThan(0.75);
    // A scene that starts in rain starts wet.
    expect(state.wetness.value).toBe(1);

    at('storm');
    expect(state.rain.value).toBeGreaterThan(0.8);
    expect(state.storm.value).toBeGreaterThan(0.6);
    expect(state.wind.value.length()).toBeGreaterThan(17);

    at('snow');
    expect(state.rain.value).toBe(0);
    expect(state.snow.value).toBeGreaterThan(0.2);
    expect(state.wetness.value).toBe(0);

    at('blizzard');
    expect(state.snow.value).toBeGreaterThan(0.4);
    expect(state.fog.value).toBeGreaterThan(KOSCHMIEDER / 500);

    at('fog');
    expect(state.fog.value).toBeCloseTo(KOSCHMIEDER / 200, 6);
    // Nearly calm at the ground, and little more at 500 m.
    expect(state.wind.value.length()).toBeLessThan(2.8);
    state.update(viewOf('fog'), dir, 10, t, 0);
    expect(state.wind.value.length()).toBeLessThan(2.01);

    at('duststorm');
    expect(state.dust.value).toBeGreaterThan(0.8);
    // The dust is not counted again as fog.
    expect(state.fog.value).toBeLessThan(1e-4);
    expect(state.rain.value).toBe(0);
  });

  it('wets the ground in rain and dries it afterwards', () => {
    const state = new WeatherState();
    state.update(viewOf('clear'), dir, 500, t, 1 / 60);
    expect(state.wetness.value).toBe(0);
    const rain = viewOf('rain');
    state.update(rain, dir, 500, t, 1);
    expect(state.wetness.value).toBeGreaterThan(0);
    expect(state.wetness.value).toBeLessThan(0.2);
    for (let i = 0; i < 30; i++) state.update(rain, dir, 500, t, 1);
    expect(state.wetness.value).toBeGreaterThan(0.9);
    // Clear air again, or no weather at all: it dries slowly.
    state.update(null, dir, 500, t, 30);
    expect(state.wetness.value).toBeGreaterThan(0.7);
    expect(state.wetness.value).toBeLessThan(0.9);
    for (let i = 0; i < 20; i++) state.update(viewOf('clear'), dir, 500, t, 30);
    expect(state.wetness.value).toBeLessThan(0.05);
  });
});
