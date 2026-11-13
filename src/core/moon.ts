/**
 * Moon ephemeris and the rotation of the celestial sphere (decision 140).
 *
 * The planet has one moon. Like the calendar (calendar.ts), everything here
 * is a stateless function of `GameTime`, so the sim, the renderer and tests
 * agree on where the moon is, and nothing is random.
 *
 * The model is a mean one, as the sun's is:
 *
 * - The moon's elongation from the sun along the ecliptic grows evenly by a
 *   full turn per synodic month (29.53 solar days): 0 at new moon, π at full
 *   moon. Its age at planet time 0 is fixed (`MOON_EPOCH_AGE`), so a campaign
 *   that starts in mid-August starts under a waxing moon.
 * - Its orbit is inclined 5.145° to the ecliptic. The line of nodes turns
 *   backward once in 18.6 years.
 * - Parallax is ignored: the direction is the one from the planet's center.
 *
 * Frames. The world frame turns with the planet (rule 3). The celestial
 * frame here has the same axes at rest among the stars: +Y through the
 * celestial north pole, +Z toward the vernal equinox, right ascension
 * growing toward +X. `celestialRotation` is the angle about +Y that carries
 * the celestial frame into the world frame at a given time. It is defined by
 * the sun: the sun's celestial position, turned by it, is exactly
 * `sunDirection`. The stars are drawn through the same angle, so sun, moon
 * and stars keep their places among each other.
 */
import { planetTime, seasonPhase, subsolarLongitude } from './calendar';
import type { CampaignCalendar, OrbitParams } from './calendar';
import { latLonToDirection } from './coords';
import { DEG } from './units';
import type { GameTime, Radians, Seconds } from './units';
import type { Vec3d } from './vec3d';

/** New moon to new moon, in solar days. */
export const SYNODIC_MONTH_DAYS = 29.530588;
/** Inclination of the moon's orbit to the ecliptic. */
export const MOON_INCLINATION: Radians = 5.145 * DEG;
/** Years in which the line of nodes turns once, backward. */
export const NODE_PERIOD_YEARS = 18.6;
/** The moon's age at planet time 0, as a fraction of the synodic month. */
export const MOON_EPOCH_AGE = 0.687;
/** Ecliptic longitude of the ascending node at planet time 0. */
const NODE_EPOCH: Radians = 125 * DEG;

const TAU = 2 * Math.PI;
const mod = (a: number, b: number) => ((a % b) + b) % b;

/** Length of the synodic month for an orbit. */
export function synodicMonth(orbit: OrbitParams): Seconds {
  return SYNODIC_MONTH_DAYS * orbit.solarDay;
}

/**
 * The moon's mean elongation: its ecliptic longitude minus the sun's, in
 * [0, 2π). 0 is new moon, π/2 first quarter, π full moon, 3π/2 last quarter.
 */
export function moonElongation(t: GameTime, orbit: OrbitParams, cal: CampaignCalendar): Radians {
  return TAU * mod(planetTime(t, orbit, cal) / synodicMonth(orbit) + MOON_EPOCH_AGE, 1);
}

/** Days since the last new moon. */
export function moonAge(t: GameTime, orbit: OrbitParams, cal: CampaignCalendar): number {
  return (moonElongation(t, orbit, cal) / TAU) * SYNODIC_MONTH_DAYS;
}

/** The sun's ecliptic longitude, from the vernal equinox. */
function sunLongitude(t: GameTime, orbit: OrbitParams, cal: CampaignCalendar): Radians {
  return TAU * seasonPhase(t, orbit, cal);
}

/** Right ascension of a point on the ecliptic at longitude `lon`. */
function eclipticRightAscension(lon: Radians, tilt: Radians): Radians {
  return Math.atan2(Math.sin(lon) * Math.cos(tilt), Math.cos(lon));
}

/**
 * The angle about +Y that carries the celestial frame into the world frame:
 * a celestial direction at declination δ and right ascension α is the world
 * direction `latLonToDirection(δ, α + celestialRotation)`. It falls by a
 * full turn per sidereal day (the world turns east under the stars).
 */
export function celestialRotation(t: GameTime, orbit: OrbitParams, cal: CampaignCalendar): Radians {
  return (
    subsolarLongitude(t, orbit, cal) -
    eclipticRightAscension(sunLongitude(t, orbit, cal), orbit.axialTilt)
  );
}

/** Unit vector from the planet's center toward the moon, in the planet-fixed world frame. */
export function moonDirection(
  t: GameTime,
  orbit: OrbitParams,
  cal: CampaignCalendar,
  out?: Vec3d,
): Vec3d {
  const tilt = orbit.axialTilt;
  const lon = sunLongitude(t, orbit, cal) + moonElongation(t, orbit, cal);
  const node = NODE_EPOCH - (TAU * planetTime(t, orbit, cal)) / (NODE_PERIOD_YEARS * orbit.year);
  // Ecliptic latitude on an orbit inclined to the ecliptic, from the angle past the node.
  const sinLat = Math.sin(MOON_INCLINATION) * Math.sin(lon - node);
  const cosLat = Math.sqrt(1 - sinLat * sinLat);
  // Ecliptic to equatorial: a turn by the axial tilt about the equinox line.
  const x = cosLat * Math.cos(lon);
  const y = cosLat * Math.sin(lon) * Math.cos(tilt) - sinLat * Math.sin(tilt);
  const z = cosLat * Math.sin(lon) * Math.sin(tilt) + sinLat * Math.cos(tilt);
  const declination = Math.asin(Math.max(-1, Math.min(1, z)));
  const rightAscension = Math.atan2(y, x);
  return latLonToDirection(declination, rightAscension + celestialRotation(t, orbit, cal), out);
}

/** Unit vector toward the north pole of the ecliptic, in the world frame. */
export function eclipticPole(
  t: GameTime,
  orbit: OrbitParams,
  cal: CampaignCalendar,
  out?: Vec3d,
): Vec3d {
  return latLonToDirection(
    Math.PI / 2 - orbit.axialTilt,
    -Math.PI / 2 + celestialRotation(t, orbit, cal),
    out,
  );
}

/**
 * The lit fraction of the moon's disk, 0 (new) to 1 (full), from unit vectors
 * toward the sun and the moon. The sun is far away, so the phase angle at the
 * moon is π minus the angle between them.
 */
export function moonIlluminatedFraction(
  sun: Readonly<{ x: number; y: number; z: number }>,
  moon: Readonly<{ x: number; y: number; z: number }>,
): number {
  const cos = sun.x * moon.x + sun.y * moon.y + sun.z * moon.z;
  return 0.5 * (1 - Math.max(-1, Math.min(1, cos)));
}

/**
 * Moonlight relative to the full moon's, 0..1, from unit vectors toward the
 * sun and the moon: the phase law of a diffuse sphere,
 * (sin α + (π − α)·cos α) / π for the phase angle α. A half moon gives about
 * a third of the full moon's light.
 */
export function moonlightFraction(
  sun: Readonly<{ x: number; y: number; z: number }>,
  moon: Readonly<{ x: number; y: number; z: number }>,
): number {
  const cos = Math.max(-1, Math.min(1, sun.x * moon.x + sun.y * moon.y + sun.z * moon.z));
  const alpha = Math.PI - Math.acos(cos);
  return Math.max(0, (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI);
}
