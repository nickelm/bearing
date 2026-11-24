/**
 * The table-driven flight model (Free Flight, decision 134; Proposal 0002,
 * Flight Model; P1 extends it). One model for every pilot: the player's inputs
 * and the flight director's both arrive as `FlightControls`.
 *
 * - **State.** Position and velocity in float64 planet-centered meters (CLAUDE.md
 *   rule 3), a body-to-world quaternion, body rates (x forward, y right, z down).
 *   The planet does not rotate.
 * - **Time.** `step()` advances one fixed step of 1/120 s in four substeps,
 *   whatever the frame rate; the same inputs give the same states (no clock,
 *   no randomness).
 * - **Forces.** Gravity along the local radial, g₀·(R/r)². Thrust from idle,
 *   military and afterburner tables over altitude and Mach, with spool lags.
 *   Lift from CL(α) with its stall break (flaps follow the gear handle), drag
 *   CD0(Mach) + k·CL² + CDsep(α) + increments for gear, flaps, speedbrake (by
 *   deflection) and stores (decision 207), side force from sideslip, and
 *   ground effect within a span of the ground; the air from the standard
 *   atmosphere. The air may move: airspeed, angle of attack and sideslip are
 *   taken relative to `wind` (still air unless the owner sets it; wind.ts).
 * - **Moments.** The control laws (controlLaws.ts) within their authority,
 *   damping and weathercock stability, the speedbrake's pitch-up (the pitch law's
 *   integrator holds it), gyroscopic coupling, and the wheels.
 * - **Systems.** Gear and speedbrake move at their rates; the speedbrake opens to
 *   60°, or 43° with the gear handle down. The gear moves at any speed; flown more
 *   than 20 kt over its limit with it out, the doors fail (decision 207).
 * - **Ground.** Three wheels as spring-dampers along the local vertical. Each
 *   tire holds the ground with a stiff grip spring capped by friction (a bristle
 *   model): braked or sideways it sticks until the friction limit and then
 *   slides, so a braked aircraft rests without creeping. Unbraked wheels roll
 *   with rolling resistance; differential braking; nosewheel steering fades
 *   with speed, and with the pedals let go it holds the ground track with the
 *   rudder (controlLaws.ts, `trackHold`). Hard points on the airframe (nose,
 *   tail, wingtips, belly, fin) touching the ground crash the aircraft, as does
 *   a wheel on water.
 */
import { Quatd } from '../../core/quat';
import { Vec3d } from '../../core/vec3d';
import type { Airframe, AirframeTelemetry } from './airframe';
import { calibratedAirspeed, standardAtmosphere } from './atmosphere';
import { hardPointHit, ON_WATER, release, smooth01, supportHeight, wheelForce } from './contact';
import type { GroundQuery, WheelContact } from './contact';
import {
  AB_GATE,
  controlLaws,
  emptyLawOutput,
  MIL_DETENT,
  neutralControls,
  newLawState,
  pitchBlend,
} from './controlLaws';
import type { FlightControls, LawInput, LawOutput, LawState } from './controlLaws';
import { dragCoefficient, emptyDrag, speedbrakeShare } from './drag';
import type { DragBreakdown, DragState } from './drag';
import { lookup, lookup2 } from './flightSpec';
import type { FlightSpec, WheelSpec } from './flightSpec';
import {
  airVelocityBody,
  attitudeQuat,
  attitudeTelemetry,
  bodyAxisOf,
  eulerRates,
  FLIGHT_STEP,
  gravityAt,
  integrate,
  modelToBody,
  SUBSTEPS,
} from './rigidBody';

export type { GroundQuery, SurfaceKind } from './contact';
export { FLIGHT_STEP, modelToBody, SUBSTEPS } from './rigidBody';
export type { DragBreakdown } from './drag';

/** Time constants of the stick prefilter (s). */
const PITCH_PREFILTER = 0.25;
/** With the gear down (pitch-rate command), a quick prefilter: letting go stops the rotation. */
const PITCH_PREFILTER_GEAR = 0.08;
const ROLL_PREFILTER = 0.08;
/** Time constant (s) of the airspeed trend's filter. */
const CAS_RATE_TAU = 1;

/** A wheel: its spec, and its contact with the ground (contact.ts). */
export interface WheelState extends WheelContact {
  readonly spec: WheelSpec;
}

/** Per-substep quantities for the HUD and the debug panel: the common ones, and the jet's. */
export interface FlightTelemetry extends AirframeTelemetry {
  /** The drag coefficient's terms (they sum to `cd`). */
  drag: DragBreakdown;
  /**
   * Rate of change of the calibrated airspeed (m/s², + accelerating), low-passed over
   * CAS_RATE_TAU: the HUD's speed trend (decision 207). Telemetry only; the flight never reads it.
   */
  casRate: number;
  /** Lift and drag coefficients, and the engine's thrust (N). */
  cl: number;
  cd: number;
  thrust: number;
  laws: LawOutput;
  /** What the control laws read last substep (the flight director inverts the pitch law with it). */
  lawInput: LawInput | null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export class FlightModel implements Airframe<FlightControls, FlightTelemetry> {
  readonly kind = 'fixed-wing' as const;
  readonly spec: FlightSpec;
  readonly radius: number;
  // ---- State ----
  readonly pos = new Vec3d();
  readonly vel = new Vec3d();
  readonly q = new Quatd();
  /** Body rates p, q, r (rad/s). */
  readonly omega = new Vec3d();
  /**
   * Velocity of the air at the aircraft (world frame, m/s), set by the owner
   * before a step (wind.ts gives it from the weather). Still air by default.
   */
  readonly wind = new Vec3d();
  /** Engine core 0 (idle) .. 1 (military), and afterburner 0..1. */
  power = 0;
  afterburner = 0;
  /** Fuel aboard (kg): internal plus what the drop tanks hold (`tankFuel`). */
  fuel: number;
  /**
   * The part of `fuel` in drop tanks (kg), burned first (decision 287); 0 without tanks.
   * Jettisoning the tanks takes it off `fuel`.
   */
  tankFuel = 0;
  /**
   * Stores beyond the flight data's standard load (decision 287): their mass without the
   * tanks' fuel (kg; negative when fewer than the standard load hang) and their drag area
   * (m²). The stores rack sets them (storesRack.ts); zero leaves the aircraft as its spec.
   */
  storesMass = 0;
  storesDragArea = 0;
  /**
   * The gun's recoil (N) along the nose, backward, while it fires (decision 339): the stores
   * rack sets it from the gun's rate, rounds and muzzle velocity; zero otherwise.
   */
  recoil = 0;
  /** Gear 0 (up) .. 1 (down); speedbrake 0 (in) .. 1 (out to `spec.speedbrake.maxDeflection`). */
  gear = 1;
  speedbrake = 0;
  /** The gear handle as last commanded (down: true), for the warnings. */
  gearHandleDown = true;
  /**
   * Gear doors damaged by an overspeed (decision 207): the gear stays down whatever the
   * handle, with extra drag, until the aircraft is placed anew.
   */
  gearDamaged = false;
  /** Seconds flown beyond the gear's damage speed with it out. */
  gearOverspeedTime = 0;
  /** The last substep's calibrated airspeed, for the trend (null after a placement). */
  private lastCas: number | null = null;
  /** Game seconds flown. */
  time = 0;
  unlimitedFuel = true;
  /** Why the aircraft crashed, or null. A crashed aircraft no longer moves. */
  crashed: string | null = null;
  readonly wheels: WheelState[];
  readonly contacts: Vec3d[];
  readonly telemetry: FlightTelemetry;

  private readonly inertia: [number, number, number];
  /** Prefiltered stick, and the controls the laws see. */
  private readonly stick = { pitch: 0, roll: 0 };
  /** The control laws' integrators. */
  readonly lawState: LawState = newLawState();
  private readonly shaped: FlightControls = neutralControls();
  private readonly scratch = {
    up: new Vec3d(),
    vb: new Vec3d(),
    fb: new Vec3d(),
    mb: new Vec3d(),
    fw: new Vec3d(),
    a: new Vec3d(),
    b: new Vec3d(),
    c: new Vec3d(),
    d: new Vec3d(),
    f: new Vec3d(),
    l: new Vec3d(),
    w: new Vec3d(),
    e: new Vec3d(),
    drag: {
      cl: 0,
      alpha: 0,
      mach: 0,
      gear: 0,
      flaps: 0,
      gearDamaged: false,
      speedbrake: 0,
      groundEffect: 0,
      storesArea: 0,
    } as DragState,
  };

  constructor(spec: FlightSpec, radius: number) {
    this.spec = spec;
    this.radius = radius;
    this.fuel = spec.mass.fuel;
    this.inertia = [...spec.inertia];
    this.wheels = spec.gear.wheels.map((w) => ({
      spec: w,
      body: modelToBody(w.at, spec.cg),
      compression: 0,
      load: 0,
      anchor: null,
      steer: 0,
      surface: null,
    }));
    this.contacts = spec.contacts.map((p) => modelToBody(p, spec.cg));
    this.telemetry = {
      alpha: 0,
      beta: 0,
      tas: 0,
      cas: 0,
      mach: 0,
      qbar: 0,
      cl: 0,
      cd: 0,
      thrust: 0,
      drag: emptyDrag(),
      casRate: 0,
      load: 1,
      normalLoad: 1,
      altitude: 0,
      verticalSpeed: 0,
      radarAltitude: 0,
      groundSpeed: 0,
      heading: 0,
      pitch: 0,
      bank: 0,
      gamma: 0,
      aero: new Vec3d(),
      gearForce: new Vec3d(),
      gravity: new Vec3d(),
      wow: 0,
      fuelFlow: 0,
      air: standardAtmosphere(0),
      laws: emptyLawOutput(),
      lawInput: null,
    };
  }

  get mass(): number {
    const m = this.spec.mass;
    return m.empty + m.payload + this.fuel + this.storesMass;
  }

  /** The wheels, as the points the aircraft stands on (Airframe). */
  get supports(): readonly WheelState[] {
    return this.wheels;
  }

  /** Whether any wheel carries load. */
  get onGround(): boolean {
    return this.wheels.some((w) => w.load > 0);
  }

  /** Height of the CG above the tire bottoms with the gear extended and unloaded (m). */
  get gearHeight(): number {
    return Math.max(...this.wheels.map((w) => w.body.z));
  }

  /** Body axis `axis` (0 x forward, 1 y right, 2 z down) in world coordinates. */
  bodyAxis(axis: 0 | 1 | 2, out = new Vec3d()): Vec3d {
    return bodyAxisOf(this.q, axis, this.scratch.d, out);
  }

  /**
   * Places the aircraft at world position `pos` with velocity `vel` and body
   * axes from `heading` (rad), `pitch` and `bank`, resting body rates.
   */
  place(pos: Readonly<Vec3d>, vel: Readonly<Vec3d>, heading: number, pitch: number, bank = 0) {
    this.pos.copy(pos);
    this.vel.copy(vel);
    attitudeQuat(pos, heading, pitch, bank, this.q);
    this.omega.set(0, 0, 0);
    this.crashed = null;
    this.gearDamaged = false;
    this.gearOverspeedTime = 0;
    this.lastCas = null;
    this.telemetry.casRate = 0;
    this.stick.pitch = 0;
    this.stick.roll = 0;
    Object.assign(this.lawState, newLawState());
    this.telemetry.laws.steer = 0;
    for (const w of this.wheels) {
      w.anchor = null;
      w.load = 0;
      w.compression = 0;
      w.surface = null;
    }
  }

  crash(reason: string): void {
    if (this.crashed) return;
    this.crashed = reason;
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
  }

  /** The speedbrake's deflection (rad). */
  get speedbrakeDeflection(): number {
    return this.speedbrake * this.spec.speedbrake.maxDeflection;
  }

  /** The highest calibrated airspeed (m/s) for the gear as it is moving or resting: extension or retraction. */
  get gearSpeedLimit(): number {
    const g = this.spec.gear;
    return this.gearHandleDown || this.gearDamaged ? g.maxSpeed : g.retractSpeed;
  }

  /** Advances one fixed step (FLIGHT_STEP) with the controls held. */
  step(ctl: Readonly<FlightControls>, ground: GroundQuery): void {
    if (this.crashed) return;
    const h = FLIGHT_STEP / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS && !this.crashed; i++) this.substep(ctl, ground, h);
    this.updateAttitude(ground);
  }

  private substep(ctl: Readonly<FlightControls>, ground: GroundQuery, dt: number): void {
    const spec = this.spec;
    const sc = this.scratch;
    const tel = this.telemetry;
    const R = this.radius;
    const r = this.pos.length();
    const up = sc.up.copy(this.pos).scale(1 / r);
    const altitude = r - R;
    const air = standardAtmosphere(altitude, tel.air);
    const g = gravityAt(R, r);
    const m = this.mass;

    // ---- Systems ----
    // The gear moves at any speed (decision 207); flown well over its limit with the gear
    // out, the doors fail and the gear stays down.
    this.gearHandleDown = ctl.gearDown;
    const gs = spec.gear;
    if (this.gear > 0.01 && tel.cas > this.gearSpeedLimit + gs.damageMargin)
      this.gearOverspeedTime += dt;
    else this.gearOverspeedTime = 0;
    if (this.gearOverspeedTime > gs.damageTime) this.gearDamaged = true;
    const gearTarget = ctl.gearDown || this.gearDamaged ? 1 : 0;
    this.gear += clamp(gearTarget - this.gear, -dt / gs.transit, dt / gs.transit);
    // The speedbrake opens to its full deflection, or to the gear-down limit with the handle down.
    const sbs = spec.speedbrake;
    const sbOpen = ctl.gearDown ? sbs.gearDownDeflection / sbs.maxDeflection : 1;
    const sbTarget = ctl.speedbrake ? sbOpen : 0;
    this.speedbrake += clamp(sbTarget - this.speedbrake, -dt / sbs.transit, dt / sbs.transit);
    const lever = clamp(ctl.throttle, 0, 1);
    const hasFuel = this.fuel > 0 || this.unlimitedFuel;
    const dryCmd = hasFuel ? Math.min(1, lever / MIL_DETENT) : 0;
    const eng = spec.engine;
    // An engine without an afterburner (the Vo-35's) stops at military power.
    const abCmd =
      hasFuel && lever >= AB_GATE && eng.thrust.afterburner
        ? 0.2 + (0.8 * (lever - AB_GATE)) / (1 - AB_GATE)
        : 0;
    const tau = dryCmd > this.power ? eng.spoolUp : eng.spoolDown;
    this.power += (dryCmd - this.power) * Math.min(1, dt / tau);
    const abTarget = this.power > 0.95 ? abCmd : 0;
    this.afterburner += (abTarget - this.afterburner) * Math.min(1, dt / eng.afterburner);

    // ---- Air data ----
    const vb = airVelocityBody(this, sc.w, sc.vb);
    const tas = vb.length();
    const mach = tas / air.speedOfSound;
    const qbar = 0.5 * air.density * tas * tas;
    let alpha = 0;
    let beta = 0;
    if (tas > 0.5) {
      alpha = Math.atan2(vb.z, vb.x);
      beta = Math.asin(clamp(vb.y / tas, -1, 1));
    }
    // What the air-data probes sense. They face forward: on the wheels with the air coming
    // from behind (a tailwind while standing or rolling slowly, wind.ts) they read no airspeed
    // and no angles, and the laws and the HUD get none, while the forces below use the real
    // flow. In the air the laws keep the real angles: in a tail slide it is the angle-of-attack
    // limiter that turns the nose back into the flow. Air slower than the 0.5 m/s under which
    // there are no angles anyway is sensed as it is: an aircraft settling on its wheels in
    // still air rocks back by micrometers per second.
    const ahead = vb.x > 0 || !this.onGround || tas <= 0.5;
    const cas = ahead ? calibratedAirspeed(tas, air) : 0;
    const sensedAlpha = ahead ? alpha : 0;
    const sensedBeta = ahead ? beta : 0;

    // ---- Aerodynamic forces (body axes) ----
    const a = spec.aero;
    const S = spec.wing.area;
    const flaps = this.gear;
    const clBase =
      Math.abs(alpha) <= Math.PI / 2
        ? lookup(a.cl, alpha)
        : -lookup(a.cl, Math.sign(alpha) * Math.PI - alpha);
    const flapFade = 1 - smooth01((Math.abs(alpha) - a.flapFadeAlpha + 0.1) / 0.2);
    // Ground effect from the height of the CG over the ground (one query per substep).
    const groundUnder = ground.height(up);
    const ge = Math.exp((-2.5 * Math.max(0, altitude - groundUnder)) / spec.wing.span);
    const cl = (clBase + a.flapCl * flaps * flapFade) * (1 + a.groundEffectLift * ge);
    const sbShare = speedbrakeShare(spec, this.speedbrakeDeflection);
    const ds = sc.drag;
    ds.cl = cl;
    ds.alpha = alpha;
    ds.mach = mach;
    ds.gear = this.gear;
    ds.flaps = flaps;
    ds.gearDamaged = this.gearDamaged;
    ds.speedbrake = sbShare;
    ds.groundEffect = ge;
    ds.storesArea = this.storesDragArea;
    const cd = dragCoefficient(spec, ds, tel.drag);
    const fb = sc.fb.set(0, 0, 0);
    let liftX = 0;
    let liftZ = 0;
    if (tas > 0.5) {
      const vx = vb.x / tas;
      const vy = vb.y / tas;
      const vz = vb.z / tas;
      // Lift ⊥ velocity in the body's x–z plane: y × v̂.
      const ln = Math.hypot(vx, vz);
      if (ln > 1e-6) {
        liftX = vz / ln;
        liftZ = -vx / ln;
      }
      const L = qbar * S * cl;
      const D = qbar * S * cd;
      const Y = qbar * S * a.cyBeta * beta;
      fb.set(-D * vx + L * liftX, -D * vy, -D * vz + L * liftZ);
      // Side force along y with its velocity component removed.
      fb.x += Y * -vy * vx;
      fb.y += Y * (1 - vy * vy);
      fb.z += Y * -vy * vz;
    }
    tel.aero.copy(fb);

    // ---- Thrust ----
    const th = eng.thrust;
    const idle = lookup2(th.altitude, th.mach, th.idle, altitude, mach);
    const mil = lookup2(th.altitude, th.mach, th.military, altitude, mach);
    const wet = th.afterburner
      ? lookup2(th.altitude, th.mach, th.afterburner, altitude, mach)
      : mil;
    const thrust = hasFuel ? idle + (mil - idle) * this.power + (wet - mil) * this.afterburner : 0;
    fb.x += thrust;
    if (this.recoil > 0) fb.x -= this.recoil;
    const wetShare = Math.min(1, this.afterburner * 5);
    // Net idle thrust goes negative at speed (ram drag): no fuel comes back.
    const fuelFlow = Math.max(0, thrust) * (eng.tsfcDry * (1 - wetShare) + eng.tsfcWet * wetShare);
    if (!this.unlimitedFuel) {
      // The tanks feed first (decision 287); their fuel is part of `fuel`.
      this.fuel = Math.max(0, this.fuel - fuelFlow * dt);
      if (this.tankFuel > 0) this.tankFuel = Math.max(0, this.tankFuel - fuelFlow * dt);
    }

    // ---- Gravity (body) ----
    const gw = sc.a.copy(up).scale(-g * m);
    const gb = this.q.unrotate(gw, sc.b);
    tel.gravity.copy(gb);

    // ---- Wheels (world forces, body moments) ----
    const fwWorld = sc.fw.set(0, 0, 0);
    const mb = sc.mb.set(0, 0, 0);
    let totalLoad = 0;
    const gearDown = this.gear >= 0.999;
    // Nosewheel steering: full at taxi speed, a few degrees above `steerFade`, and
    // none by `steerOff`, where a pedal tap at takeoff speed would roll the jet onto
    // a wingtip.
    const steerGain =
      tas <= gs.steerFade
        ? gs.steerHigh + (gs.steerLow - gs.steerHigh) * (1 - tas / gs.steerFade)
        : gs.steerHigh * Math.max(0, 1 - (tas - gs.steerFade) / (gs.steerOff - gs.steerFade));
    // Plus what the laws' track hold asked for in the last substep (nothing with a pedal in).
    const holdSteer = tel.laws.steer;
    const pedalSteer = clamp(ctl.yaw, -1, 1) * steerGain;
    const steerAngle = holdSteer !== 0 ? pedalSteer + holdSteer : pedalSteer;
    // Wheels and hard points only near the ground (one query otherwise).
    const low = altitude - groundUnder < 40;
    for (const w of this.wheels) {
      if (!gearDown || !low) {
        release(w);
        continue;
      }
      w.steer = w.spec.steerable ? steerAngle : 0;
      // Toe brakes on the main wheels, or the parking brake.
      let brake = 0;
      if (w.spec.braked) {
        brake = ctl.parkingBrake
          ? 1
          : clamp(w.spec.name === 'left' ? ctl.brakeLeft : ctl.brakeRight, 0, 1);
      }
      const load = wheelForce(this, w, w.spec, gs, brake, ground, up, fwWorld, mb);
      if (load === ON_WATER) {
        this.crash('Ditched in the water');
        return;
      }
      totalLoad += load;
    }
    const wow = clamp(totalLoad / (0.25 * m * g), 0, 1);
    if (low) this.contactCheck(ground);
    if (this.crashed) return;

    // ---- Specific force and load factor ----
    const gearB = this.q.unrotate(fwWorld, sc.c);
    tel.gearForce.copy(gearB);
    const sfx = (fb.x + gearB.x) / m;
    const sfy = (fb.y + gearB.y) / m;
    const sfz = (fb.z + gearB.z) / m;
    const load = (sfx * liftX + sfz * liftZ) / g;

    // ---- Control laws ----
    // The ground track against the nose, for the track hold on the wheels.
    const vg = this.q.unrotate(this.vel, sc.w);
    const forward = vg.x;
    const lawIn: LawInput = {
      tas,
      cas,
      alpha: sensedAlpha,
      beta: sensedBeta,
      qbar,
      p: this.omega.x,
      q: this.omega.y,
      r: this.omega.z,
      load: tas > 0.5 && ahead ? load : 1,
      gravityLift: (gb.x * liftX + gb.z * liftZ) / m,
      accelY: sfy + gb.y / m,
      g,
      wow,
      curvature: Math.max(0, this.vel.lengthSq() - this.vel.dot(up) ** 2) / r,
      halfRhoV: 0.5 * air.density * tas,
      gear: this.gear,
      dt,
      bank: tel.bank,
      pitch: tel.pitch,
      radarAltitude: tel.radarAltitude,
      forward,
      drift: forward > 2 ? Math.atan2(vg.y, forward) : 0,
    };
    tel.lawInput = lawIn;
    // Stick prefilter (as in the F-16's FCS): shapes the command's onset.
    const pitchTau =
      PITCH_PREFILTER_GEAR +
      (PITCH_PREFILTER - PITCH_PREFILTER_GEAR) * pitchBlend(spec, cas, this.gear);
    this.stick.pitch += (clamp(ctl.pitch, -1, 1) - this.stick.pitch) * Math.min(1, dt / pitchTau);
    this.stick.roll +=
      (clamp(ctl.roll, -1, 1) - this.stick.roll) * Math.min(1, dt / ROLL_PREFILTER);
    this.shaped.pitch = this.stick.pitch;
    this.shaped.roll = this.stick.roll;
    this.shaped.yaw = ctl.yaw;
    const laws = controlLaws(spec, this.inertia, this.shaped, lawIn, tel.laws, this.lawState);

    // ---- Moments ----
    const b = spec.wing.span;
    const c = spec.wing.chord;
    const halfRhoV = 0.5 * air.density * tas;
    const mx = laws.mx + mb.x + halfRhoV * S * b * b * 0.5 * a.clp * this.omega.x;
    const my =
      laws.my +
      mb.y +
      halfRhoV * S * c * c * 0.5 * a.cmq * this.omega.y +
      qbar * S * c * a.cmSpeedbrake * sbShare;
    const mz =
      laws.mz +
      mb.z +
      halfRhoV * S * b * b * 0.5 * a.cnr * this.omega.z +
      qbar * S * b * a.cnBeta * beta;
    const rates = eulerRates(this.inertia, this.omega, mx, my, mz, sc.e);

    // ---- Integrate (semi-implicit Euler) ----
    const fWorld = this.q.rotate(fb, sc.d).add(fwWorld).add(gw);
    integrate(this, fWorld, m, rates, dt);

    // ---- Telemetry ----
    tel.alpha = sensedAlpha;
    tel.beta = sensedBeta;
    tel.tas = tas;
    tel.cas = cas;
    if (this.lastCas !== null)
      tel.casRate += ((cas - this.lastCas) / dt - tel.casRate) * Math.min(1, dt / CAS_RATE_TAU);
    this.lastCas = cas;
    // Sensed, like the airspeed: no Mach number beside an airspeed of zero in a tailwind.
    tel.mach = ahead ? mach : 0;
    tel.qbar = qbar;
    tel.cl = cl;
    tel.cd = cd;
    tel.thrust = thrust;
    tel.load = tas > 0.5 && ahead ? load : 1;
    tel.normalLoad = -sfz / g;
    tel.altitude = altitude;
    tel.wow = wow;
    tel.fuelFlow = fuelFlow;
    this.updateAttitude();
  }

  /** Recomputes the attitude, speeds and heights in the telemetry from the state. */
  updateAttitude(ground?: GroundQuery): void {
    const tel = this.telemetry;
    const up = attitudeTelemetry(this, tel, this.scratch.d);
    if (ground) {
      tel.radarAltitude = tel.altitude - this.gearHeightNow() - ground.height(up);
    }
  }

  /** Height of the CG above the lowest wheel bottom, at the current attitude (m). */
  gearHeightNow(): number {
    return supportHeight(this, this.wheels);
  }

  /** Crashes the aircraft if a hard point is below the ground. */
  private contactCheck(ground: GroundQuery): void {
    const hit = hardPointHit(this, this.contacts, ground);
    if (!hit) return;
    this.crash(
      hit.surface === 'water'
        ? 'Ditched in the water'
        : this.gear < 0.999 && this.contacts[hit.index]!.z > 0
          ? 'Landed with the gear up'
          : 'Struck the ground',
    );
  }
}
