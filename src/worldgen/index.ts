/**
 * worldgen: the planet generation pipeline (design doc, "World Generation Pipeline").
 *
 * Stages (each one draws randomness only from its own named stream, rng(seed, "<stage>")):
 *   1 cube-sphere grid · 2 tectonic plates · 3 detail noise · 4 erosion (GPU)
 *   5 climate and biomes · 6 rivers · 7 geography check · 8 front line
 *   9 settlements and roads · 10 airbases
 *
 * May use three/webgpu and three/tsl for GPU compute. Must not import render or ui.
 * Nothing is implemented yet; this module holds the parameter set.
 */
import type { WorldSeed } from '../core/rng';
import type { Meters, Radians, Seconds } from '../core/units';
import { DAY, DEG, EARTH_RADIUS, HOUR, KM, PLANET_RADIUS } from '../core/units';

/** Planet parameters (design doc, "Planet Parameters"). SI units. */
export interface PlanetParams {
  seed: WorldSeed;
  radius: Meters;
  /** Scales aircraft fuel capacity and burn rate, not speed. */
  rangeFactor: number;
  plateCount: number;
  /** Sea level is set at this height percentile. */
  oceanFraction: number;
  /** Allowed width of the ocean between the two continents, [min, max]. */
  oceanGap: readonly [Meters, Meters];
  erosionStrength: number;
  /** Kelvin offset applied to the temperature model (equal to °C offset). */
  temperatureOffset: number;
  moistureScale: number;
  /**
   * Multiplier from Earth-like reference elevations and depths to this planet's
   * (decision 14). Default R / R_Earth, so mountains are proportionate to the globe.
   * Does not affect the atmosphere or aircraft performance.
   */
  reliefScale: number;
  /** Obliquity of the rotation axis; drives seasons (decision 15). */
  axialTilt: Radians;
  /** Mean solar day (noon to noon). */
  solarDay: Seconds;
  /** Orbital period. */
  year: Seconds;
}

/**
 * Defaults. The design doc calls for a random seed by default. The app picks
 * one at the UI level (or reads ?seed=); this fixed value keeps tests and dev reloads stable.
 */
export const DEFAULT_PLANET_PARAMS: Readonly<PlanetParams> = {
  seed: 1983,
  radius: PLANET_RADIUS,
  rangeFactor: 0.5,
  plateCount: 14,
  oceanFraction: 0.55,
  oceanGap: [1200 * KM, 1800 * KM],
  erosionStrength: 1.0,
  temperatureOffset: 0,
  moistureScale: 1.0,
  reliefScale: PLANET_RADIUS / EARTH_RADIUS,
  axialTilt: 23.44 * DEG,
  solarDay: 24 * HOUR,
  year: 365 * DAY,
};
