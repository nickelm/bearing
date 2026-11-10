/** Planet parameters (design doc, "Planet Parameters", amended by docs/decisions.md). */
import type { WorldSeed } from '../core/rng';
import type { Meters, Radians, Seconds } from '../core/units';
import { DAY, DEG, EARTH_RADIUS, HOUR, PLANET_RADIUS } from '../core/units';

/** Planet parameters (design doc, "Planet Parameters"). SI units. */
export interface PlanetParams {
  seed: WorldSeed;
  radius: Meters;
  plateCount: number;
  /** Sea level is set at this height percentile. */
  oceanFraction: number;
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
  plateCount: 14,
  oceanFraction: 0.7,
  erosionStrength: 1.0,
  temperatureOffset: 0,
  moistureScale: 1.0,
  reliefScale: PLANET_RADIUS / EARTH_RADIUS,
  axialTilt: 23.44 * DEG,
  solarDay: 24 * HOUR,
  year: 365 * DAY,
};
