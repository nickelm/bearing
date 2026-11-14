/**
 * The air's velocity at an aircraft, from the weather (decision 143): the
 * flight model takes its airspeed relative to the moving air
 * (`FlightModel.wind`), so a crosswind drifts the aircraft, a headwind
 * shortens the takeoff roll, and rough air shakes it.
 *
 * `airVelocity` adds two parts:
 *
 * - The wind of the weather view at the aircraft's place and altitude
 *   (`WeatherView.wind`, east and north components), turned into the world
 *   frame. Near the ground it is held down: at most GROUND_WIND_LIMIT on the
 *   ground, rising to the weather's wind at SHELTER_HEIGHT above it. The
 *   storm, blizzard and dust-storm presets blow a gale across whatever runway
 *   the player chose, more than any fighter's crosswind limit; with the limit
 *   a takeoff in a storm drifts and shakes but stays on the pavement.
 * - Gusts: a smooth field that stands in the air, the same for every caller
 *   and every run (a lattice of hashed values in position and time, no random
 *   numbers; rule 5). Its strength comes from the weather: storms most
 *   (half of it at the ground, where takeoffs and landings happen), cloud
 *   that is flown through, and a strong wind near the ground.
 *
 * The gust field is one octave of value noise per axis with cells of
 * GUST_CELL meters that change every GUST_PERIOD seconds, so an aircraft at
 * 150 m/s meets a new gust about every two seconds. `gustStrength` is the
 * root-mean-square speed of the gusts in m/s.
 */
import type { GameTime, Meters } from '../../core/units';
import type { Vec3d } from '../../core/vec3d';
import type { WeatherReport, WeatherView, Wind } from '../weather/frame';

/** Size of a gust (m) and the time in which the field changes (s). */
export const GUST_CELL: Meters = 320;
export const GUST_PERIOD = 6;
/** Most wind an aircraft on the ground feels (m/s), and the height at which it feels all of it (m). */
export const GROUND_WIND_LIMIT = 8;
export const SHELTER_HEIGHT: Meters = 150;
/** RMS gust speed (m/s) in a full thunderstorm, in cloud, and per m/s of wind near the ground. */
export const GUST_STORM = 4;
export const GUST_CLOUD = 1.2;
export const GUST_PER_WIND = 0.12;
/** Height above the ground up to which the wind's own turbulence reaches (m). */
export const GUST_SURFACE_LAYER: Meters = 600;
/** Height above the ground from which gusts have their full vertical part (m). */
export const VERTICAL_GUST_HEIGHT: Meters = 150;
/** Depth of cloud above its base that counts as "in cloud" for the gusts (m). */
const CLOUD_DEPTH: Meters = 2500;
/** RMS of one octave of trilinear value noise with samples uniform in −1..1. */
const NOISE_RMS = 0.33;

/** A hash of four lattice coordinates and a channel to −1..1. */
function lattice(x: number, y: number, z: number, t: number, channel: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ Math.imul(z | 0, 0x3c6ef372);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39) ^ Math.imul(t | 0, 0x61c88647);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) ^ Math.imul(channel + 1, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 0x7fffffff - 1;
}

const fade = (f: number) => f * f * (3 - 2 * f);

/** Smooth noise −1..1 over position (in cells) and time (in periods), per channel. */
function gustNoise(x: number, y: number, z: number, t: number, channel: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const t0 = Math.floor(t);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const fz = fade(z - z0);
  const ft = fade(t - t0);
  let sum = 0;
  for (let c = 0; c < 16; c++) {
    const dx = c & 1;
    const dy = (c >> 1) & 1;
    const dz = (c >> 2) & 1;
    const dt = (c >> 3) & 1;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz) * (dt ? ft : 1 - ft);
    sum += w * lattice(x0 + dx, y0 + dy, z0 + dz, t0 + dt, channel);
  }
  return sum;
}

/**
 * RMS gust speed (m/s) for the weather at a place: `report` there, the
 * aircraft's altitude above sea level and its height above the ground, and
 * the mean wind's speed at the aircraft.
 */
export function gustStrength(
  report: Readonly<WeatherReport>,
  altitude: Meters,
  aboveGround: Meters,
  windSpeed: number,
): number {
  const ground = altitude - aboveGround;
  const base = ground + report.cloudBase;
  // Inside the cloud layer: from its base up through its depth, by the cover.
  const inCloud =
    report.cloudCover *
    Math.min(1, Math.max(0, (altitude - base) / 200)) *
    Math.min(1, Math.max(0, (base + CLOUD_DEPTH - altitude) / 500));
  // A storm shakes the air under it and in it, up to its top; half as much at the ground.
  const storm =
    report.storm *
    Math.min(1, Math.max(0, (12_000 - altitude) / 2000)) *
    (0.5 + 0.5 * Math.min(1, Math.max(0, aboveGround / (2 * SHELTER_HEIGHT))));
  const surface = Math.min(1, Math.max(0, 1 - aboveGround / GUST_SURFACE_LAYER));
  return Math.hypot(GUST_STORM * storm, GUST_CLOUD * inCloud, GUST_PER_WIND * windSpeed * surface);
}

const windScratch: Wind = { east: 0, north: 0 };

/**
 * The air's velocity (world frame, m/s) at a planet-centered position and a
 * game time, into `out`: the weather's wind there plus `gusts` times the gust
 * field (1 = as the weather has it, 0 = the steady wind alone). `radius` is
 * the planet's, `aboveGround` the aircraft's height over the ground (m).
 * Without a view the air is still.
 */
export function airVelocity(
  view: WeatherView | null,
  pos: Readonly<Vec3d>,
  radius: Meters,
  t: GameTime,
  aboveGround: Meters,
  out: Vec3d,
  gusts = 1,
): Vec3d {
  if (!view || !view.ready) return out.set(0, 0, 0);
  const r = pos.length();
  const ux = pos.x / r;
  const uy = pos.y / r;
  const uz = pos.z / r;
  const altitude = r - radius;
  const wind = view.wind(pos, altitude, t, windScratch);
  let speed = Math.hypot(wind.east, wind.north);
  if (speed > GROUND_WIND_LIMIT) {
    const shelter = Math.min(1, Math.max(0, aboveGround / SHELTER_HEIGHT));
    const felt = GROUND_WIND_LIMIT + (speed - GROUND_WIND_LIMIT) * shelter;
    wind.east *= felt / speed;
    wind.north *= felt / speed;
    speed = felt;
  }
  // East = ŷ × up, north = up × east, as on the weather grid; east is +X at the poles.
  let ex = uz;
  let ez = -ux;
  const el = Math.hypot(ex, ez);
  if (el < 1e-9) {
    ex = 1;
    ez = 0;
  } else {
    ex /= el;
    ez /= el;
  }
  out.set(
    wind.east * ex + wind.north * uy * ez,
    wind.north * (uz * ex - ux * ez),
    wind.east * ez - wind.north * uy * ex,
  );
  if (!(gusts > 0)) return out;
  const strength =
    (gusts * gustStrength(view.report(pos, t), altitude, aboveGround, speed)) / NOISE_RMS;
  if (!(strength > 0)) return out;
  const x = pos.x / GUST_CELL;
  const y = pos.y / GUST_CELL;
  const z = pos.z / GUST_CELL;
  const time = t / GUST_PERIOD;
  const gx = strength * gustNoise(x, y, z, time, 0);
  const gy = strength * gustNoise(x, y, z, time, 1);
  const gz = strength * gustNoise(x, y, z, time, 2);
  // The ground stops the air's vertical motion: that part fades out toward it.
  const vertical = gx * ux + gy * uy + gz * uz;
  const damp = (Math.min(1, Math.max(0, aboveGround / VERTICAL_GUST_HEIGHT)) - 1) * vertical;
  out.x += gx + damp * ux;
  out.y += gy + damp * uy;
  out.z += gz + damp * uz;
  return out;
}
