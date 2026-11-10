/**
 * Calendar and sun ephemeris (decisions 15, 33).
 *
 * The planet's orbit is circular, and the clock is mean solar time, with no
 * equation of time. That matches the climate stage's insolation model
 * (worldgen/climate.ts). Everything here is a stateless function of
 * `GameTime`, so the sim, the renderer and tests agree on where the sun is.
 *
 * Planet time counts seconds since midnight at longitude 0 on day 0 of a
 * year. A campaign calendar maps GameTime 0 onto it.
 */
import { latLonToDirection } from './coords';
import { DAY, DEG, HOUR, YEAR } from './units';
import type { GameTime, Radians, Seconds } from './units';
import type { Vec3d } from './vec3d';

/** The planet parameters the calendar needs (a structural subset of PlanetParams). */
export interface OrbitParams {
  axialTilt: Radians;
  /** Mean solar day, noon to noon. */
  solarDay: Seconds;
  /** Orbital period. */
  year: Seconds;
}

/** Maps GameTime 0 onto the calendar. A campaign parameter, not a planet parameter. */
export interface CampaignCalendar {
  /** Day of the year (0-based) at campaign start. */
  startDay: number;
  /** Time of day at longitude 0 at campaign start. */
  startTimeOfDay: Seconds;
}

/** Day of the year (0-based) of the northern vernal equinox, as on Earth (20 March). */
export const VERNAL_EQUINOX_DAY = 79;

const MONTHS = [
  ['Jan', 31],
  ['Feb', 28],
  ['Mar', 31],
  ['Apr', 30],
  ['May', 31],
  ['Jun', 30],
  ['Jul', 31],
  ['Aug', 31],
  ['Sep', 30],
  ['Oct', 31],
  ['Nov', 30],
  ['Dec', 31],
] as const;

const mod = (a: number, b: number) => ((a % b) + b) % b;

export function daysPerYear(orbit: OrbitParams): number {
  return orbit.year / orbit.solarDay;
}

/** Seconds since midnight at longitude 0 on day 0 of the campaign's first year. */
export function planetTime(t: GameTime, orbit: OrbitParams, cal: CampaignCalendar): Seconds {
  return cal.startDay * orbit.solarDay + cal.startTimeOfDay + t;
}

/** Fractional day of the year (0 ≤ d < days per year), at longitude 0. */
export function dayOfYear(t: GameTime, orbit: OrbitParams, cal: CampaignCalendar): number {
  return mod(planetTime(t, orbit, cal), orbit.year) / orbit.solarDay;
}

/** Fraction of the year since the northern vernal equinox, in [0, 1). */
export function seasonPhase(t: GameTime, orbit: OrbitParams, cal: CampaignCalendar): number {
  return (
    mod(dayOfYear(t, orbit, cal) - VERNAL_EQUINOX_DAY, daysPerYear(orbit)) / daysPerYear(orbit)
  );
}

/** Local mean solar time at a longitude, seconds after midnight. */
export function localSolarTime(
  t: GameTime,
  lon: Radians,
  orbit: OrbitParams,
  cal: CampaignCalendar,
): Seconds {
  return mod(planetTime(t, orbit, cal) + (lon / (2 * Math.PI)) * orbit.solarDay, orbit.solarDay);
}

/** Solar declination: the latitude of the subsolar point. */
export function solarDeclination(t: GameTime, orbit: OrbitParams, cal: CampaignCalendar): Radians {
  return Math.asin(Math.sin(orbit.axialTilt) * Math.sin(2 * Math.PI * seasonPhase(t, orbit, cal)));
}

/** Longitude of the subsolar point, where it is local noon, in (−π, π]. */
export function subsolarLongitude(t: GameTime, orbit: OrbitParams, cal: CampaignCalendar): Radians {
  const tod = mod(planetTime(t, orbit, cal), orbit.solarDay) / orbit.solarDay;
  const lon = 2 * Math.PI * (0.5 - tod);
  return lon <= -Math.PI ? lon + 2 * Math.PI : lon;
}

/** Unit vector from the planet center toward the sun, in the planet-fixed world frame. */
export function sunDirection(
  t: GameTime,
  orbit: OrbitParams,
  cal: CampaignCalendar,
  out?: Vec3d,
): Vec3d {
  return latLonToDirection(solarDeclination(t, orbit, cal), subsolarLongitude(t, orbit, cal), out);
}

/**
 * The GameTime at which the local solar time at `lon` is `timeOfDay` on the
 * same campaign day as `t` (used by time-of-day controls).
 */
export function withLocalTime(
  t: GameTime,
  lon: Radians,
  timeOfDay: Seconds,
  orbit: OrbitParams,
  cal: CampaignCalendar,
): GameTime {
  return (
    t +
    mod(timeOfDay - localSolarTime(t, lon, orbit, cal) + orbit.solarDay / 2, orbit.solarDay) -
    orbit.solarDay / 2
  );
}

/**
 * Default campaign start: mid-August in the main continent's hemisphere (half a
 * year later if it lies south of the equator), at 06:00 local time there.
 */
export function defaultCampaignStart(
  mainContinent: Readonly<{ x: number; y: number; z: number }>,
  orbit: OrbitParams,
): CampaignCalendar {
  const days = daysPerYear(orbit);
  const midAugust = (226 / 365) * days;
  const startDay = Math.floor(mainContinent.y >= 0 ? midAugust : mod(midAugust + days / 2, days));
  const lon = Math.atan2(mainContinent.x, mainContinent.z);
  const startTimeOfDay = mod(6 * HOUR - (lon / (2 * Math.PI)) * orbit.solarDay, orbit.solarDay);
  return { startDay, startTimeOfDay };
}

/**
 * "15 Aug 06:00" for a local time at `lon`, with Earth month names scaled to
 * the year's length. The date is the local date at that longitude.
 */
export function formatLocalDate(
  t: GameTime,
  lon: Radians,
  orbit: OrbitParams,
  cal: CampaignCalendar,
): string {
  const days = daysPerYear(orbit);
  const local = planetTime(t, orbit, cal) + (lon / (2 * Math.PI)) * orbit.solarDay;
  const day = Math.floor(mod(local, orbit.year) / orbit.solarDay);
  const tod = mod(local, orbit.solarDay);
  let d = (day / days) * 365;
  let month: string = MONTHS[0][0];
  for (const [name, len] of MONTHS) {
    month = name;
    if (d < len) break;
    d -= len;
  }
  const hh = Math.floor(tod / HOUR);
  const mm = Math.floor((tod % HOUR) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(d) + 1} ${month} ${pad(hh)}:${pad(mm)}`;
}

/** Earth-like default orbit, for code without planet parameters (tests, tools). */
export const EARTH_ORBIT: OrbitParams = {
  axialTilt: 23.44 * DEG,
  solarDay: DAY,
  year: YEAR,
};
