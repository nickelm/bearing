import { describe, expect, it } from 'vitest';
import { randomUnitVector } from '../src/core/coords';
import { CubeGrid } from '../src/core/cubeGrid';
import { rng } from '../src/core/rng';
import { DAY, HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { buildWeatherClimate } from '../src/sim/weather/climate';
import { CEILING_COVER, Channel, WeatherView } from '../src/sim/weather/frame';
import { WeatherGrid } from '../src/sim/weather/grid';
import { SystemKind } from '../src/sim/weather/model';
import { createSimWorld } from '../src/sim/world';
import { RADIUS, syntheticConfig } from './helpers/weatherWorld';

describe('WeatherGrid', () => {
  it('interpolates a smooth field continuously, across face seams too', () => {
    const grid = new WeatherGrid();
    const f = (x: number, y: number, z: number) => Math.sin(3 * x) + y * y + 0.5 * z;
    const values = new Float64Array(grid.count);
    for (let s = 0; s < grid.count; s++) {
      const d = grid.directions;
      values[s] = f(d[s * 3]!, d[s * 3 + 1]!, d[s * 3 + 2]!);
    }
    const idx = new Int32Array(4);
    const w = new Float64Array(4);
    const r = rng(3, 'test/weather-grid');
    const d = new Vec3d();
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      randomUnitVector(r, d);
      grid.bilinear(d, idx, w);
      let v = 0;
      for (let k = 0; k < 4; k++) v += values[idx[k]!]! * w[k]!;
      worst = Math.max(worst, Math.abs(v - f(d.x, d.y, d.z)));
    }
    // A sample spacing is about 0.065 rad; bilinear error is second order in it.
    expect(worst).toBeLessThan(0.02);
    // Both sides of a seam agree to interpolation error (no step at the seam).
    const a = new Vec3d(1, 0.3, 1 - 1e-9).normalize();
    const b = new Vec3d(1 - 1e-9, 0.3, 1).normalize();
    const at = (p: Vec3d) => {
      grid.bilinear(p, idx, w);
      return [0, 1, 2, 3].reduce((s, k) => s + values[idx[k]!]! * w[k]!, 0);
    };
    expect(Math.abs(at(a) - at(b))).toBeLessThan(0.005);
  });
});

describe('weather climate input', () => {
  it('averages the maps and finds terrain slopes', () => {
    const n = 64;
    const cells = new CubeGrid(n);
    const height = new Float32Array(cells.cellCount);
    // Physical height rises 2,000 m per planet radius to the north; land everywhere.
    for (let c = 0; c < cells.cellCount; c++) height[c] = 3000 + 2000 * cells.centers[c * 3 + 1]!;
    const fill = (v: number) => new Float32Array(cells.cellCount).fill(v);
    const grid = new WeatherGrid();
    const c = buildWeatherClimate(
      {
        resolution: n,
        height,
        temperature: fill(12),
        temperatureRange: fill(8),
        precipitation: fill(1375),
        windEast: fill(5),
        windNorth: fill(0),
        reliefScale: 0.5,
      },
      grid,
      RADIUS,
    );
    const s = grid.nearest(new Vec3d(0.3, 0, 1));
    expect(c.temperature[s]).toBeCloseTo(12, 4);
    expect(c.wetness[s]).toBeCloseTo(0.5, 4);
    expect(c.land[s]).toBe(1);
    // Reference slope at the equator: 2000 m / 0.5 relief per radius, northward.
    expect(c.slopeNorth[s]! / (4000 / RADIUS)).toBeCloseTo(1, 1);
    expect(Math.abs(c.slopeEast[s]!)).toBeLessThan(1e-4);
  });
});

describe('weather model', () => {
  it('is identical whether it ticks hour by hour or jumps, and depends on the seed', () => {
    const a = createSimWorld(syntheticConfig());
    for (let h = 1; h <= 30; h++) a.sim.advanceTo(h * HOUR - 0.5);
    a.sim.advanceTo(30 * HOUR);
    const b = createSimWorld(syntheticConfig());
    b.sim.advanceTo(30 * HOUR);
    expect(a.weather.hour).toBe(31);
    expect(a.weather.frameData(31)).toEqual(b.weather.frameData(31));
    expect(a.weather.frameData(30)).toEqual(b.weather.frameData(30));
    expect(a.sim.hash()).toBe(b.sim.hash());

    const other = createSimWorld(syntheticConfig(8));
    other.sim.advanceTo(30 * HOUR);
    expect(other.weather.frameData(31)).not.toEqual(b.weather.frameData(31));
  });

  it('gives plausible weather that clears everywhere now and then', () => {
    const w = createSimWorld(syntheticConfig());
    const grid = w.weather.grid;
    const n = grid.count;
    const hours = 20 * 24;
    const clear = new Float64Array(n);
    let cover = 0;
    let precip = 0;
    let lowCeilings = 0;
    let maxSurfaceWind = 0;
    let lows = 0;
    let minVisibility = Infinity;
    for (let k = 1; k <= hours; k++) {
      w.sim.advanceTo(k * HOUR);
      const f = w.weather.frameData(w.weather.hour);
      for (let s = 0; s < n; s++) {
        const c = f[Channel.Cover * n + s]!;
        cover += c / (n * hours);
        if (c < 0.3) clear[s]! += 1 / hours;
        if (f[Channel.Precipitation * n + s]! > 0.2 / 3.6e6) precip += 1 / (n * hours);
        if (c >= CEILING_COVER && f[Channel.CloudBase * n + s]! < 300)
          lowCeilings += 1 / (n * hours);
        const ws = Math.hypot(f[Channel.WindEast0 * n + s]!, f[(Channel.WindEast0 + 1) * n + s]!);
        maxSurfaceWind = Math.max(maxSurfaceWind, ws);
        minVisibility = Math.min(minVisibility, f[Channel.Visibility * n + s]!);
      }
      lows += w.weather.systems.filter((s) => s.kind === SystemKind.Low).length / hours;
    }
    expect(minVisibility).toBeGreaterThan(100);
    expect(cover).toBeGreaterThan(0.2);
    expect(cover).toBeLessThan(0.55);
    expect(precip).toBeGreaterThan(0.02);
    expect(precip).toBeLessThan(0.25);
    expect(lowCeilings).toBeGreaterThan(0);
    expect(lowCeilings).toBeLessThan(0.15);
    expect(maxSurfaceWind).toBeGreaterThan(10);
    expect(maxSurfaceWind).toBeLessThan(60);
    expect(lows).toBeGreaterThan(2);
    // Even the wettest places see clear sky regularly (owner review, decision 59).
    const sorted = Array.from(clear).sort((x, y) => x - y);
    expect(sorted[0]).toBeGreaterThan(0.02);
    expect(sorted[Math.floor(n * 0.05)]).toBeGreaterThan(0.15);
  });

  it('turns cyclonically around lows: counterclockwise in the north', () => {
    const w = createSimWorld(syntheticConfig());
    let checked = 0;
    let deepest = 0;
    for (let day = 1; day <= 6 && checked < 4; day++) {
      w.sim.advanceTo(day * DAY);
      const view = w.weather.view();
      const t = w.sim.time;
      for (const s of w.weather.systems) {
        const a = s.age / s.life;
        if (s.kind !== SystemKind.Low || a < 0.3 || a > 0.55 || Math.abs(s.y) < 0.4) continue;
        // Circulation around a ring at the radius of maximum wind, at 850 hPa.
        const c = new Vec3d(s.x, s.y, s.z);
        const east = new Vec3d(0, 1, 0).cross(c).normalize();
        const north = c.clone().cross(east);
        const ang = s.radius / RADIUS;
        let circulation = 0;
        const p = new Vec3d();
        for (let i = 0; i < 16; i++) {
          const th = (2 * Math.PI * i) / 16;
          const re = Math.cos(th);
          const rn = Math.sin(th);
          p.set(
            c.x * Math.cos(ang) + (east.x * re + north.x * rn) * Math.sin(ang),
            c.y * Math.cos(ang) + (east.y * re + north.y * rn) * Math.sin(ang),
            c.z * Math.cos(ang) + (east.z * re + north.z * rn) * Math.sin(ang),
          );
          const wind = view.wind(p, 1500, t);
          // Counterclockwise tangent at angle θ (east/north frame of the center).
          circulation += (wind.east * -rn + wind.north * re) / 16;
        }
        const hemisphere = Math.sign(s.y);
        expect(circulation * hemisphere).toBeGreaterThan(2);
        // Pressure is lower at the center than on the ring, unless a neighbor overlaps.
        if (view.sample(Channel.Pressure, c, t) < view.sample(Channel.Pressure, p, t)) deepest++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(deepest / checked).toBeGreaterThan(0.5);
  });

  it('interpolates between hourly frames', () => {
    const w = createSimWorld(syntheticConfig());
    w.sim.advanceTo(10 * HOUR);
    const view = new WeatherView(w.weather.grid);
    view.add(w.weather.frame(10));
    view.add(w.weather.frame(11));
    const d = new Vec3d(0.2, 0.7, 0.6).normalize();
    const t0 = view.sample(Channel.Temperature, d, 10 * HOUR);
    const t1 = view.sample(Channel.Temperature, d, 11 * HOUR);
    expect(view.sample(Channel.Temperature, d, 10.5 * HOUR)).toBeCloseTo((t0 + t1) / 2, 4);
    // A report gives a ceiling only under broken or overcast cloud.
    const r = view.report(d, 10.25 * HOUR);
    expect(Number.isFinite(r.ceiling)).toBe(r.cloudCover >= CEILING_COVER);
    // The next hour's frame shifts the bracket.
    w.sim.advanceTo(11 * HOUR);
    view.add(w.weather.frame(12));
    expect(view.frames.map((f) => f?.hour)).toEqual([11, 12]);
  });
});
