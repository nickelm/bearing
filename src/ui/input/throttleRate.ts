/**
 * The throttle as a rate (Proposal 0014, decision 363): a centering stick moves the stored
 * lever while it is pushed and leaves it where it is when let go.
 *
 * - **Rate.** Full deflection moves the lever RATE per second (idle to military in two
 *   seconds), proportional to the tuned deflection.
 * - **Military detent.** Going up the lever stops at military. Holding the stick past
 *   AB_PUSH at the detent for AB_HOLD seconds passes the gate into afterburner, and the
 *   lever keeps rising. Going down from afterburner the lever stops at military again
 *   until the stick is let go, so a pull to leave afterburner never overshoots.
 * - **Snaps.** Two taps up within DOUBLE_TAP seconds snap to military, two taps down to idle.
 *   A tap is a push past TAP_DEFLECTION that comes back inside TAP_RELEASE within TAP_TIME.
 * - An engine without an afterburner (`max` = military) ends at the detent.
 */
import { AB_GATE, MIL_DETENT } from '../../sim/flight/controlLaws';

export const RATE = MIL_DETENT / 2;
export const AB_PUSH = 0.8;
export const AB_HOLD = 0.5;
export const TAP_DEFLECTION = 0.7;
export const TAP_RELEASE = 0.3;
export const TAP_TIME = 0.3;
export const DOUBLE_TAP = 0.45;

export interface ThrottleRateState {
  /** Seconds the stick has pushed against the military detent. */
  abHold: number;
  /** The lever stopped at military on the way down; held until the stick is let go. */
  heldAtMil: boolean;
  /** The current tap: its direction and age (s), or none. */
  tapDir: 1 | -1 | 0;
  tapAge: number;
  /** The last completed tap: its direction and the seconds since it ended. */
  lastTapDir: 1 | -1 | 0;
  sinceTap: number;
}

export function throttleRateState(): ThrottleRateState {
  return { abHold: 0, heldAtMil: false, tapDir: 0, tapAge: 0, lastTapDir: 0, sinceTap: Infinity };
}

export type ThrottleEvent = 'snap-mil' | 'snap-idle' | 'afterburner' | null;

/**
 * Advances the lever by `dt` seconds for a tuned stick deflection `v` (−1..1, + up).
 * Returns the new lever and an event for the HUD, if one happened.
 */
export function throttleRate(
  s: ThrottleRateState,
  lever: number,
  v: number,
  dt: number,
  max = 1,
): { lever: number; event: ThrottleEvent } {
  const event: ThrottleEvent = null;
  // Taps: a short, firm push that returns to center.
  const a = Math.abs(v);
  s.sinceTap += dt;
  if (s.tapDir === 0 && a >= TAP_DEFLECTION) {
    s.tapDir = v > 0 ? 1 : -1;
    s.tapAge = 0;
  } else if (s.tapDir !== 0) {
    s.tapAge += dt;
    if (a <= TAP_RELEASE) {
      const dir = s.tapDir;
      const quick = s.tapAge <= TAP_TIME;
      s.tapDir = 0;
      if (quick) {
        if (s.lastTapDir === dir && s.sinceTap <= DOUBLE_TAP) {
          s.lastTapDir = 0;
          s.sinceTap = Infinity;
          s.abHold = 0;
          s.heldAtMil = false;
          return dir > 0
            ? { lever: Math.min(MIL_DETENT, max), event: 'snap-mil' }
            : { lever: 0, event: 'snap-idle' };
        }
        s.lastTapDir = dir;
        s.sinceTap = 0;
      } else s.lastTapDir = 0;
    } else if (s.tapAge > TAP_TIME) {
      // A long push is no tap; wait for the stick to come back.
      s.lastTapDir = 0;
    }
  }
  if (a < 1e-6) {
    s.abHold = 0;
    s.heldAtMil = false;
    return { lever, event };
  }
  const atMil = Math.abs(lever - MIL_DETENT) < 1e-9;
  if (v > 0) {
    s.heldAtMil = false;
    if (lever < MIL_DETENT) {
      s.abHold = 0;
      return { lever: Math.min(MIL_DETENT, max, lever + RATE * v * dt), event };
    }
    if (atMil) {
      if (max <= MIL_DETENT) return { lever, event };
      s.abHold = v >= AB_PUSH ? s.abHold + dt : 0;
      if (s.abHold < AB_HOLD) return { lever, event };
      s.abHold = 0;
      return { lever: AB_GATE, event: 'afterburner' };
    }
    return { lever: Math.min(max, lever + RATE * v * dt), event };
  }
  // Down.
  s.abHold = 0;
  if (s.heldAtMil) return { lever, event };
  let next = lever + RATE * v * dt;
  if (lever > MIL_DETENT && next < AB_GATE) {
    next = MIL_DETENT;
    s.heldAtMil = true;
  }
  return { lever: Math.max(0, next), event };
}
