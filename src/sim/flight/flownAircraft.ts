/**
 * The flown aircraft (roadmap R1.5): one airframe at full fidelity, stepped at
 * the fixed FLIGHT_STEP, whoever flies it. Free Flight flies one today; R2.5
 * promotes a campaign flight into one, and the AI pilots fly them through the
 * same object (rule 12: one flight model, the input's source the only
 * difference).
 *
 * - **Airframe**: the fixed-wing model or the rotorcraft, with its control laws
 *   inside (fixed-wing) or applied by the pilot hook (the helicopter's laws).
 * - **Controls** are one object the input source writes: the player's input
 *   between frames, or `pilot` before every step (an AI pilot, the scripted
 *   test pilot, mouse aim, the helicopter's laws turning the player's command
 *   into controls).
 * - **Steps**: `advance` turns real time into whole steps (at most MAX_REAL_STEP
 *   at once and `maxSteps` per call, the remainder kept), and each step is
 *   pilot, wind, airframe, counters, `onStep` (game time, outcomes), in that
 *   order. `step` takes one step outright (tools, promotion).
 *
 * No DOM, render or worker imports: it runs on the main thread for the flown
 * aircraft (owner decision 1a) and headless in tests.
 */
import { DEG } from '../../core/units';
import { initialAvionics } from '../avionics/avionics';
import type { AvionicsState } from '../avionics/avionics';
import { Vec3d } from '../../core/vec3d';
import type { Airframe, GroundQuery } from './airframe';
import type { FlightControls } from './controlLaws';
import { FlightModel } from './flightModel';
import type { FlightSpec } from './flightSpec';
import { FLIGHT_STEP } from './rigidBody';
import { gameStep } from '../clock';
import { headingOf } from './runway';

/** An airframe that can be stepped with its controls. */
export type SteppedAirframe<C> = Airframe<C> & {
  step(controls: Readonly<C>, ground: GroundQuery): void;
};

/** Writes the controls before a step: an AI or scripted pilot, or a control law. */
export type PilotHook<C> = (airframe: SteppedAirframe<C>, controls: C, dt: number) => void;

/** Steps per `advance` at most; beyond it the remainder is dropped (the flight slows, never skips). */
export const MAX_STEPS = 30;

export class FlownAircraft<C = unknown> {
  /** Real time not yet turned into steps (s). */
  private acc = 0;
  /** Seconds flown (not counting after a crash) and meters covered since takeoff or spawn. */
  flightTime = 0;
  distance = 0;
  /** Steps the last `advance` took. */
  steps = 0;
  /**
   * The avionics state (master mode, master arm, acknowledged cautions; later
   * locks and stores), changed only by avionics commands from the player, the
   * crew or the AI (rule 14, R1.5). The display system reads it from here.
   */
  avionics: AvionicsState = initialAvionics(true);
  /** The input source when an AI or a law flies; null: the controls as the player left them. */
  pilot: PilotHook<C> | null = null;
  /** Sets the air (wind, gusts) at the airframe before each step. */
  wind: ((airframe: SteppedAirframe<C>) => void) | null = null;
  /** After each step: game time, outcomes. */
  onStep: ((airframe: SteppedAirframe<C>, dt: number) => void) | null = null;
  private readonly before = new Vec3d();

  constructor(
    readonly airframe: SteppedAirframe<C>,
    /** The controls the input source writes and the airframe reads. */
    readonly controls: C,
    /** The air-war type id or model spec id it is. */
    readonly type: string,
  ) {}

  get crashed(): string | null {
    return this.airframe.crashed;
  }

  get fuel(): number {
    return this.airframe.fuel;
  }

  /** One step of FLIGHT_STEP over `ground`, flown by `pilot` (by default this aircraft's). */
  step(ground: GroundQuery, pilot: PilotHook<C> | null = this.pilot): void {
    const a = this.airframe;
    pilot?.(a, this.controls, FLIGHT_STEP);
    this.before.copy(a.pos);
    this.wind?.(a);
    a.step(this.controls, ground);
    this.distance += this.before.distanceTo(a.pos);
    if (!a.crashed) this.flightTime += FLIGHT_STEP;
    this.onStep?.(a, FLIGHT_STEP);
  }

  /** Turns `realDt` seconds into steps; returns the steps taken. */
  advance(realDt: number, ground: GroundQuery, maxSteps = MAX_STEPS): number {
    // At 1×: the clock's rule turns the real step into game time (clock.ts).
    this.acc += gameStep(realDt, 1);
    let steps = 0;
    while (this.acc >= FLIGHT_STEP && steps < maxSteps) {
      this.acc -= FLIGHT_STEP;
      steps++;
      this.step(ground);
    }
    if (steps >= maxSteps) this.acc = 0;
    this.steps = steps;
    return steps;
  }
}

/** Where a flight is and how it moves, as a campaign flight hands it over (R1.5, R2.5). */
export interface FlightState {
  /** Center of gravity, planet-centered (m). */
  pos: Readonly<Vec3d>;
  /** Velocity (m/s). */
  vel: Readonly<Vec3d>;
  /** Fuel (kg). */
  fuel: number;
  /** Heading (rad) when the velocity gives none: at rest on the ground. */
  heading?: number;
}

/** Ground speed above which a fixed-wing state counts as flying (m/s). */
const FLYING_SPEED = 40;
/** Pitch above the flight path a promoted flight starts at: about its 1-g angle of attack. */
const START_ALPHA = 3.5 * DEG;

/**
 * A fixed-wing aircraft at full fidelity from a flight state (R1.5): placed with
 * its velocity, nose on the flight path plus about the 1-g angle of attack, gear
 * up and cruise power in the air, gear down and idle at rest. Its laws settle
 * the attitude in the first seconds, as after an air start (spawn.ts).
 */
export function fixedWingFromState(
  spec: FlightSpec,
  radius: number,
  s: FlightState,
  controls: FlightControls,
  type: string,
): FlownAircraft<FlightControls> {
  const m = new FlightModel(spec, radius);
  const up = s.pos.clone().normalize();
  const speed = s.vel.length();
  const flying = speed > FLYING_SPEED;
  const heading = speed > 1 ? headingOf(up, s.vel) : (s.heading ?? 0);
  const pitch = flying
    ? Math.asin(Math.max(-1, Math.min(1, s.vel.dot(up) / speed))) + START_ALPHA
    : 0;
  m.place(s.pos, s.vel, heading, pitch, 0);
  m.fuel = s.fuel;
  // A campaign flight's fuel is real (Free Flight's is unlimited unless asked).
  m.unlimitedFuel = false;
  m.gear = flying ? 0 : 1;
  m.speedbrake = 0;
  m.power = flying ? 0.45 : 0;
  m.afterburner = 0;
  // Long airborne, as far as the laws know: not the moment of a liftoff.
  if (flying) m.lawState.airborne = 30;
  return new FlownAircraft(m, controls, type);
}
