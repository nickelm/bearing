/**
 * Units. Bearing uses SI throughout: meters, seconds, radians, kilograms.
 *
 * Convert at the boundary (UI input, data tables) using the constants below,
 * e.g. `cruiseSpeed = 480 * KNOT`, `ceiling = 50_000 * FOOT`, `lat = 52 * DEG`.
 * Never store values in non-SI units.
 *
 * The aliases are documentation only; they do not brand the number type.
 */

export type Meters = number;
export type Seconds = number;
export type Radians = number;
export type Kilograms = number;
export type MetersPerSecond = number;

/**
 * Game time: float64 seconds since campaign start. Float64 keeps sub-millisecond
 * resolution for roughly 280 years of game time, so it never needs rebasing.
 */
export type GameTime = Seconds;

// Length
export const METER = 1;
export const KM = 1000;
export const NAUTICAL_MILE = 1852;
export const FOOT = 0.3048;

// Time
export const SECOND = 1;
export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86_400;

// Angle
export const DEG = Math.PI / 180;

// Speed
export const KNOT = NAUTICAL_MILE / HOUR;
export const KMH = KM / HOUR;

/** Default planet radius (design doc: ~1,000 km). Worldgen takes the radius as a parameter. */
export const PLANET_RADIUS: Meters = 1_000_000;

/** Earth's mean radius. Reference for scaling Earth-like relief to the planet (decision 14). */
export const EARTH_RADIUS: Meters = 6_371_000;
