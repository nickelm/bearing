/**
 * Free Flight's clock (decision 134): when a flight starts. The mode has no
 * campaign, so it picks its own day on the campaign's calendar: the day
 * nearest full moon within the first month, so that a flight that starts at
 * night has the moon up from dusk to dawn (core/moon.ts). The season is the
 * campaign start's, within a month. The time of day is the player's choice.
 */
import { withLocalTime } from '../core/calendar';
import type { CampaignCalendar, OrbitParams } from '../core/calendar';
import { moonAge, SYNODIC_MONTH_DAYS } from '../core/moon';
import { HOUR } from '../core/units';
import type { GameTime, Radians } from '../core/units';

/**
 * The campaign day (1 or later) on which Free Flight flies: of the first
 * synodic month's days, the one whose moon is nearest full.
 */
export function freeFlightDay(orbit: OrbitParams, calendar: CampaignCalendar): number {
  const full = SYNODIC_MONTH_DAYS / 2;
  let best = 1;
  let bestOff = Infinity;
  for (let day = 1; day <= Math.ceil(SYNODIC_MONTH_DAYS); day++) {
    const off = Math.abs(moonAge(day * orbit.solarDay, orbit, calendar) - full);
    if (off < bestOff) {
      bestOff = off;
      best = day;
    }
  }
  return best;
}

/**
 * The game time at which a flight starts: local solar time `timeOfDay`
 * (hours) at longitude `lon`, within half a day of Free Flight's day.
 */
export function flightStartTime(
  lon: Radians,
  timeOfDay: number,
  orbit: OrbitParams,
  calendar: CampaignCalendar,
): GameTime {
  return withLocalTime(
    freeFlightDay(orbit, calendar) * orbit.solarDay,
    lon,
    timeOfDay * HOUR,
    orbit,
    calendar,
  );
}
