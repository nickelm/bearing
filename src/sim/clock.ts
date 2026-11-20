/**
 * The one clock's rules (roadmap R1.5): game time is a float64 count of
 * seconds (GameTime, rule 2), and the campaign's host and the flown aircraft
 * turn real time into it the same way.
 *
 * - The campaign (SimHost) advances by `gameStep(realDt, rate)`: real time,
 *   capped at MAX_REAL_STEP, times the rate (one of TIME_RATES).
 * - A flown aircraft (FlownAircraft) advances in whole FLIGHT_STEPs of game
 *   time, from real time capped the same way; its own rate is 1× in Free
 *   Flight, and up to FLOWN_MAX_RATE in cruise once R2.5 lets the flight speed
 *   up (design, *Time*).
 */
import type { Seconds } from '../core/units';
import { FLIGHT_STEP } from './flight/rigidBody';

export { FLIGHT_STEP };

/** Clock rates offered to the player: paused, then game seconds per real second. */
export const TIME_RATES = [0, 1, 4, 16, 64, 256] as const;

/** Longest real-time step taken at once (s): a stalled tab does not leap ahead. */
export const MAX_REAL_STEP: Seconds = 0.25;

/** Highest rate while flying (R2.5: up to 8× in cruise, cancelled on any threat). */
export const FLOWN_MAX_RATE = 8;

/** Game seconds a real step of `realDt` seconds is worth at `rate`. */
export function gameStep(realDt: Seconds, rate: number): Seconds {
  return Math.min(Math.max(realDt, 0), MAX_REAL_STEP) * rate;
}

/** What the flight cap reads of a flown aircraft and its surroundings (R2.5). */
export interface FlightCapInput {
  airborne: boolean;
  gearDown: boolean;
  /** Height above the ground (m). */
  heightAboveGround: number;
  /** Distance to the mission's target or station (m). */
  targetDistance: number;
  /** Distance to the nearest enemy flight in the air (m; Infinity: none). */
  enemyDistance: number;
}

/** Least height above the ground for cruise (m, about 1,000 ft). */
export const CRUISE_HEIGHT = 300;
/** Within this distance of its target or station a flight is at work, not in cruise (m). */
export const TARGET_AREA = 40_000;
/** An enemy flight this close is a threat (m, about 65 nm: a fighter radar's range and some). */
export const THREAT_RANGE = 120_000;

/**
 * The fastest the clock may run while the player flies (design, *Time*): FLOWN_MAX_RATE
 * in cruise, 1× otherwise. Cruise is in the air with the gear up, above CRUISE_HEIGHT,
 * outside the target area, and no enemy flight within THREAT_RANGE. The reason is null
 * in cruise, else what cancels the acceleration.
 */
export function flightRateCap(i: Readonly<FlightCapInput>): {
  rate: number;
  reason: string | null;
} {
  const reason = !i.airborne
    ? 'on the ground'
    : i.gearDown
      ? 'gear down'
      : i.heightAboveGround < CRUISE_HEIGHT
        ? 'low'
        : i.enemyDistance < THREAT_RANGE
          ? 'enemy aircraft near'
          : i.targetDistance < TARGET_AREA
            ? 'in the target area'
            : null;
  return { rate: reason ? 1 : FLOWN_MAX_RATE, reason };
}
