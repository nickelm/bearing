import { describe, expect, it } from 'vitest';
import { EARTH_ORBIT, sunDirection } from '../src/core/calendar';
import type { CampaignCalendar } from '../src/core/calendar';
import {
  celestialRotation,
  eclipticPole,
  MOON_INCLINATION,
  moonAge,
  moonDirection,
  moonElongation,
  moonIlluminatedFraction,
  moonlightFraction,
  SYNODIC_MONTH_DAYS,
  synodicMonth,
} from '../src/core/moon';
import { DAY, DEG, HOUR, MINUTE, YEAR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';

const orbit = EARTH_ORBIT;
const cal: CampaignCalendar = { startDay: 226, startTimeOfDay: 6 * HOUR };
const angle = (a: Vec3d, b: Vec3d) => Math.acos(Math.min(1, Math.max(-1, a.dot(b))));

describe('moon ephemeris', () => {
  it('returns unit vectors and is a pure function of time', () => {
    for (const t of [0, 3.7 * HOUR, 11 * DAY, 400 * DAY]) {
      const m = moonDirection(t, orbit, cal);
      expect(m.length()).toBeCloseTo(1, 12);
      expect(moonDirection(t, orbit, cal)).toEqual(m);
    }
  });

  it('runs through its phases in a synodic month of about 29.5 days', () => {
    expect(synodicMonth(orbit) / DAY).toBeCloseTo(29.53, 2);
    const t0 = 5 * DAY;
    const e0 = moonElongation(t0, orbit, cal);
    expect(moonElongation(t0 + synodicMonth(orbit), orbit, cal)).toBeCloseTo(e0, 6);
    // Half a month later the moon stands opposite: the elongation has grown by π.
    const half = moonElongation(t0 + synodicMonth(orbit) / 2, orbit, cal);
    expect(Math.abs(((half - e0 + 2 * Math.PI) % (2 * Math.PI)) - Math.PI)).toBeLessThan(1e-6);
    // Twelve full moons in 354 days, counted from the lit fraction.
    let full = 0;
    let last = 0;
    let rising = false;
    for (let t = 0; t < 354.4 * DAY; t += HOUR) {
      const lit = moonIlluminatedFraction(
        sunDirection(t, orbit, cal),
        moonDirection(t, orbit, cal),
      );
      if (rising && lit < last) full++;
      rising = lit > last;
      last = lit;
    }
    expect(full).toBe(12);
  });

  it('starts a mid-August campaign under a waxing moon', () => {
    const age = moonAge(0, orbit, cal);
    expect(age).toBeGreaterThan(7);
    expect(age).toBeLessThan(13);
  });

  it('shows the phase its elongation implies', () => {
    for (let t = 0; t < 60 * DAY; t += 7.3 * HOUR) {
      const sun = sunDirection(t, orbit, cal);
      const moon = moonDirection(t, orbit, cal);
      const elongation = moonElongation(t, orbit, cal);
      // The angle between the two differs from the elongation along the ecliptic only by
      // the moon's latitude: cos(angle) = cos(latitude)·cos(elongation).
      const separation = angle(sun, moon);
      const folded = elongation > Math.PI ? 2 * Math.PI - elongation : elongation;
      expect(Math.abs(separation - folded)).toBeLessThan(MOON_INCLINATION + 1e-6);
      const lit = moonIlluminatedFraction(sun, moon);
      expect(lit).toBeCloseTo(0.5 * (1 - Math.cos(separation)), 12);
      expect(Math.abs(lit - 0.5 * (1 - Math.cos(elongation)))).toBeLessThan(0.05);
    }
    // New, quarter and full by the vectors alone.
    const s = new Vec3d(1, 0, 0);
    expect(moonIlluminatedFraction(s, new Vec3d(1, 0, 0))).toBeCloseTo(0, 12);
    expect(moonIlluminatedFraction(s, new Vec3d(0, 0, 1))).toBeCloseTo(0.5, 12);
    expect(moonIlluminatedFraction(s, new Vec3d(-1, 0, 0))).toBeCloseTo(1, 12);
    // Moonlight: none at new moon, all at full, about a third at the quarters.
    expect(moonlightFraction(s, new Vec3d(1, 0, 0))).toBeCloseTo(0, 9);
    expect(moonlightFraction(s, new Vec3d(-1, 0, 0))).toBeCloseTo(1, 9);
    expect(moonlightFraction(s, new Vec3d(0, 0, 1))).toBeCloseTo(1 / Math.PI, 9);
  });

  it('keeps within 5.1° of the ecliptic, which the sun never leaves, and reaches both sides', () => {
    let north = 0;
    let south = 0;
    for (let t = 0; t < 40 * DAY; t += 2.9 * HOUR) {
      const pole = eclipticPole(t, orbit, cal);
      expect(Math.abs(sunDirection(t, orbit, cal).dot(pole))).toBeLessThan(1e-9);
      const latitude = Math.asin(moonDirection(t, orbit, cal).dot(pole));
      expect(Math.abs(latitude)).toBeLessThanOrEqual(MOON_INCLINATION + 1e-9);
      north = Math.max(north, latitude);
      south = Math.min(south, latitude);
    }
    expect(north / DEG).toBeGreaterThan(5);
    expect(south / DEG).toBeLessThan(-5);
  });

  it('moves continuously, about 12° a day against the sun and a turn a day across the sky', () => {
    const step = MINUTE;
    let previous = moonDirection(0, orbit, cal);
    let worst = 0;
    // Across a year's end and many day boundaries.
    for (let t = step; t < 3 * DAY; t += step) {
      const m = moonDirection(t, orbit, cal);
      worst = Math.max(worst, angle(previous, m));
      previous = m;
    }
    const wrap = YEAR - 226 * DAY - 6 * HOUR;
    worst = Math.max(
      worst,
      angle(moonDirection(wrap - 30, orbit, cal), moonDirection(wrap + 30, orbit, cal)),
    );
    // A turn a day is 0.25° a minute at most.
    expect(worst / DEG).toBeLessThan(0.26);
    expect(worst / DEG).toBeGreaterThan(0.2);
    // The moon falls behind the sun by a turn per synodic month.
    const perDay =
      (moonElongation(DAY, orbit, cal) - moonElongation(0, orbit, cal) + 2 * Math.PI) %
      (2 * Math.PI);
    expect(perDay / DEG).toBeCloseTo(360 / SYNODIC_MONTH_DAYS, 6);
  });

  it('turns the celestial sphere once per sidereal day, with the sun in its place', () => {
    // The rotation carries the sun's celestial position onto sunDirection (its definition),
    // and falls by a full turn plus the sun's own yearly drift each solar day.
    const a = celestialRotation(0, orbit, cal);
    const b = celestialRotation(DAY, orbit, cal);
    const drift = (((a - b) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    expect(drift / DEG).toBeGreaterThan(0.8);
    expect(drift / DEG).toBeLessThan(1.2);
    // A star overhead at one time is overhead again a sidereal day later, not a solar day.
    const sidereal = DAY * (1 - 1 / 366.25);
    const spin = (t: number) => {
      const r = celestialRotation(t, orbit, cal);
      return new Vec3d(Math.sin(r), 0, Math.cos(r));
    };
    expect(angle(spin(0), spin(sidereal)) / DEG).toBeLessThan(0.05);
    expect(angle(spin(0), spin(DAY)) / DEG).toBeGreaterThan(0.8);
  });
});
