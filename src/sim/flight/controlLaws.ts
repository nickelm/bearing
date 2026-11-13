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
  /** Bank angle (rad, + right wing down), for the rate law's turn compensation. */
  bank: number;
  /** Pitch attitude (rad), so derotation after landing stops at the ground attitude. */
  pitch: number;
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

/** State of the control laws, kept by the aircraft between substeps. */
export interface LawState {
  /** Integrated pitch-rate error, as a moment (N·m). */
  pitchI: number;
  /** Seconds since the wheels last carried weight (0 on the ground). */
  airborne: number;
  /** True from a touchdown after flight until the wheels leave the ground again. */
  landed: boolean;
}

export function newLawState(): LawState {
  return { pitchI: 0, airborne: 0, landed: false };
}

/** Largest pitch rate (rad/s) the rate law's load-factor hold adds or takes away. */
const HOLD_LIMIT = 4 * (Math.PI / 180);

/** The pitch command and how it was made. */
export interface PitchCommand {
  /** Commanded pitch rate (rad/s). */
  q: number;
  /** Commanded load factor (g), for the HUD's debug panel. */
  n: number;
  /** Weight of the load-factor law (0: rate command). */
  blend: number;
}

/**
 * The pitch-rate command for a stick position, shared by the control laws and
 * the flight director, which inverts it to fly a desired path (decision 136).
 *
 * - **Rate law** (gear down, or slow): the stick commands pitch rate. On the
 *   ground the most it asks is `groundPitchRate` (5°/s), a gentle rotation; in the
 *   air that grows to `maxPitchRate` over a few seconds after liftoff, so a stick
 *   still held aft at liftoff does not whip the nose up. In the air it adds the
 *   pitch rate of a level turn at the present bank and, from 6–12 s after liftoff,
 *   a load-factor hold on the commanded path, so neutral stick holds a turn in
 *   the pattern instead of sinking, while just after liftoff it holds the
 *   attitude the pilot rotated to. After a landing, neutral stick lowers the nose
 *   at `derotationRate` onto the nosewheel.
 * - **Load-factor law** (gear up): the stick commands load factor.
 * - **The handover** as the gear moves: the load law's steady part is weighted
 *   by the blend and its error term by the blend squared, so the first percent
 *   of gear travel does not hand the stick a 9 g loop gain.
 * - **Limiters:** angle of attack and load factor, in the air.
 */
export function pitchCommand(
  spec: FlightSpec,
  stick: number,
  s: Readonly<LawInput>,
  state: Readonly<LawState> | null,
): PitchCommand {
  const c = spec.controls;
  const st = clamp(stick, -1, 1);
  const blend = pitchBlend(spec, s.cas, s.gear);
  const v = Math.max(s.tas, 30);
  const air = 1 - s.wow;
  const nStick = clamp(loadCommand(spec, st) - s.curvature / s.g, c.minLoad, c.maxLoad);
  const steady = (nStick * s.g + s.gravityLift) / v;
  const loadTerm = c.loadGain * (nStick - s.load);
  // Rate law: gentle on the ground, the full rate a few seconds after liftoff.
  const airborne = state ? state.airborne : air > 0.95 ? 10 : 0;
  const fade = smoothstep(1, 4, airborne);
  const maxRate = c.groundPitchRate + (c.maxPitchRate - c.groundPitchRate) * fade;
  let qRate = st * maxRate;
  if (air > 0) {
    // In the air: the pitch rate of a level turn at this bank, and a load-factor
    // hold on the path the stick asks for (cos γ / cos(bank), plus the stick's rate
    // as load), as the F-16's landing gains hold 1 g.
    const bank = clamp(Math.abs(s.bank), 0, 70 * (Math.PI / 180));
    const cb = Math.cos(bank);
    const stickRate = qRate;
    qRate += air * (s.g / v) * (1 / cb - cb);
    // The path's load factor: cos γ / cos(bank), from gravity along the lift
    // direction (−g cos γ cos(bank)), so a climb or a turn is held, not pulled into.
    const nPath = -s.gravityLift / (s.g * cb * cb);
    const nRef = nPath - s.curvature / s.g + (stickRate * v) / s.g;
    const hold = clamp(c.loadGain * (nRef - s.load), -HOLD_LIMIT, HOLD_LIMIT);
    // The hold comes in 6–12 s after liftoff: until then the rate law holds the
    // attitude the pilot rotated to, as a takeoff wants; in a landing pattern, long
    // after liftoff, it holds the path in turns.
    qRate += air * smoothstep(6, 12, airborne) * hold;
  }
  if (state?.landed && s.wow > 0.3 && Math.abs(st) < 0.1 && s.pitch > 1 * (Math.PI / 180))
    qRate = -c.derotationRate;
  let q = blend * steady + blend * blend * loadTerm + (1 - blend) * qRate;
  if (s.tas > 20 && air > 0.5) {
    q = Math.min(q, c.alphaGain * (c.maxAlpha - s.alpha));
    q = Math.max(q, c.alphaGain * (c.minAlpha - s.alpha));
    if (s.load > c.maxLoad) q -= c.loadGain * (s.load - c.maxLoad);
    if (s.load < c.minLoad) q += c.loadGain * (c.minLoad - s.load);
  }
  const n = blend < 0.5 ? 1 + (q * v) / s.g : nStick;
  return { q, n, blend };
}

/** The load factor the pitch stick commands (g), before the limiters. */
/**
 * The load factor the pitch stick commands (g), before the limiters. The stick is
 * shaped as on the F-16, gentle near center: s·(0.3 + 0.7|s|), so a fifth of the
 * travel asks for 1.7 g rather than 2.6 g, and full travel still for 9 g.
 */
export function loadCommand(spec: FlightSpec, stick: number): number {
  const c = spec.controls;
  const s0 = clamp(stick, -1, 1);
  const s = s0 * (0.3 + 0.7 * Math.abs(s0));
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
  if (state) {
    // Liftoff and touchdown, for the rate law's schedule.
    if (s.wow > 0.05) {
      if (state.airborne > 2) state.landed = true;
      state.airborne = 0;
    } else {
      state.airborne += s.dt;
      if (state.airborne > 0.5) state.landed = false;
    }
  }
  const pitch = pitchCommand(spec, ctl.pitch, s, state ?? null);
  const qCmd = pitch.q;
  const nCmd = pitch.n;
  const blend = pitch.blend;
  const v = Math.max(s.tas, 30);
  const dampY = s.halfRhoV * w.area * w.chord * w.chord * 0.5 * spec.aero.cmq * s.q;
  // PI rate loop: the integrator holds the attitude against steady moments (the
  // changes of trim), so the commanded rate is reached rather than approached.
  // Anti-windup: it integrates only in the air and while the demand is inside the
  // authority, and is clamped to it.
  const errQ = qCmd - s.q;
  let pitchI = state ? clamp(state.pitchI, -authY, authY) : 0;
  // Takeoff gains: a higher rate gain with weight on wheels, so the proportional
  // loop overcomes the main gear's nose-down moment during rotation (with the
  // integrator frozen there, a plain gain settled well short of the commanded rate
  // and the nose came up sluggishly).
  const pd = iyy * kq * (1 + (c.groundGain - 1) * s.wow) * errQ - dampY;
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
