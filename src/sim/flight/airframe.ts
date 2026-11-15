/**
 * One flown airframe, fixed- or rotary-wing (rule 12; decisions 149, 154): what
 * Free Flight's loop, the chase camera's feed, the HUD frame's landing aid and
 * the outcomes read. The Kestrel's `FlightModel` implements it; the rotorcraft
 * model of track H will too. What only a jet has (throttle stages, the
 * afterburner, the speedbrake, the F-16's control laws) stays on `FlightModel`.
 *
 * Body axes: x forward, y right, z down. World: planet-centered float64 meters.
 */
import type { Vec3d } from '../../core/vec3d';
import type { AirState } from './atmosphere';
import type { ContactState, GroundQuery } from './contact';
import type { AttitudeTelemetry, RigidBodyState } from './rigidBody';

export type { ContactState, GroundQuery, SurfaceKind } from './contact';
export type { RigidBodyState } from './rigidBody';

export type AirframeKind = 'fixed-wing' | 'rotorcraft';

/**
 * Telemetry every airframe keeps current: air data, loads and forces each
 * substep, attitude and speeds each substep (AttitudeTelemetry), and the radar
 * altitude once per step.
 */
export interface AirframeTelemetry extends AttitudeTelemetry {
  /** Angle of attack and sideslip of the fuselage (rad), as the probes sense them. */
  alpha: number;
  beta: number;
  /** True and calibrated airspeed (m/s), Mach and dynamic pressure (Pa), as sensed. */
  tas: number;
  cas: number;
  mach: number;
  qbar: number;
  /**
   * Load factor (g) the g meter shows: along the lift for a wing, along the
   * rotor's thrust for a rotorcraft; and along body −z.
   */
  load: number;
  normalLoad: number;
  /** Height of the lowest wheel or skid above the ground under the CG (m). */
  radarAltitude: number;
  /** Forces in body axes (N): aerodynamic (rotor thrust included), ground contact, gravity. */
  aero: Vec3d;
  gearForce: Vec3d;
  gravity: Vec3d;
  /** Weight on the wheels or skids, 0..1. */
  wow: number;
  /** Fuel flow (kg/s). */
  fuelFlow: number;
  /** The standard atmosphere at the CG. */
  air: AirState;
}

/**
 * An airframe flown by the controls record `C` (FlightControls for the Kestrel).
 * `step` is a method, not a function-typed property, so its parameter is
 * bivariant and `Airframe` (C = unknown) accepts any airframe.
 */
export interface Airframe<
  C = unknown,
  T extends AirframeTelemetry = AirframeTelemetry,
> extends RigidBodyState {
  readonly kind: AirframeKind;
  /** Current mass (kg). */
  readonly mass: number;
  fuel: number;
  unlimitedFuel: boolean;
  /** Landing sink rate (m/s) above which a touchdown is a crash; absent: the outcomes' 6 m/s. */
  readonly crashSink?: number;
  /** Landing gear 0 (up) .. 1 (down); 1 for fixed gear and skids. */
  readonly gear: number;
  /** Why it crashed, or null. A crashed airframe no longer moves. */
  readonly crashed: string | null;
  /** The points it stands on (wheels, or points on its skids), in spec order. */
  readonly supports: readonly ContactState[];
  /** Whether any support carries load. */
  readonly onGround: boolean;
  /** Height of the CG above the supports, extended and unloaded (m). */
  readonly gearHeight: number;
  readonly telemetry: T;
  /** Body axis `axis` (0 x forward, 1 y right, 2 z down) in world coordinates. */
  bodyAxis(axis: 0 | 1 | 2, out?: Vec3d): Vec3d;
  /** Height of the CG above the lowest support at the current attitude (m). */
  gearHeightNow(): number;
  /**
   * Places it at world position `pos` with velocity `vel`, body axes from
   * `heading`, `pitch` and `bank` (rad), resting body rates, uncrashed.
   */
  place(
    pos: Readonly<Vec3d>,
    vel: Readonly<Vec3d>,
    heading: number,
    pitch: number,
    bank?: number,
  ): void;
  crash(reason: string): void;
  /** Advances one fixed step (FLIGHT_STEP) with the controls held. */
  step(ctl: Readonly<C>, ground: GroundQuery): void;
  /** Recomputes the attitude, speeds and heights in the telemetry from the state. */
  updateAttitude(ground?: GroundQuery): void;
}
