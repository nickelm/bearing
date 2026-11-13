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
 *   from CD0(Mach) with its transonic rise, induced and separated-flow drag and
 *   increments for gear, flaps and speedbrake, side force from sideslip, and
 *   ground effect within a span of the ground; the air from the standard
 *   atmosphere.
 * - **Moments.** The control laws (controlLaws.ts) within their authority,
 *   damping and weathercock stability, gyroscopic coupling, and the wheels.
 * - **Ground.** Three wheels as spring-dampers along the local vertical. Each
 *   tire holds the ground with a stiff grip spring capped by friction (a bristle
 *   model): braked or sideways it sticks until the friction limit and then
 *   slides, so a braked aircraft rests without creeping. Unbraked wheels roll
 *   with rolling resistance; differential braking; nosewheel steering fades
 *   with speed. Hard points on the airframe (nose, tail, wingtips, belly, fin)
 *   touching the ground crash the aircraft, as does a wheel on water.
 */
import { Quatd } from '../../core/quat';
import { Vec3d } from '../../core/vec3d';
import { calibratedAirspeed, G0, standardAtmosphere } from './atmosphere';
import type { AirState } from './atmosphere';
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
import { lookup, lookup2 } from './flightSpec';
import type { FlightSpec, WheelSpec } from './flightSpec';
import { headingOf } from './runway';

/** Fixed step of the flight model (s) and its substeps. */
export const FLIGHT_STEP = 1 / 120;
export const SUBSTEPS = 4;
/** Time constants of the stick prefilter (s). */
const PITCH_PREFILTER = 0.25;
/** With the gear down (pitch-rate command), a quick prefilter: letting go stops the rotation. */
const PITCH_PREFILTER_GEAR = 0.08;
const ROLL_PREFILTER = 0.08;

export type SurfaceKind = 'runway' | 'field' | 'land' | 'water';

/** The ground the aircraft flies over: the same surface the renderer draws. */
export interface GroundQuery {
  /** Surface height (m above sea level; water at its surface) at a unit direction. */
  height(dir: Readonly<Vec3d>): number;
  /** What the surface is at a unit direction. */
  surface(dir: Readonly<Vec3d>): SurfaceKind;
}

export interface WheelState {
  readonly spec: WheelSpec;
  /** Attachment (tire bottom, strut extended) relative to the CG, body axes. */
  readonly body: Vec3d;
  /** Strut compression (m) and normal load (N). */
  compression: number;
  load: number;
  /** The grip spring's anchor on the ground (world), or null in the air. */
  anchor: Vec3d | null;
  /** Steering angle (rad, + right). */
  steer: number;
  /** Surface under the tire while it is loaded. */
  surface: SurfaceKind | null;
}

/** Per-substep quantities for the HUD and the debug panel. */
export interface FlightTelemetry {
  alpha: number;
  beta: number;
  tas: number;
  cas: number;
  mach: number;
  qbar: number;
  cl: number;
  cd: number;
  thrust: number;
  /** Load factor along the lift direction (g) and along body −z (g). */
  load: number;
  normalLoad: number;
  /** Altitude above sea level (m) and vertical speed (m/s, + up). */
  altitude: number;
  verticalSpeed: number;
  /** Height of the lowest wheel above the ground under the CG (m). */
  radarAltitude: number;
  groundSpeed: number;
  /** Compass heading, pitch and bank of the body axes (rad). */
  heading: number;
  pitch: number;
  bank: number;
  /** Flight path angle (rad). */
  gamma: number;
  /** Forces in body axes (N): aerodynamic, thrust, gear, gravity. */
  aero: Vec3d;
  gearForce: Vec3d;
  gravity: Vec3d;
  /** Weight on wheels 0..1. */
  wow: number;
  fuelFlow: number;
  air: AirState;
  laws: LawOutput;
  /** What the control laws read last substep (the flight director inverts the pitch law with it). */
  lawInput: LawInput | null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Model frame (+x forward, +y up, +z starboard) relative to the CG → body axes (x, y right, z down). */
export function modelToBody(
  p: readonly [number, number, number],
  cg: readonly [number, number, number],
): Vec3d {
  return new Vec3d(p[0] - cg[0], p[2] - cg[2], -(p[1] - cg[1]));
}

export class FlightModel {
  readonly spec: FlightSpec;
  readonly radius: number;
  // ---- State ----
  readonly pos = new Vec3d();
  readonly vel = new Vec3d();
  readonly q = new Quatd();
  /** Body rates p, q, r (rad/s). */
  readonly omega = new Vec3d();
  /** Engine core 0 (idle) .. 1 (military), and afterburner 0..1. */
  power = 0;
  afterburner = 0;
  fuel: number;
  /** Gear 0 (up) .. 1 (down), speedbrake 0 (in) .. 1 (out). */
  gear = 1;
  speedbrake = 0;
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
    return m.empty + m.payload + this.fuel;
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
    const v = this.scratch.d.set(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
    return this.q.rotate(v, out);
  }

  /**
   * Places the aircraft at world position `pos` with velocity `vel` and body
   * axes from `heading` (rad), `pitch` and `bank`, resting body rates.
   */
  place(pos: Readonly<Vec3d>, vel: Readonly<Vec3d>, heading: number, pitch: number, bank = 0) {
    this.pos.copy(pos);
    this.vel.copy(vel);
    const up = pos.clone().normalize();
    const east = new Vec3d(0, 1, 0).cross(up);
    if (east.length() < 1e-9) east.set(1, 0, 0);
    east.normalize();
    const north = up.clone().cross(east);
    const h = east.clone().scale(Math.sin(heading)).addScaled(north, Math.cos(heading));
    const fwd = h.clone().scale(Math.cos(pitch)).addScaled(up, Math.sin(pitch));
    const right0 = fwd.clone().cross(up).normalize();
    const up0 = right0.clone().cross(fwd).normalize();
    // Bank turns the right wing down for positive bank.
    const right = right0.clone().scale(Math.cos(bank)).addScaled(up0, -Math.sin(bank));
    const down = fwd.clone().cross(right).normalize();
    this.q.copy(Quatd.fromAxes(fwd, right, down));
    this.omega.set(0, 0, 0);
    this.crashed = null;
    this.stick.pitch = 0;
    this.stick.roll = 0;
    Object.assign(this.lawState, newLawState());
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
    const g = G0 * (R / r) * (R / r);
    const m = this.mass;

    // ---- Systems ----
    const gearTarget = ctl.gearDown ? 1 : 0;
    this.gear += clamp(gearTarget - this.gear, -dt / spec.gear.transit, dt / spec.gear.transit);
    const sbTarget = ctl.speedbrake ? 1 : 0;
    this.speedbrake += clamp(
      sbTarget - this.speedbrake,
      -dt / spec.speedbrake.transit,
      dt / spec.speedbrake.transit,
    );
    const lever = clamp(ctl.throttle, 0, 1);
    const hasFuel = this.fuel > 0 || this.unlimitedFuel;
    const dryCmd = hasFuel ? Math.min(1, lever / MIL_DETENT) : 0;
    const abCmd = hasFuel && lever >= AB_GATE ? 0.2 + (0.8 * (lever - AB_GATE)) / (1 - AB_GATE) : 0;
    const eng = spec.engine;
    const tau = dryCmd > this.power ? eng.spoolUp : eng.spoolDown;
    this.power += (dryCmd - this.power) * Math.min(1, dt / tau);
    const abTarget = this.power > 0.95 ? abCmd : 0;
    this.afterburner += (abTarget - this.afterburner) * Math.min(1, dt / eng.afterburner);

    // ---- Air data ----
    const vb = this.q.unrotate(this.vel, sc.vb);
    const tas = vb.length();
    const mach = tas / air.speedOfSound;
    const qbar = 0.5 * air.density * tas * tas;
    let alpha = 0;
    let beta = 0;
    if (tas > 0.5) {
      alpha = Math.atan2(vb.z, vb.x);
      beta = Math.asin(clamp(vb.y / tas, -1, 1));
    }
    const cas = calibratedAirspeed(tas, air);

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
    const sinA = Math.sin(alpha);
    const cd =
      lookup(a.cd0, mach) +
      a.induced * cl * cl * (1 - a.groundEffectDrag * ge) +
      a.cdAlpha * sinA * sinA +
      a.cdGear * this.gear +
      a.cdFlaps * flaps +
      a.cdSpeedbrake * this.speedbrake;
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
    const wet = lookup2(th.altitude, th.mach, th.afterburner, altitude, mach);
    const thrust = hasFuel ? idle + (mil - idle) * this.power + (wet - mil) * this.afterburner : 0;
    fb.x += thrust;
    const wetShare = Math.min(1, this.afterburner * 5);
    const fuelFlow = thrust * (eng.tsfcDry * (1 - wetShare) + eng.tsfcWet * wetShare);
    if (!this.unlimitedFuel) this.fuel = Math.max(0, this.fuel - fuelFlow * dt);

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
    const gs = spec.gear;
    const steerGain =
      tas <= gs.steerFade
        ? gs.steerHigh + (gs.steerLow - gs.steerHigh) * (1 - tas / gs.steerFade)
        : gs.steerHigh * Math.max(0, 1 - (tas - gs.steerFade) / (gs.steerOff - gs.steerFade));
    const steerAngle = clamp(ctl.yaw, -1, 1) * steerGain;
    // Wheels and hard points only near the ground (one query otherwise).
    const low = altitude - groundUnder < 40;
    for (const w of this.wheels) {
      if (!gearDown || !low) {
        w.load = 0;
        w.anchor = null;
        w.surface = null;
        continue;
      }
      w.steer = w.spec.steerable ? steerAngle : 0;
      const load = this.wheelForce(w, ctl, ground, up, fwWorld, mb);
      totalLoad += load;
      if (this.crashed) return;
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
    const lawIn: LawInput = {
      tas,
      cas,
      alpha,
      beta,
      qbar,
      p: this.omega.x,
      q: this.omega.y,
      r: this.omega.z,
      load: tas > 0.5 ? load : 1,
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
    const my = laws.my + mb.y + halfRhoV * S * c * c * 0.5 * a.cmq * this.omega.y;
    const mz =
      laws.mz +
      mb.z +
      halfRhoV * S * b * b * 0.5 * a.cnr * this.omega.z +
      qbar * S * b * a.cnBeta * beta;
    const [ixx, iyy, izz] = this.inertia;
    const p = this.omega.x;
    const qr = this.omega.y;
    const rr = this.omega.z;
    // Euler's equations: I ω̇ = M − ω × Iω.
    const dp = (mx - (izz - iyy) * qr * rr) / ixx;
    const dq = (my - (ixx - izz) * rr * p) / iyy;
    const dr = (mz - (iyy - ixx) * p * qr) / izz;

    // ---- Integrate (semi-implicit Euler) ----
    const fWorld = this.q.rotate(fb, sc.d).add(fwWorld).add(gw);
    this.vel.addScaled(fWorld, dt / m);
    this.pos.addScaled(this.vel, dt);
    this.omega.set(p + dp * dt, qr + dq * dt, rr + dr * dt);
    this.q.integrateBodyRates(this.omega.x, this.omega.y, this.omega.z, dt);
    this.time += dt;

    // ---- Telemetry ----
    tel.alpha = alpha;
    tel.beta = beta;
    tel.tas = tas;
    tel.cas = cas;
    tel.mach = mach;
    tel.qbar = qbar;
    tel.cl = cl;
    tel.cd = cd;
    tel.thrust = thrust;
    tel.load = tas > 0.5 ? load : 1;
    tel.normalLoad = -sfz / g;
    tel.altitude = altitude;
    tel.wow = wow;
    tel.fuelFlow = fuelFlow;
    this.updateAttitude();
  }

  /** Recomputes the attitude, speeds and heights in the telemetry from the state. */
  updateAttitude(ground?: GroundQuery): void {
    const tel = this.telemetry;
    const up = this.pos.clone().normalize();
    const fwd = this.bodyAxis(0);
    const right = this.bodyAxis(1, new Vec3d());
    tel.heading = headingOf(up, fwd);
    tel.pitch = Math.asin(clamp(fwd.dot(up), -1, 1));
    // Bank: the right wing's drop below the horizon, about the nose.
    const horizRight = fwd.clone().cross(up);
    const hl = horizRight.length();
    if (hl > 1e-6) {
      horizRight.scale(1 / hl);
      const upPerp = horizRight.clone().cross(fwd);
      tel.bank = Math.atan2(-right.dot(upPerp), right.dot(horizRight));
    }
    const vs = this.vel.dot(up);
    tel.verticalSpeed = vs;
    const gs2 = this.vel.lengthSq() - vs * vs;
    tel.groundSpeed = Math.sqrt(Math.max(0, gs2));
    const v = this.vel.length();
    tel.gamma = v > 0.5 ? Math.asin(clamp(vs / v, -1, 1)) : 0;
    tel.altitude = this.pos.length() - this.radius;
    if (ground) {
      tel.radarAltitude = tel.altitude - this.gearHeightNow() - ground.height(up);
    }
  }

  /** Height of the CG above the lowest wheel bottom, at the current attitude (m). */
  gearHeightNow(): number {
    const up = this.pos.clone().normalize();
    let h = 0;
    const tmp = new Vec3d();
    for (const w of this.wheels) h = Math.max(h, -this.q.rotate(w.body, tmp).dot(up));
    return h;
  }

  /**
   * One wheel's force: normal spring-damper along the local vertical, grip and
   * rolling resistance in the ground plane. Adds the world force to `fw` and the
   * body moment to `mb`; returns the normal load (N).
   */
  private wheelForce(
    w: WheelState,
    ctl: Readonly<FlightControls>,
    ground: GroundQuery,
    up: Readonly<Vec3d>,
    fw: Vec3d,
    mb: Vec3d,
  ): number {
    const g = this.spec.gear;
    const arm = this.q.rotate(w.body, new Vec3d());
    const P = arm.clone().add(this.pos);
    const dir = P.clone().normalize();
    const groundH = ground.height(dir);
    const depth = groundH - (P.length() - this.radius);
    if (depth <= 0) {
      w.load = 0;
      w.compression = 0;
      w.anchor = null;
      w.surface = null;
      return 0;
    }
    const surface = ground.surface(dir);
    if (surface === 'water') {
      this.crash('Ditched in the water');
      return 0;
    }
    w.surface = surface;
    // Velocity of the tire: v + ω × r (ω in body → world).
    const omegaW = this.q.rotate(this.omega, new Vec3d());
    const vP = omegaW.cross(arm).add(this.vel);
    const sinkRate = -vP.dot(up);
    let n = w.spec.stiffness * depth + w.spec.damping * sinkRate;
    if (depth > w.spec.travel) n += 20 * w.spec.stiffness * (depth - w.spec.travel);
    n = Math.max(0, n);
    w.compression = Math.min(depth, w.spec.travel);
    w.load = n;
    const contact = P.addScaled(up, depth);
    // Rolling direction: the body's x axis turned by the steering angle, in the ground plane.
    const fBody = new Vec3d(Math.cos(w.steer), Math.sin(w.steer), 0);
    const f = this.q.rotate(fBody, new Vec3d());
    f.addScaled(up, -f.dot(up)).normalize();
    const l = f.clone().cross(up).normalize();
    const vf = vP.dot(f);
    const vl = vP.dot(l);
    if (!w.anchor) w.anchor = contact.clone();
    const d = contact.clone().sub(w.anchor);
    let df = d.dot(f);
    let dl = d.dot(l);
    const k = g.gripStiffness;
    const c = g.gripDamping;
    // Lateral grip: the grip spring at rest and taxi speeds (no creep), and at speed
    // a tire's cornering force from its slip angle (cornering · load per radian),
    // both capped by friction. The spring's damping alone acted like a cornering
    // stiffness some thirty times a tire's at takeoff speed, so any heading change
    // saturated the tires and could roll the jet onto a wingtip (decision 136).
    const capL = g.lateral * n;
    dl = clamp(dl, -capL / k, capL / k);
    const spring = clamp(-k * dl - c * vl, -capL, capL);
    const slip = Math.atan2(vl, Math.abs(vf));
    const corner = clamp(-g.cornering * n * slip, -capL, capL);
    const atSpeed = smooth01((Math.abs(vf) - 2) / 4);
    const Fl = spring * (1 - atSpeed) + corner * atSpeed;
    if (atSpeed > 0) dl *= 1 - atSpeed;
    // Rolling: braked wheels grip up to their braking friction; free wheels roll.
    let brake = 0;
    if (w.spec.braked) {
      brake = ctl.parkingBrake
        ? 1
        : clamp(w.spec.name === 'left' ? ctl.brakeLeft : ctl.brakeRight, 0, 1);
    }
    let Ff: number;
    if (brake > 0) {
      const capF = (g.rolling + g.braking * brake) * n;
      df = clamp(df, -capF / k, capF / k);
      Ff = clamp(-k * df - c * vf, -capF, capF);
    } else {
      Ff = -g.rolling * n * Math.tanh(vf / 0.2);
      df = 0;
    }
    w.anchor.copy(contact).addScaled(f, -df).addScaled(l, -dl);
    const F = up.clone().scale(n).addScaled(f, Ff).addScaled(l, Fl);
    fw.add(F);
    // Moment about the CG in body axes: r × F with r from the CG to the contact.
    const rc = contact.sub(this.pos);
    const Mw = rc.cross(F);
    mb.add(this.q.unrotate(Mw, new Vec3d()));
    return n;
  }

  /** Crashes the aircraft if a hard point is below the ground. */
  private contactCheck(ground: GroundQuery): void {
    const tmp = new Vec3d();
    for (let i = 0; i < this.contacts.length; i++) {
      const P = this.q.rotate(this.contacts[i]!, tmp).add(this.pos);
      const dir = P.clone().normalize();
      if (P.length() - this.radius < ground.height(dir)) {
        const s = ground.surface(dir);
        this.crash(
          s === 'water'
            ? 'Ditched in the water'
            : this.gear < 0.999 && this.contacts[i]!.z > 0
              ? 'Landed with the gear up'
              : 'Struck the ground',
        );
        return;
      }
    }
  }
}

function smooth01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}
