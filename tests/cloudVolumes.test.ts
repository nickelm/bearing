/**
 * The pieces of the volumetric clouds that run without a GPU: the noise
 * volumes' data (the same on every call, tiling, evenly spread), the cloud's
 * form from the weather (clouds/cloudForm.ts), the weather texture's
 * queries for the march's bounds, and the quality table.
 */
import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three/webgpu';
import { latLonToDirection } from '../src/core/coords';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import { VIEW_ANGLE, viewAngle } from '../src/render/sim/clouds/cloudLayer';
import {
  developmentOf,
  DETAIL_SWING,
  RAIN_LAYER,
  thicknessOf,
  thicknessUpTo,
  TOWER_THICKNESS,
} from '../src/render/sim/clouds/cloudForm';
import {
  DETAIL_SIZE,
  generateDetailNoise,
  generateShapeNoise,
  SHAPE_SIZE,
} from '../src/render/sim/clouds/noiseVolume';
import { VOLUMETRIC_QUALITY } from '../src/render/sim/clouds/volumetrics';
import { WeatherTexture } from '../src/render/sim/clouds/weatherTexture';
import { WeatherView } from '../src/sim/weather/frame';
import { WeatherGrid } from '../src/sim/weather/grid';
import { presetFrame } from '../src/sim/weather/presets';
import { createSimWorld } from '../src/sim/world';
import { syntheticConfig } from './helpers/weatherWorld';

/** A 32-bit FNV-1a hash of a volume's 16-bit words. */
function hash(data: Uint16Array): number {
  let h = 0x811c9dc5;
  for (const v of data) {
    h = Math.imul(h ^ (v & 0xff), 0x01000193);
    h = Math.imul(h ^ (v >>> 8), 0x01000193);
  }
  return h >>> 0;
}

/** One channel of a volume as numbers. */
function channel(data: Uint16Array, c: number): Float32Array {
  const out = new Float32Array(data.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = DataUtils.fromHalfFloat(data[i * 4 + c]!);
  return out;
}

describe('cloud noise volumes', () => {
  const shape = generateShapeNoise();
  const detail = generateDetailNoise();

  it('are the same on every call', () => {
    expect(shape.length).toBe(SHAPE_SIZE ** 3 * 4);
    expect(detail.length).toBe(DETAIL_SIZE ** 3 * 4);
    expect(hash(generateShapeNoise())).toBe(hash(shape));
    expect(hash(generateDetailNoise())).toBe(hash(detail));
    // A smaller volume and another seed give other data.
    expect(hash(generateShapeNoise(32))).not.toBe(hash(shape));
    expect(hash(generateShapeNoise(SHAPE_SIZE, 7))).not.toBe(hash(shape));
  });

  it('tile: the step across the wrap is like a step inside', () => {
    for (const [data, size] of [
      [shape, SHAPE_SIZE],
      [detail, DETAIL_SIZE],
    ] as const) {
      for (let c = 0; c < 3; c++) {
        const field = channel(data, c);
        const at = (x: number, y: number, z: number) => field[(z * size + y) * size + x]!;
        let wrap = 0;
        let inside = 0;
        for (let a = 0; a < size; a++) {
          for (let b = 0; b < size; b++) {
            wrap +=
              Math.abs(at(0, a, b) - at(size - 1, a, b)) +
              Math.abs(at(a, 0, b) - at(a, size - 1, b)) +
              Math.abs(at(a, b, 0) - at(a, b, size - 1));
            const m = size >> 1;
            inside +=
              Math.abs(at(m, a, b) - at(m - 1, a, b)) +
              Math.abs(at(a, m, b) - at(a, m - 1, b)) +
              Math.abs(at(a, b, m) - at(a, b, m - 1));
          }
        }
        expect(wrap).toBeLessThan(1.5 * inside);
        expect(wrap).toBeGreaterThan(0);
      }
    }
  });

  it('spread the cloud shape evenly over 0..1, so a threshold of 1 − c leaves a share c', () => {
    for (const c of [0, 1]) {
      const field = channel(shape, c);
      for (const cover of [0.1, 0.3, 0.5, 0.8]) {
        let above = 0;
        for (const v of field) if (v > 1 - cover) above++;
        expect(above / field.length).toBeCloseTo(cover, 2);
      }
    }
    // Half floats: steps of 1/2048 at most, where bytes had 1/255.
    const levels = new Set(channel(shape, 0).subarray(0, 32_768));
    expect(levels.size).toBeGreaterThan(1500);
  });
});

describe('cloud form', () => {
  it('runs from flat cumulus through a deck and a rain layer', () => {
    expect(developmentOf(0, 0)).toBe(0);
    expect(developmentOf(0.5, 0)).toBeGreaterThan(0.15);
    expect(developmentOf(0.5, 0)).toBeLessThan(0.35);
    expect(developmentOf(1, 0)).toBeCloseTo(0.5, 1);
    // Rain takes any cover to a rain layer; a skyfall to the deepest one.
    expect(developmentOf(0.3, 0.25)).toBeCloseTo(0.625, 3);
    expect(developmentOf(1, 1)).toBeCloseTo(0.75, 3);
    expect(developmentOf(1, 9)).toBeCloseTo(0.75, 3);
    // More cover never gives shallower cloud.
    let last = 0;
    for (let cover = 0; cover <= 1.3; cover += 0.01) {
      const s = developmentOf(cover, 0);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
    expect(last).toBeLessThan(0.56);
  });

  it('gives each kind its thickness, and an upper bound for the march', () => {
    expect(thicknessOf(0)).toBe(700);
    expect(thicknessOf(0.25)).toBe(1400);
    expect(thicknessOf(0.5)).toBe(1100);
    expect(thicknessOf(0.75)).toBe(RAIN_LAYER);
    expect(thicknessOf(1)).toBeCloseTo(TOWER_THICKNESS, 6);
    for (let s = 0; s <= 1; s += 0.005) {
      for (let lower = 0; lower <= s; lower += 0.05) {
        expect(thicknessUpTo(s)).toBeGreaterThanOrEqual(thicknessOf(lower) - 1e-6);
      }
    }
    expect(DETAIL_SWING).toBeGreaterThan(0);
  });
});

describe('weather extent', () => {
  it('bounds what a shader can sample around a direction', () => {
    const world = createSimWorld(syntheticConfig());
    world.sim.advanceTo(7200);
    const live = world.weather.view();
    const grid = new WeatherGrid();
    const view = new WeatherView(grid);
    for (const frame of live.frames) if (frame) view.add(presetFrame('storm', frame, grid));
    const weather = new WeatherTexture();
    weather.setFrames(view);
    const dir = latLonToDirection(20 * DEG, 30 * DEG);
    const near = weather.extent(dir, 0);
    const wide = weather.extent(dir, 0.38);
    expect(near.cover).toBe(1);
    expect(wide.cover).toBe(1);
    // The wider circle holds at least what the narrow one does.
    expect(wide.precip).toBeGreaterThanOrEqual(near.precip);
    expect(wide.storm).toBeGreaterThanOrEqual(near.storm);
    expect(wide.fog).toBeGreaterThanOrEqual(near.fog);
    expect(wide.baseMin).toBeLessThanOrEqual(near.baseMin);
    expect(wide.baseMax).toBeGreaterThanOrEqual(near.baseMax);
    expect(near.storm).toBeGreaterThan(0.4);
    expect(near.fog).toBeGreaterThan(1e-3);
    expect(near.baseMin).toBeGreaterThan(300);

    // Uniform weather set with `fill` answers with what was filled in.
    weather.fill(0.4, 0.2, { base: 1500, fog: 1e-3, dust: 0.5, storm: 0.1 });
    const filled = weather.extent(dir, 0.2);
    expect(filled).toMatchObject({ cover: 0.4, precip: 0.2, baseMin: 1500, baseMax: 1500 });
    expect(filled.fog).toBe(1e-3);
    expect(filled.dust).toBe(0.5);
    expect(weather.groundAt(dir)).toBe(0);
    const ground = new Float32Array(grid.count).fill(250);
    weather.setGround(ground);
    expect(weather.groundAt(dir)).toBeCloseTo(250, 6);
  });
});

describe('view angle', () => {
  it('reaches the horizon and the cloud tops beyond it, and no further than from 20 km', () => {
    const radius = PLANET_RADIUS;
    let last = 0;
    for (const altitude of [0, 30, 500, 1500, 5000, 10_000, 20_000, 60_000]) {
      const angle = viewAngle(altitude, radius);
      // A cloud top 12 km up is in view while the line to it clears the planet: the horizon's
      // distance and the top's own, as an angle at the center.
      const horizon = Math.acos(radius / (radius + altitude));
      const top = Math.acos(radius / (radius + 12_000));
      if (altitude <= 20_000) expect(angle).toBeGreaterThanOrEqual(horizon + top);
      expect(angle).toBeLessThanOrEqual(VIEW_ANGLE);
      expect(angle).toBeGreaterThanOrEqual(last);
      last = angle;
    }
    // From the ground, half the angle from 20 km: a quarter of the weather to search.
    expect(viewAngle(30, radius)).toBeLessThan(0.5 * viewAngle(20_000, radius));
    expect(viewAngle(60_000, radius)).toBe(VIEW_ANGLE);
  });
});

describe('volumetric quality', () => {
  it('costs less at low than at medium than at high', () => {
    const { low, medium, high } = VOLUMETRIC_QUALITY;
    expect(low.scale).toBeLessThan(medium.scale);
    expect(medium.scale).toBeLessThan(high.scale);
    expect(low.cloudSteps).toBeLessThan(medium.cloudSteps);
    expect(medium.cloudSteps).toBeLessThanOrEqual(high.cloudSteps);
    expect(high.cloudSteps).toBeLessThanOrEqual(48);
    expect(low.lightSamples).toBeLessThanOrEqual(medium.lightSamples);
    expect(high.lightSamples).toBeLessThanOrEqual(4);
    expect(low.airSteps).toBeLessThan(high.airSteps);
    // Longer steps where there are fewer of them.
    expect(low.stepGrowth).toBeGreaterThan(high.stepGrowth);
  });
});
