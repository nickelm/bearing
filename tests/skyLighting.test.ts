import { describe, expect, it } from 'vitest';
import { DEG, KM, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  MARCH_FROM,
  MARCH_FULL,
  marchBlendAt,
  starVisibility,
} from '../src/render/sim/atmosphere/skyView';
import {
  LOW_SUN_FILL,
  nightness,
  PlanetLighting,
  skyFillGain,
  skyVibrance,
  SUNSET_VIBRANCE,
  TWILIGHT_STOPS,
  twilightGain,
} from '../src/render/sim/lighting/planetLighting';

/** A direction at an elevation above the horizon of a camera on the +Y axis (degrees). */
const at = (elevation: number, azimuth = 0) =>
  new Vec3d(
    Math.cos(elevation * DEG) * Math.cos(azimuth * DEG),
    Math.sin(elevation * DEG),
    Math.cos(elevation * DEG) * Math.sin(azimuth * DEG),
  );
const EYE = new Vec3d(0, PLANET_RADIUS + 200, 0);

describe('twilight adaptation', () => {
  it('leaves the day alone and opens up smoothly as the sun sinks', () => {
    for (const e of [90, 30, 8]) expect(twilightGain(e * DEG)).toBe(1);
    let last = 1;
    for (let e = 8; e >= -18; e -= 0.25) {
      const gain = twilightGain(e * DEG);
      expect(gain).toBeGreaterThanOrEqual(last);
      // No step: a quarter of a degree changes the light by under 5%.
      expect(gain / last).toBeLessThan(1.05);
      last = gain;
    }
    expect(twilightGain(0)).toBeGreaterThan(1.8);
    expect(twilightGain(0)).toBeLessThan(2.4);
    expect(twilightGain(-18 * DEG)).toBeCloseTo(2 ** TWILIGHT_STOPS, 9);
    expect(twilightGain(-60 * DEG)).toBeCloseTo(2 ** TWILIGHT_STOPS, 9);
  });

  it('returns to daylight above the atmosphere', () => {
    expect(twilightGain(-10 * DEG, 20 * KM)).toBe(twilightGain(-10 * DEG));
    expect(twilightGain(-10 * DEG, 130 * KM)).toBeLessThan(twilightGain(-10 * DEG));
    expect(twilightGain(-10 * DEG, 200 * KM)).toBe(1);
    expect(twilightGain(-10 * DEG, 3000 * KM)).toBe(1);
  });

  it('hands over to the night between 2° and 18° below the horizon', () => {
    expect(nightness(5 * DEG)).toBe(0);
    expect(nightness(-2 * DEG)).toBe(0);
    expect(nightness(-10 * DEG)).toBeCloseTo(0.5, 9);
    expect(nightness(-18 * DEG)).toBe(1);
    expect(nightness(-70 * DEG)).toBe(1);
  });
});

describe('planet lighting through the day', () => {
  const lighting = new PlanetLighting();

  it('lights the day with the sun alone', () => {
    lighting.update(EYE, at(40), at(30, 120));
    expect(lighting.sunIlluminance.value).toBeCloseTo(lighting.daylight, 9);
    // The moon is up, but by day it adds nothing and costs nothing.
    expect(lighting.moonIlluminance.value).toBe(0);
    expect(lighting.night).toBe(0);
    expect(lighting.sunElevation / DEG).toBeCloseTo(40, 4);
  });

  it('lights the night by the moon, in proportion to its phase', () => {
    // Full: opposite the sun.
    lighting.update(EYE, at(-35), at(35, 180));
    const full = lighting.moonIlluminance.value;
    expect(full).toBeCloseTo(lighting.fullMoon, 6);
    expect(lighting.sunIlluminance.value).toBeCloseTo(lighting.daylight * 2 ** TWILIGHT_STOPS, 6);
    // A quarter: a right angle from the sun, a third of the light.
    const t = 30 * DEG;
    const quarter = new Vec3d(
      Math.sin(35 * DEG) * Math.cos(t),
      Math.cos(35 * DEG) * Math.cos(t),
      Math.sin(t),
    );
    lighting.update(EYE, at(-35), quarter);
    expect(lighting.moonIlluminance.value / full).toBeCloseTo(1 / Math.PI, 2);
    // New: next to the sun, below the horizon with it.
    lighting.update(EYE, at(-35), at(-33, 3));
    expect(lighting.moonIlluminance.value).toBe(0);
  });

  it('fades the moon in through dusk and out below the horizon', () => {
    const moon = at(30, 180);
    const light = (sunElevation: number) => {
      lighting.update(EYE, at(sunElevation), moon);
      return lighting.moonIlluminance.value;
    };
    expect(light(-1)).toBe(0);
    expect(light(-6)).toBeGreaterThan(0);
    expect(light(-6)).toBeLessThan(light(-12));
    expect(light(-12)).toBeLessThan(light(-25));
    // The moon just under the camera's horizon still lights ground farther round the planet.
    lighting.update(EYE, at(-40), at(-5, 180));
    expect(lighting.moonIlluminance.value).toBeGreaterThan(0);
    lighting.update(EYE, at(-40), at(-20, 150));
    expect(lighting.moonIlluminance.value).toBe(0);
  });

  it('keeps plain daylight for a camera that is not at the planet', () => {
    lighting.update(new Vec3d(0, 0, 0), at(-30), at(40, 180));
    expect(lighting.sunIlluminance.value).toBe(lighting.daylight);
    expect(lighting.moonIlluminance.value).toBe(0);
  });

  it('can switch the adaptation off', () => {
    lighting.twilightAdaptation = false;
    lighting.update(EYE, at(-10), at(40, 180));
    expect(lighting.sunIlluminance.value).toBe(lighting.daylight);
    lighting.twilightAdaptation = true;
  });
});

describe("sky light and sky grade by the sun's height", () => {
  it('fills the shadows more under a low sun, without a step, and lets go by night', () => {
    for (const e of [90, 45, 30]) expect(skyFillGain(e * DEG)).toBe(1);
    for (const e of [6, 0, -6, -14]) expect(skyFillGain(e * DEG)).toBeCloseTo(LOW_SUN_FILL, 9);
    for (const e of [-18, -40, -90]) expect(skyFillGain(e * DEG)).toBe(0);
    let last = skyFillGain(30 * DEG);
    for (let e = 30; e >= -14; e -= 0.25) {
      const gain = skyFillGain(e * DEG);
      expect(gain).toBeGreaterThanOrEqual(last);
      expect(gain / last).toBeLessThan(1.02);
      last = gain;
    }
    for (let e = -14; e >= -17.75; e -= 0.25) {
      expect(skyFillGain(e * DEG)).toBeLessThanOrEqual(skyFillGain((e + 0.25) * DEG));
    }
    // With the default sky light the low sun's fill is the amount consistent with the sky.
    const lighting = new PlanetLighting();
    lighting.update(EYE, at(2), at(30, 120));
    expect(lighting.skyFill.value).toBeCloseTo(Math.PI, 6);
    lighting.update(EYE, at(50), at(30, 120));
    expect(lighting.skyFill.value).toBe(lighting.skyLight.value);
    // The knob scales both.
    lighting.skyLight.value = 1;
    lighting.update(EYE, at(2), at(30, 120));
    expect(lighting.skyFill.value).toBeCloseTo(LOW_SUN_FILL, 6);
    lighting.lowSunFill = 1;
    lighting.update(EYE, at(2), at(30, 120));
    expect(lighting.skyFill.value).toBe(1);
  });

  it('grades the sky around sunset only', () => {
    for (const e of [90, 30, 12, -16, -40]) expect(skyVibrance(e * DEG)).toBe(1);
    for (const e of [3, 0, -4, -8]) expect(skyVibrance(e * DEG)).toBeCloseTo(SUNSET_VIBRANCE, 9);
    let last = 1;
    for (let e = 12; e >= 3; e -= 0.25) {
      const v = skyVibrance(e * DEG);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v - last).toBeLessThan(0.05);
      last = v;
    }
    expect(skyVibrance(5 * DEG, 1)).toBe(1);
    const lighting = new PlanetLighting();
    lighting.update(EYE, at(40), at(30, 120));
    expect(lighting.atmosphere.vibrance.value).toBe(1);
    lighting.update(EYE, at(1), at(30, 120));
    expect(lighting.atmosphere.vibrance.value).toBeCloseTo(SUNSET_VIBRANCE, 9);
    lighting.sunsetVibrance = 1;
    lighting.update(EYE, at(1), at(30, 120));
    expect(lighting.atmosphere.vibrance.value).toBe(1);
  });
});

describe('sky switches', () => {
  it('shows no star until the sun is down', () => {
    for (const e of [90, 20, 0, -1.5]) expect(starVisibility(e * DEG)).toBe(0);
    expect(starVisibility(-4 * DEG)).toBeGreaterThan(0);
    expect(starVisibility(-4 * DEG)).toBeLessThan(1);
    expect(starVisibility(-8 * DEG)).toBe(1);
  });

  it('uses the LUT through the simulation view and the march from 50 km up', () => {
    for (const h of [0, 5 * KM, 20 * KM, MARCH_FROM]) expect(marchBlendAt(h)).toBe(0);
    expect(marchBlendAt(0.5 * (MARCH_FROM + MARCH_FULL))).toBeCloseTo(0.5, 9);
    for (const h of [MARCH_FULL, 400 * KM]) expect(marchBlendAt(h)).toBe(1);
  });
});
