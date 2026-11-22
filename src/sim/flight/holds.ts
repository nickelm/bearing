/**
 * The direct-control hold (roadmap R2.6, decision 306): an assist in the control layer
 * (rule 12) that flies the jet through the flight director while the player's hand is
 * off the stick: in direct control with the mouse free (cursor mode, or flying by keys)
 * and no stick key held. Headless and deterministic.
 *
 * It engages as the F-16's autopilot does, from the attitude the pilot left:
 *
 * - **Pitch.** Within ALT_HOLD_GAMMA of level it holds the altitude (a climb rate toward
 *   it, at most HOLD_CLIMB); steeper it holds the flight path angle, at most
 *   MAX_HOLD_GAMMA.
 * - **Roll.** Within ATT_BANK of wings level it levels the wings and holds the track;
 *   banked further it holds the bank (a steady turn), at most MAX_HOLD_BANK.
 *
 * The throttle stays the pilot's. The hold engages only in the air with the gear up;
 * on the wheels, with the gear down or near the ground the keys and the laws fly as before.
 */
import { DEG } from '../../core/units';
import type { FlightControls } from './controlLaws';
import type { FlightDirector } from './flightDirector';
import type { FlightModel } from './flightModel';
import { headingOf } from './runway';

/** Within this flight path angle (rad) the hold keeps the altitude; steeper, the path. */
export const ALT_HOLD_GAMMA = 5 * DEG;
/** Within this bank (rad) the hold levels the wings and keeps the track; further, the bank. */
export const ATT_BANK = 7 * DEG;
export const MAX_HOLD_GAMMA = 30 * DEG;
export const MAX_HOLD_BANK = 60 * DEG;
/** The altitude hold's gain (1/s) and its most climb or sink rate (m/s). */
const ALT_GAIN = 0.08;
const HOLD_CLIMB = 20;
/** The hold engages above this radar altitude (m). */
export const HOLD_FLOOR = 60;

const G = 9.806_65;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export type PitchHold = { kind: 'altitude'; altitude: number } | { kind: 'path'; gamma: number };
export type RollHold = { kind: 'track'; course: number } | { kind: 'bank'; bank: number };

/** Whether the hold may fly: in the air, the gear up, clear of the ground. */
export function holdAllowed(m: Readonly<FlightModel>): boolean {
  return !m.onGround && m.gear < 0.5 && m.telemetry.radarAltitude > HOLD_FLOOR;
}

export class AttitudeHold {
  pitch: PitchHold | null = null;
  roll: RollHold | null = null;

  get engaged(): boolean {
    return this.pitch !== null;
  }

  /** What the strip shows: 'alt hold' or 'att hold' while engaged. */
  get label(): string | null {
    if (!this.pitch) return null;
    return this.pitch.kind === 'altitude' ? 'alt hold' : 'att hold';
  }

  /** Takes the references from the attitude the aircraft has now (see the module's comment). */
  engage(m: Readonly<FlightModel>): void {
    const t = m.telemetry;
    this.pitch =
      Math.abs(t.gamma) <= ALT_HOLD_GAMMA
        ? { kind: 'altitude', altitude: t.altitude }
        : { kind: 'path', gamma: clamp(t.gamma, -MAX_HOLD_GAMMA, MAX_HOLD_GAMMA) };
    this.roll =
      Math.abs(t.bank) <= ATT_BANK
        ? { kind: 'track', course: trackOf(m) }
        : { kind: 'bank', bank: clamp(t.bank, -MAX_HOLD_BANK, MAX_HOLD_BANK) };
  }

  release(): void {
    this.pitch = null;
    this.roll = null;
  }

  /** One step: the director toward the held path; the pedals stay the pilot's. */
  fly(director: FlightDirector, m: FlightModel, ctl: FlightControls, dt: number): void {
    if (!this.pitch || !this.roll) return;
    const t = m.telemetry;
    const v = Math.max(t.tas, 40);
    const track = trackOf(m);
    let course: number;
    let maxBank = 30 * DEG;
    let maxTurnRate = 12 * DEG;
    if (this.roll.kind === 'track') course = this.roll.course;
    else {
      // A steady turn at the held bank: the director's course error that asks for its rate.
      const rate = (G * Math.tan(this.roll.bank)) / v;
      course = track + rate / director.courseGain;
      maxBank = Math.abs(this.roll.bank) + 5 * DEG;
      maxTurnRate = Math.abs(rate) + 1 * DEG;
    }
    let gamma: number;
    if (this.pitch.kind === 'path') gamma = this.pitch.gamma;
    else {
      const climb = clamp(ALT_GAIN * (this.pitch.altitude - t.altitude), -HOLD_CLIMB, HOLD_CLIMB);
      gamma = Math.asin(clamp(climb / v, -0.5, 0.5));
    }
    const pedals = ctl.yaw;
    director.fly(
      m,
      { course, gamma, speed: null, maxBank, maxTurnRate, maxLoadDelta: 1.5 },
      ctl,
      dt,
    );
    ctl.yaw = pedals;
  }
}

function trackOf(m: Readonly<FlightModel>): number {
  const t = m.telemetry;
  return t.groundSpeed > 10 ? headingOf(m.pos.clone().normalize(), m.vel) : t.heading;
}
