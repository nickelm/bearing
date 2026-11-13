/**
 * Fly-by-wire control laws in the manner of the F-16's (Free Flight, decision
 * 134). They turn stick and pedal positions into body moments, bounded by the
 * control authority the dynamic pressure allows:
 *
 * - **Pitch.** With the gear up the stick commands load factor (neutral stick
 *   holds 1 g, less the centripetal relief of level flight over the small
 *   planet, so it trims itself for level flight; full aft 9 g, full forward −3 g).
 *   With the gear down (takeoff and landing) it commands pitch rate, gently (5°/s
 *   at full stick), and neutral stick holds the attitude: the gear handle selects
 *   the gains, as in the F-16. A PI rate loop reaches the commanded rate. An
 *   angle-of-attack limiter caps the pitch rate as α nears its limit (about 25°),
 *   and the load-factor command is clamped to +9/−3 g.
 * - **Roll.** Lateral stick commands roll rate, reduced at high α; none on the ground.
 * - **Yaw.** Pedals command sideslip; with pedals neutral the law yaws the
 *   aircraft to keep the sideslip at zero (turn coordination). On the ground the
 *   rudder acts open loop and the nosewheel steers.
 *
 * The rate loops ask for the moment that drives the body rates toward their
 * commands in a fraction of a second; the aircraft model adds damping, weathercock
 * stability and ground contact moments. Deflections are those moments as a
 * fraction of full authority, for the HUD and the animated surfaces.
 */
import type { FlightSpec } from './flightSpec';

/** Stick, pedals and switches: what a pilot or the flight director provides. */
export interface FlightControls {
  /** Stick: + aft (nose up), −1..1. */
  pitch: number;
  /** Stick: + right, −1..1. */
  roll: number;
  /** Pedals: + right, −1..1. */
  yaw: number;
  /** Throttle lever 0..1: 0 idle, MIL_DETENT military, 1 full afterburner. */
  throttle: number;
  /** Toe brakes, 0..1. */
  brakeLeft: number;
  brakeRight: number;
  parkingBrake: boolean;
  /** Gear handle down. */
  gearDown: boolean;
  /** Speedbrake switch out. */
  speedbrake: boolean;
}

/** Throttle lever position of the military detent, and where the afterburner begins. */
export const MIL_DETENT = 0.8;
export const AB_GATE = 0.82;

export function neutralControls(): FlightControls {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    brakeLeft: 0,
    brakeRight: 0,
    parkingBrake: false,
    gearDown: true,
    speedbrake: false,
  };
}

/** What the control laws read from the aircraft each substep (body axes: x forward, y right, z down). */
export interface LawInput {
  /** True airspeed and calibrated airspeed (m/s). */
  tas: number;
  cas: number;
  /** Angle of attack and sideslip (rad). */
  alpha: number;
  beta: number;
  /** Dynamic pressure (Pa). */
  qbar: number;
  /** Body rates (rad/s). */
  p: number;
  q: number;
  r: number;
  /** Load factor along the lift direction (g). */
  load: number;
  /** Gravity along the lift direction (m/s², about −g in level flight). */
  gravityLift: number;
  /** Total body-y acceleration, specific force plus gravity (m/s²). */
  accelY: number;
  /** Surface gravity here (m/s²). */
  g: number;
  /**
   * Centripetal acceleration of level flight over the curved surface, v_h² / r
   * (m/s²). The 1-g reference subtracts it, so neutral stick flies level rather
   * than climbing away from a 1,000 km planet: an automatic pitch trim.
   */
  curvature: number;
  /** Weight on wheels, 0 (airborne) to 1 (fully on the gear). */
  wow: number;
  /** Gear position, 0 (up) to 1 (down): selects the pitch law's gains. */
  gear: number;
  /** Substep (s), for the pitch integrator. */
  dt: number;
  /** ½ρV (kg/(m²·s)), for the damping the laws compensate. */
  halfRhoV: number;
}

export interface LawOutput {
  /** Body moments (N·m). */
  mx: number;
  my: number;
  mz: number;
  /** Deflections −1..1: elevator (+ trailing edge up), aileron (+ right roll), rudder (+ right yaw). */
  elevator: number;
  aileron: number;
  rudder: number;
  /** Commands, for the HUD's debug panel. */
  loadCommand: number;
  pitchRateCommand: number;
  /** Weight of the load-factor law in the pitch command (0: rate command). */
  blend: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * The weight of the load-factor law in the pitch channel (0: pitch-rate command).
 * As in the F-16's flight controls, the gear handle selects the gains: with the
 * gear down (takeoff and landing) the stick commands pitch rate and the laws
 * hold the attitude; as the gear comes up the load-factor law takes over, and
 * also below `blendLow` of calibrated airspeed. Weight on wheels plays no part:
 * blending on it switched laws at the moment of liftoff, with the stick still
 * aft, and whipped the nose up into a tail strike.
 */
export function pitchBlend(spec: FlightSpec, cas: number, gear: number): number {
  return (1 - gear) * smoothstep(spec.controls.blendLow, spec.controls.blendHigh, cas);
}

/** Integrator state of the control laws, kept by the aircraft between substeps. */
export interface LawState {
  /** Integrated pitch-rate error, as a moment (N·m). */
  pitchI: number;
}

/** The load factor the pitch stick commands (g), before the limiters. */
export function loadCommand(spec: FlightSpec, stick: number): number {
  const c = spec.controls;
  const s = clamp(stick, -1, 1);
  return s >= 0 ? 1 + s * (c.maxLoad - 1) : 1 + s * (1 - c.minLoad);
}

export function controlLaws(
  spec: FlightSpec,
  inertia: readonly [number, number, number],
  ctl: Readonly<FlightControls>,
  s: Readonly<LawInput>,
  out: LawOutput,
  state?: LawState,
): LawOutput {
  const c = spec.controls;
  const w = spec.wing;
  const [ixx, iyy, izz] = inertia;
  const [kp, kq, kr] = c.rateGain;
  const authX = s.qbar * w.area * w.span * c.rollAuthority;
  const authY = s.qbar * w.area * w.chord * c.pitchAuthority;
  const authZ = s.qbar * w.area * w.span * c.yawAuthority;
  const flying = s.tas > 20;
  const air = 1 - s.wow;

  // ---- Pitch ----
  const blend = pitchBlend(spec, s.cas, s.gear);
  let nCmd = clamp(loadCommand(spec, ctl.pitch) - s.curvature / s.g, c.minLoad, c.maxLoad);
  const v = Math.max(s.tas, 30);
  // Steady pitch rate for the commanded load factor, plus a load-error term.
  const qLoad = (nCmd * s.g + s.gravityLift) / v + c.loadGain * (nCmd - s.load);
  const qRate = clamp(ctl.pitch, -1, 1) * c.maxPitchRate;
  let qCmd = blend * qLoad + (1 - blend) * qRate;
  if (flying && air > 0.5) {
    qCmd = Math.min(qCmd, c.alphaGain * (c.maxAlpha - s.alpha));
    qCmd = Math.max(qCmd, c.alphaGain * (c.minAlpha - s.alpha));
    // Load-factor limiter on the rate law as well.
    if (s.load > c.maxLoad) qCmd -= c.loadGain * (s.load - c.maxLoad);
    if (s.load < c.minLoad) qCmd += c.loadGain * (c.minLoad - s.load);
  }
  if (blend < 0.5) nCmd = 1 + (qCmd * v) / s.g;
  const dampY = s.halfRhoV * w.area * w.chord * w.chord * 0.5 * spec.aero.cmq * s.q;
  // PI rate loop: the integrator holds the attitude against steady moments (the
  // changes of trim), so the commanded rate is reached rather than approached.
  // Anti-windup: it integrates only in the air and while the demand is inside the
  // authority, and is clamped to it.
  const errQ = qCmd - s.q;
  let pitchI = state ? clamp(state.pitchI, -authY, authY) : 0;
  // Takeoff gains: three times the rate gain with weight on wheels, so the
  // proportional loop overcomes the main gear's nose-down moment during rotation
  // (with the integrator frozen there, a plain gain settled at a third of the
  // commanded rate and the nose came up sluggishly).
  const pd = iyy * kq * (1 + 2 * s.wow) * errQ - dampY;
  if (state) {
    const raw = pd + pitchI;
    const saturated = (raw >= authY && errQ > 0) || (raw <= -authY && errQ < 0);
    if (s.wow > 0.05) {
      // Frozen and bled off with weight on the wheels: the gear's reaction would wind
      // it up and release it all at liftoff.
      pitchI *= Math.max(0, 1 - 4 * s.dt);
    } else if (!saturated) {
      pitchI = clamp(pitchI + iyy * c.rateIntegral * errQ * s.dt, -authY, authY);
    }
    state.pitchI = pitchI;
  }
  const my = clamp(pd + pitchI, -authY, authY);

  // ---- Roll ----
  const alphaFrac = clamp(s.alpha / c.maxAlpha, 0, 1);
  const pCmd = clamp(ctl.roll, -1, 1) * c.maxRollRate * (1 - 0.5 * alphaFrac) * air;
  // The laws cancel the airframe's own roll damping, so the rate reaches its command.
  const a = spec.aero;
  const dampX = s.halfRhoV * w.area * w.span * w.span * 0.5 * a.clp * s.p;
  const mx = clamp(ixx * kp * (pCmd - s.p) - dampX, -authX, authX);

  // ---- Yaw ----
  let mz = clamp(ctl.yaw, -1, 1) * authZ * s.wow;
  if (flying) {
    const betaCmd = -clamp(ctl.yaw, -1, 1) * c.maxSideslip;
    const ca = Math.max(0.3, Math.cos(s.alpha));
    const rCmd =
      (s.accelY / v + s.p * Math.sin(s.alpha) + c.sideslipGain * (s.beta - betaCmd)) / ca;
    mz += air * izz * kr * (rCmd - s.r);
  }
  mz = clamp(mz, -authZ, authZ);

  const defl = (m: number, auth: number, stick: number) =>
    auth > 1 ? clamp(m / auth, -1, 1) : clamp(stick, -1, 1);
  out.mx = mx;
  out.my = my;
  out.mz = mz;
  out.elevator = defl(my, authY, ctl.pitch);
  out.aileron = defl(mx, authX, ctl.roll);
  out.rudder = defl(mz, authZ, ctl.yaw);
  out.loadCommand = nCmd;
  out.pitchRateCommand = qCmd;
  out.blend = blend;
  return out;
}

export function emptyLawOutput(): LawOutput {
  return {
    mx: 0,
    my: 0,
    mz: 0,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    loadCommand: 1,
    pitchRateCommand: 0,
    blend: 0,
  };
}
