import { describe, expect, it } from 'vitest';
import { surfaceTemperature, WARMEST_PHASE } from '../src/render/common/seasons';
import {
  daylight,
  NIGHT_BRIGHTNESS,
  NIGHT_TINT,
  tintMultiplier,
  TWILIGHT_MU,
} from '../src/render/strategic/mapDaylight';
import { srgbToLinear } from '../src/render/common/palette';
import { LAPSE_RATE } from '../src/worldgen/climate';

describe('day and night on the map', () => {
  it('is full day under the sun, full night opposite, and half at the terminator', () => {
    expect(daylight(1).day).toBe(1);
    expect(daylight(-1).day).toBe(0);
    expect(daylight(0).day).toBeCloseTo(0.5, 12);
    expect(daylight(TWILIGHT_MU).day).toBe(1);
    expect(daylight(-TWILIGHT_MU).day).toBe(0);
  });

  it('puts the warm twilight band on the terminator only', () => {
    expect(daylight(0).twilight).toBe(1);
    expect(daylight(0.3).twilight).toBeLessThan(1e-3);
    expect(daylight(-0.3).twilight).toBeLessThan(1e-3);
  });

  it('tints the night deep blue and keeps it readable', () => {
    const night = tintMultiplier(NIGHT_TINT, NIGHT_BRIGHTNESS);
    // Blue is the brightest channel, at the chosen sRGB brightness.
    expect(night[2]).toBeCloseTo(srgbToLinear(NIGHT_BRIGHTNESS), 12);
    expect(night[2]).toBeGreaterThan(night[1]);
    expect(night[1]).toBeGreaterThan(night[0]);
    // About a third of daylight in blue: dark, not black.
    expect(night[2]).toBeGreaterThan(0.25);
    expect(night[2]).toBeLessThan(0.5);
  });
});

describe('seasonal surface temperature', () => {
  it('peaks in the northern summer in the north and half a year later in the south', () => {
    const north = (phase: number) => surfaceTemperature(10, 15, 0, 0.7, phase);
    const south = (phase: number) => surfaceTemperature(10, 15, 0, -0.7, phase);
    expect(north(WARMEST_PHASE)).toBeCloseTo(25, 12);
    expect(north(WARMEST_PHASE + 0.5)).toBeCloseTo(-5, 12);
    expect(south(WARMEST_PHASE)).toBeCloseTo(-5, 12);
    // At the equator there are no seasons.
    expect(surfaceTemperature(10, 15, 0, 0, 0.123)).toBeCloseTo(10, 12);
  });

  it('cools with reference height at the lapse rate, and not below sea level', () => {
    expect(surfaceTemperature(10, 0, 1000, 0.5, 0)).toBeCloseTo(10 - 1000 * LAPSE_RATE, 12);
    expect(surfaceTemperature(10, 0, -500, 0.5, 0)).toBe(10);
  });
});
