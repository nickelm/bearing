import { describe, expect, it } from 'vitest';
import {
  dayOfYear,
  defaultCampaignStart,
  EARTH_ORBIT,
  formatLocalDate,
  localSolarTime,
  solarDeclination,
  subsolarLongitude,
  sunDirection,
  VERNAL_EQUINOX_DAY,
  withLocalTime,
} from '../src/core/calendar';
import type { CampaignCalendar } from '../src/core/calendar';
import { latLonToDirection } from '../src/core/coords';
import { DAY, DEG, HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';

const orbit = EARTH_ORBIT;
const atDay = (d: number, tod = 0): CampaignCalendar => ({ startDay: d, startTimeOfDay: tod });

describe('calendar', () => {
  it('counts days of the year from the campaign start', () => {
    const cal = atDay(10, 6 * HOUR);
    expect(dayOfYear(0, orbit, cal)).toBeCloseTo(10.25, 9);
    expect(dayOfYear(DAY, orbit, cal)).toBeCloseTo(11.25, 9);
    // Wraps at the end of the year.
    expect(dayOfYear(360 * DAY, orbit, cal)).toBeCloseTo(5.25, 9);
  });

  it('declination is zero at the equinoxes and ±tilt at the solstices', () => {
    const tilt = orbit.axialTilt;
    const d = (day: number) => solarDeclination(0, orbit, atDay(day));
    expect(d(VERNAL_EQUINOX_DAY)).toBeCloseTo(0, 9);
    expect(d(VERNAL_EQUINOX_DAY + 365 / 4)).toBeCloseTo(tilt, 6);
    expect(d(VERNAL_EQUINOX_DAY + 365 / 2)).toBeCloseTo(0, 6);
    expect(d(VERNAL_EQUINOX_DAY + (3 * 365) / 4)).toBeCloseTo(-tilt, 6);
  });

  it('keeps the sun on the equator without axial tilt', () => {
    const flat = { ...orbit, axialTilt: 0 };
    for (let day = 0; day < 365; day += 17) {
      expect(sunDirection(0, flat, atDay(day, 5 * HOUR)).y).toBeCloseTo(0, 12);
    }
  });

  it('puts the subsolar point where it is local noon', () => {
    const cal = atDay(200, 3.5 * HOUR);
    for (const t of [0, 4 * HOUR, 13.3 * HOUR, 40 * DAY]) {
      const lon = subsolarLongitude(t, orbit, cal);
      expect(localSolarTime(t, lon, orbit, cal)).toBeCloseTo(12 * HOUR, 4);
    }
    // At midnight at longitude 0 the sun stands over the antimeridian.
    expect(Math.abs(subsolarLongitude(0, orbit, atDay(0, 0)))).toBeCloseTo(Math.PI, 9);
  });

  it('sun direction is a unit vector toward the subsolar point', () => {
    const cal = atDay(150, 7 * HOUR);
    const t = 3 * HOUR;
    const s = sunDirection(t, orbit, cal);
    expect(s.length()).toBeCloseTo(1, 12);
    const expected = latLonToDirection(
      solarDeclination(t, orbit, cal),
      subsolarLongitude(t, orbit, cal),
    );
    expect(s.distanceTo(expected)).toBeLessThan(1e-12);
  });

  it('turns the sun once per solar day, with only the seasonal drift left', () => {
    const cal = atDay(100, 0);
    const a = sunDirection(5 * HOUR, orbit, cal);
    const b = sunDirection(5 * HOUR + DAY, orbit, cal, new Vec3d());
    // Declination changes by at most ~0.4° per day.
    expect(Math.acos(Math.min(1, a.dot(b)))).toBeLessThan(0.5 * DEG);
    const c = sunDirection(17 * HOUR, orbit, cal);
    expect(a.dot(c)).toBeLessThan(-0.6);
  });

  it('sets a local time of day at a longitude', () => {
    const cal = atDay(226, 2 * HOUR);
    const lon = 100 * DEG;
    for (const target of [0, 6 * HOUR, 18.25 * HOUR]) {
      const t = withLocalTime(5 * DAY + 3 * HOUR, lon, target, orbit, cal);
      expect(localSolarTime(t, lon, orbit, cal)).toBeCloseTo(target, 4);
      expect(Math.abs(t - (5 * DAY + 3 * HOUR))).toBeLessThanOrEqual(DAY / 2 + 1e-6);
    }
  });

  it('starts campaigns in mid-August local to the main continent, at 06:00 there', () => {
    const north = latLonToDirection(40 * DEG, 70 * DEG);
    const cal = defaultCampaignStart(north, orbit);
    expect(cal.startDay).toBe(226);
    expect(localSolarTime(0, 70 * DEG, orbit, cal)).toBeCloseTo(6 * HOUR, 6);
    expect(formatLocalDate(0, 70 * DEG, orbit, cal)).toBe('15 Aug 06:00');

    // Southern hemisphere: half a year later, so it is late summer there too.
    const south = latLonToDirection(-35 * DEG, -120 * DEG);
    const cs = defaultCampaignStart(south, orbit);
    expect(cs.startDay).toBe(Math.floor((226 + 182.5) % 365));
    expect(localSolarTime(0, -120 * DEG, orbit, cs)).toBeCloseTo(6 * HOUR, 6);
    // Summer: the sun stands over the main continent's hemisphere.
    expect(solarDeclination(0, orbit, cal)).toBeGreaterThan(5 * DEG);
    expect(solarDeclination(0, orbit, cs)).toBeLessThan(-5 * DEG);
  });
});
