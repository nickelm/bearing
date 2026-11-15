/**
 * The helicopter's flight model (Proposal 0004, Flight Model; track H1): one
 * rigid body with a main rotor as a thrust disc, a tail rotor, a fuselage with
 * a fin and a stabilizer, an engine with a governor, and skids or wheels. It
 * implements the Airframe every flown aircraft shares (decision 154), with the
 * same 120 Hz step in four substeps, float64 state and determinism as the
 * Kestrel's model. Assists and protection are not here: the control layer
 * (heloLaws.ts) turns the pilot's or the director's commands into raw cyclic,
 * collective and pedals.
 *
 * - **Main rotor.** Thrust from collective and inflow (rotorAero.ts) along the
 *   disc's normal; the disc tilts with cyclic through first-order flapping with
 *   the time constant 16/(γΩ), lags the body's rates (rotor damping), blows back
 *   and to the advancing side in forward flight. The hub moment adds stiffness
 *   (articulated, hingeless) to the thrust's own moment arm. The inflow is a
 *   state that lags Glauert's value, so translational lift arrives with speed
 *   and ground effect cushions the hover.
 * - **Torque and power.** Induced, climb and profile power load the rotor; the
 *   engine's power, governed toward the rotor's set speed and limited by what
 *   the air and the transmission allow, drives it. The rotor's speed is a state.
 *   The torque's reaction yaws the fuselage; the tail rotor, a second disc on
 *   pedal pitch, counters it with its own inflow and power.
 * - **Fuselage.** Drag areas along the body axes, and a fin and a stabilizer as
 *   small lifting surfaces in the local flow (weathervaning, pitch attitude at
 *   speed, damping).
 * - **Ground.** Skids slide on friction both ways (contact.ts's tire with the
 *   brake held); wheels roll, brake and castor. Hard points crash it.
 */
import { Quatd } from '../../../core/quat';
import { Vec3d } from '../../../core/vec3d';
import type { Airframe, AirframeTelemetry } from '../airframe';
import { calibratedAirspeed, SEA_LEVEL_DENSITY, standardAtmosphere } from '../atmosphere';
import { hardPointHit, ON_WATER, release, supportHeight, wheelForce } from '../contact';
import type { GroundQuery, TireSpec, WheelContact } from '../contact';
import {
  airVelocityBody,
  attitudeQuat,
  attitudeTelemetry,
  bodyAxisOf,
  eulerRates,
  FLIGHT_STEP,
  gravityAt,
  integrate,
  SUBSTEPS,
} from '../rigidBody';
import {
  forwardFlapping,
  glauertInflow,
  groundEffect,
  inflowTime,
  powerCoefficient,
  profilePower,
  thrustCoefficient,
} from './rotorAero';
import { solidity, specToBody } from './rotorSpec';
import type { GearPointSpec, RotorcraftSpec, RotorDiscSpec } from './rotorSpec';

/** The raw controls of a helicopter, as the control layer leaves them. */
export interface RotorControls {
  /** Collective lever 0 (down) .. 1 (up). */
  collective: number;
  /** Cyclic: + forward, + right, −1..1. */
  cyclicLon: number;
  cyclicLat: number;
  /** Pedals: + right (nose right), −1..1. */
  pedals: number;
  /** Wheel brakes 0..1 and the parking brake (wheeled types). */
  brake: number;
  parkingBrake: boolean;
}

export function neutralRotorControls(): RotorControls {
  return {
    collective: 0,
    cyclicLon: 0,
    cyclicLat: 0,
    pedals: 0,
    brake: 0,
    parkingBrake: false,
  };
}

export interface RotorTelemetry extends AirframeTelemetry {
  /** Main rotor thrust (N), torque as a fraction of the transmission's limit at set speed, rotor speed as a fraction of set speed. */
  thrust: number;
  torque: number;
  rotorSpeed: number;
  /** Power the rotors take, the engine gives, and the air and transmission allow (W). */
  powerRequired: number;
  power: number;
  powerAvailable: number;
  /** Advance ratio, induced and total inflow ratio, and the hover's induced inflow ratio at this thrust. */
  mu: number;
  inflow: number;
  lambda: number;
  /** Disc tilt against the shaft (rad): + forward, + right. */
  tiltForward: number;
  tiltRight: number;
  /** Tail rotor thrust (N). */
  tailThrust: number;
  /** Ground-effect factor on the induced inflow (1: none) and the hub's height over the ground (m). */
  groundEffect: number;
  hubHeight: number;
}

/** A gear point's state: a wheel or a point on a skid. */
export interface SupportState extends WheelContact {
  readonly spec: GearPointSpec;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** One rotor's geometry and nondimensional constants, in body axes. */
interface Disc {
  spec: RotorDiscSpec;
  hub: Vec3d;
  area: number;
  sigma: number;
}

function disc(spec: Readonly<RotorcraftSpec>, d: RotorDiscSpec): Disc {
  return {
    spec: d,
    hub: specToBody(spec, d.at),
    area: Math.PI * d.radius * d.radius,
    sigma: solidity(d),
  };
}

export class RotorcraftModel implements Airframe<RotorControls, RotorTelemetry> {
  readonly kind = 'rotorcraft' as const;
  readonly spec: RotorcraftSpec;
  readonly radius: number;
  readonly pos = new Vec3d();
  readonly vel = new Vec3d();
  readonly q = new Quatd();
  readonly omega = new Vec3d();
  readonly wind = new Vec3d();
  time = 0;
  fuel: number;
  unlimitedFuel = true;
  readonly gear = 1;
  crashed: string | null = null;
  readonly supports: SupportState[];
  readonly contacts: Vec3d[];
  readonly telemetry: RotorTelemetry;

  // ---- Rotor and engine states ----
  /** Main rotor speed (rad/s). */
  rotorOmega: number;
  /** Induced inflow ratios of the main rotor (ground effect applied) and the tail rotor. */
  inflow = 0.05;
  /** The main rotor's induced inflow ratio as it would be in free air: the lagged state. */
  inflowFree = 0.05;
  tailInflow = 0.05;
  /** Disc tilt against the shaft (rad): + forward, + right. */
  tiltForward = 0;
  tiltRight = 0;
  /** Engine output (W). */
  enginePower = 0;
  /**
   * The disc's steady tilt in forward flight on top of the cyclic (rad, + forward, + right):
   * blowback and the coning's tilt to the advancing side. The control layer subtracts it.
   */
  flapForward = 0;
  flapRight = 0;
  /** The main rotor's azimuth (rad), for the view. */
  azimuth = 0;
  tailAzimuth = 0;

  readonly main: Disc;
  readonly tail: Disc;
  private readonly shaft: Vec3d;
  private readonly shaftForward: Vec3d;
  private readonly inertia: [number, number, number];
  private readonly tire: TireSpec;
  private readonly skidTire: TireSpec;
  private readonly castorTire: TireSpec;
  private readonly fin: Vec3d;
  private readonly stab: Vec3d;
  /** The tail rotor's thrust direction for positive pitch, body axes. */
  readonly tailAxisBody: Vec3d;
  private readonly s = {
    vb: new Vec3d(),
    w: new Vec3d(),
    up: new Vec3d(),
    fb: new Vec3d(),
    mb: new Vec3d(),
    fw: new Vec3d(),
    gw: new Vec3d(),
    gb: new Vec3d(),
    n: new Vec3d(),
    a: new Vec3d(),
    b: new Vec3d(),
    c: new Vec3d(),
    d: new Vec3d(),
    e: new Vec3d(),
  };

  constructor(spec: RotorcraftSpec, radius: number) {
    this.spec = spec;
    this.radius = radius;
    this.fuel = spec.mass.fuel;
    this.inertia = [...spec.inertia];
    this.main = disc(spec, spec.main);
    this.tail = disc(spec, spec.tail);
    const it = spec.main.shaftTilt;
    // Body axes: x forward, z down. The shaft points up (−z), tilted forward.
    this.shaft = new Vec3d(Math.sin(it), 0, -Math.cos(it));
    this.shaftForward = new Vec3d(Math.cos(it), 0, Math.sin(it));
    const ax = spec.tail.axis;
    this.tailAxisBody = new Vec3d(ax[0], ax[2], -ax[1]);
    this.fin = specToBody(spec, spec.fuselage.fin.at);
    this.stab = specToBody(spec, spec.fuselage.stabilizer.at);
    this.tire = spec.gear.tire;
    this.skidTire = { ...spec.gear.tire, rolling: 0 };
    this.castorTire = { ...spec.gear.tire, lateral: 0.02 };
    this.supports = spec.gear.points.map((p) => ({
      spec: p,
      body: specToBody(spec, p.at),
      compression: 0,
      load: 0,
      anchor: null,
      surface: null,
      steer: 0,
    }));
    this.contacts = spec.contacts.map((c) => specToBody(spec, c));
    this.rotorOmega = spec.main.speed;
    this.telemetry = {
      heading: 0,
      pitch: 0,
      bank: 0,
      gamma: 0,
      verticalSpeed: 0,
      groundSpeed: 0,
      altitude: 0,
      alpha: 0,
      beta: 0,
      tas: 0,
      cas: 0,
      mach: 0,
      qbar: 0,
      load: 1,
      normalLoad: 1,
      radarAltitude: 0,
      aero: new Vec3d(),
      gearForce: new Vec3d(),
      gravity: new Vec3d(),
      wow: 0,
      fuelFlow: 0,
      air: standardAtmosphere(0),
      thrust: 0,
      torque: 0,
      rotorSpeed: 1,
      powerRequired: 0,
      power: 0,
      powerAvailable: 0,
      mu: 0,
      inflow: 0,
      lambda: 0,
      tiltForward: 0,
      tiltRight: 0,
      tailThrust: 0,
      groundEffect: 1,
      hubHeight: 0,
    };
  }

  /** Landing sink rate (m/s) above which the outcomes monitor counts a crash. */
  get crashSink(): number {
    return this.spec.limits.crashSink;
  }

  get mass(): number {
    const m = this.spec.mass;
    return m.empty + m.payload + this.fuel;
  }

  get onGround(): boolean {
    return this.supports.some((s) => s.load > 0);
  }

  /** Height of the CG above the gear points, extended and unloaded (m). */
  get gearHeight(): number {
    return Math.max(...this.supports.map((s) => s.body.z));
  }

  bodyAxis(axis: 0 | 1 | 2, out = new Vec3d()): Vec3d {
    return bodyAxisOf(this.q, axis, this.s.d, out);
  }

  gearHeightNow(): number {
    return supportHeight(this, this.supports);
  }

  /** The main rotor's set speed (rad/s). */
  get setSpeed(): number {
    return this.spec.main.speed;
  }

  /**
   * Places the helicopter with its rotor at set speed and the engine giving
   * what a hover needs (a hot start, decision 151), uncrashed.
   */
  place(pos: Readonly<Vec3d>, vel: Readonly<Vec3d>, heading: number, pitch: number, bank = 0) {
    this.pos.copy(pos);
    this.vel.copy(vel);
    attitudeQuat(pos, heading, pitch, bank, this.q);
    this.omega.set(0, 0, 0);
    this.crashed = null;
    this.rotorOmega = this.spec.main.speed;
    this.tiltForward = 0;
    this.tiltRight = 0;
    this.tailInflow = 0.05;
    this.primeHover();
    for (const s of this.supports) {
      s.anchor = null;
      s.load = 0;
      s.compression = 0;
      s.surface = null;
      s.steer = 0;
    }
  }

  /**
   * The hover's state at the present place: the air there, the inflow of a hover at this
   * weight and the engine giving its power, so a hot start in the air does not sag while
   * the engine spools and the control layer's first trim reads real numbers.
   */
  private primeHover(): void {
    const M = this.spec.main;
    const tel = this.telemetry;
    const air = standardAtmosphere(this.pos.length() - this.radius, tel.air);
    const tip = M.speed * M.radius;
    const scale = air.density * this.main.area * tip * tip;
    const ct = (this.mass * gravityAt(this.radius, this.pos.length())) / scale;
    const lambda = Math.sqrt(Math.max(1e-6, ct) / 2);
    this.inflow = lambda;
    this.inflowFree = lambda;
    tel.mu = 0;
    tel.lambda = lambda;
    tel.thrust = ct * scale;
    const cp = powerCoefficient(ct, lambda, 0, M.kappa, profilePower(this.main.sigma, M.cd0, 0));
    // The tail rotor takes about a tenth more.
    this.enginePower = 1.1 * cp * scale * tip;
  }

  crash(reason: string): void {
    if (this.crashed) return;
    this.crashed = reason;
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
  }

  /** The disc's normal (thrust direction) in body axes for the present tilt, into `out`. */
  discNormal(out: Vec3d): Vec3d {
    const tf = this.tiltForward;
    const tr = this.tiltRight;
    const t = Math.hypot(tf, tr);
    out.copy(this.shaft).scale(Math.cos(t));
    if (t > 1e-12) {
      const k = Math.sin(t) / t;
      out.addScaled(this.shaftForward, tf * k);
      out.y += tr * k;
    }
    return out;
  }

  /**
   * Main rotor thrust (N) for collective lever `collective` at the present
   * inflow, speed, air and ground: what the control layer inverts for its trim.
   */
  thrustFor(collective: number): number {
    const m = this.spec.main;
    const tel = this.telemetry;
    const theta = m.collective[0] + clamp(collective, 0, 1) * (m.collective[1] - m.collective[0]);
    const tip = this.rotorOmega * m.radius;
    const ct = thrustCoefficient(
      this.main.sigma,
      m.liftSlope,
      theta,
      m.twist,
      tel.mu,
      tel.lambda,
      m.tipLoss,
    );
    return ct * tel.air.density * this.main.area * tip * tip;
  }

  /** Tail rotor thrust (N) for pedal position `pedals` at the present inflow. */
  tailThrustFor(pedals: number): number {
    const t = this.spec.tail;
    const theta = this.tailPitch(pedals);
    const tip = this.tailOmega * t.radius;
    const lambda = this.tailLambdaC + this.tailInflow;
    const ct = thrustCoefficient(
      this.tail.sigma,
      t.liftSlope,
      theta,
      t.twist,
      this.tailMu,
      lambda,
      t.tipLoss,
    );
    return ct * this.telemetry.air.density * this.tail.area * tip * tip;
  }

  /** Hub moment (N·m) per radian of disc tilt at the present thrust: the cyclic's control power. */
  get controlPower(): number {
    const h = -this.main.hub.z;
    return this.spec.main.hubStiffness + Math.max(0, this.telemetry.thrust) * h;
  }

  /** The tail rotor's moment arm about the CG for yaw (m). */
  get tailArm(): number {
    return Math.abs(this.tail.hub.x);
  }

  get tailOmega(): number {
    return (this.rotorOmega * this.spec.tail.speed) / this.spec.main.speed;
  }

  private tailMu = 0;
  private tailLambdaC = 0;

  private tailPitch(pedals: number): number {
    const p = this.spec.tail.pitch;
    // The tail rotor's thrust pushes the tail toward its axis: for a main rotor turning
    // counterclockwise the axis points right and the nose yaws left with more pitch.
    // Right pedal yaws the nose right, so it takes pitch off when the axis points right.
    const s = this.tailAxisBody.y >= 0 ? -1 : 1;
    const u = clamp(0.5 + 0.5 * s * clamp(pedals, -1, 1), 0, 1);
    return p[0] + u * (p[1] - p[0]);
  }

  /** Advances one fixed step (FLIGHT_STEP) with the controls held. */
  step(ctl: Readonly<RotorControls>, ground: GroundQuery): void {
    if (this.crashed) return;
    const h = FLIGHT_STEP / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS && !this.crashed; i++) this.substep(ctl, ground, h);
    this.updateAttitude(ground);
  }

  private substep(ctl: Readonly<RotorControls>, ground: GroundQuery, dt: number): void {
    const spec = this.spec;
    const sc = this.s;
    const tel = this.telemetry;
    const R = this.radius;
    const r = this.pos.length();
    const up = sc.up.copy(this.pos).scale(1 / r);
    const altitude = r - R;
    const air = standardAtmosphere(altitude, tel.air);
    const rho = air.density;
    const g = gravityAt(R, r);
    const m = this.mass;

    // ---- Air data ----
    const vb = airVelocityBody(this, sc.w, sc.vb);
    const tas = vb.length();
    const qbar = 0.5 * rho * tas * tas;
    let alpha = 0;
    let beta = 0;
    if (tas > 0.5) {
      alpha = Math.atan2(vb.z, vb.x);
      beta = Math.asin(clamp(vb.y / tas, -1, 1));
    }

    // ---- Main rotor ----
    const M = spec.main;
    const Om = Math.max(1, this.rotorOmega);
    const tip = Om * M.radius;
    const n = this.discNormal(sc.n);
    // Air velocity at the hub relative to the hub (body axes): v + ω × r.
    const vHub = sc.a.copy(this.omega).cross(this.main.hub).add(vb);
    const vn = vHub.dot(n);
    const lambdaC = vn / tip;
    const inPlane = sc.b.copy(vHub).addScaled(n, -vn);
    const vIp = inPlane.length();
    const mu = vIp / tip;
    const theta =
      M.collective[0] + clamp(ctl.collective, 0, 1) * (M.collective[1] - M.collective[0]);
    // The hub's height over the ground, for ground effect: Cheeseman and Bennett's factor
    // scales the induced inflow outside Glauert's fixed point (inside it the inflow fell only
    // by the factor's square root, half the cushion).
    const hubW = this.q.rotate(this.main.hub, sc.c).add(this.pos);
    const hubR = hubW.length();
    const hubDir = hubW.scale(1 / hubR);
    const hubHeight = hubR - R - ground.height(hubDir);
    const ge = groundEffect(M.radius, hubHeight, mu, Math.max(0.02, this.inflowFree));
    this.inflow = ge * this.inflowFree;
    const lambda = lambdaC + this.inflow;
    const ct = thrustCoefficient(
      this.main.sigma,
      M.liftSlope,
      theta,
      M.twist,
      mu,
      lambda,
      M.tipLoss,
    );
    // Glauert's inflow in free air, held from below at a fraction of the hover's, lagged as a
    // state; the ground's cushion applies to it above.
    const lambdaH = Math.sqrt(Math.max(1e-6, Math.abs(ct)) / 2);
    const lambdaFree = lambdaC + this.inflowFree;
    const target = glauertInflow(ct, mu, lambdaFree, 0.5 * lambdaH);
    this.inflowFree += (target - this.inflowFree) * Math.min(1, dt / inflowTime(Om, lambdaFree));
    const thrust = ct * rho * this.main.area * tip * tip;
    const cp = powerCoefficient(
      ct,
      this.inflow,
      lambdaC,
      M.kappa,
      profilePower(this.main.sigma, M.cd0, mu),
    );
    const qMain = cp * rho * this.main.area * tip * tip * M.radius;

    // ---- Flapping: the disc toward its steady tilt, lagging the body's rates ----
    const ff = forwardFlapping(theta, mu, lambda, M.lock);
    let bx = 0;
    let by = 0;
    if (vIp > 1e-6) {
      // Blowback away from the in-plane wind, in the shaft's forward and right axes;
      // the coning tilts the disc toward the advancing side, v̂ × ω̂ (ω̂ = direction · n).
      const fx = inPlane.dot(this.shaftForward) / vIp;
      const fy = inPlane.y / vIp;
      bx = -ff.back * fx;
      by = -ff.back * fy;
      // v̂ × ω̂ points to the advancing side: right for a counterclockwise rotor in forward flight.
      const ax = -fy * M.direction;
      const ay = fx * M.direction;
      bx += ff.side * ax;
      by += ff.side * ay;
    }
    this.flapForward = bx;
    this.flapRight = by;
    const tau = 16 / (M.lock * Om);
    const lon = clamp(ctl.cyclicLon, -1, 1) * M.cyclic[0] + bx;
    const lat = clamp(ctl.cyclicLat, -1, 1) * M.cyclic[1] + by;
    // The body pitching nose up leaves the disc tilted forward against it, and rolling
    // right leaves it tilted left: the rotor's damping.
    this.tiltForward += ((lon - this.tiltForward) / tau + this.omega.y) * dt;
    this.tiltRight += ((lat - this.tiltRight) / tau - this.omega.x) * dt;
    const tilt = Math.hypot(this.tiltForward, this.tiltRight);
    if (tilt > M.maxFlap) {
      this.tiltForward *= M.maxFlap / tilt;
      this.tiltRight *= M.maxFlap / tilt;
    }

    // ---- Forces and moments (body axes) ----
    const fb = sc.fb.copy(n).scale(thrust);
    const mb = sc.mb.copy(this.main.hub).cross(fb);
    // Hub stiffness: a forward tilt pitches the nose down, a right tilt rolls right.
    mb.x += M.hubStiffness * this.tiltRight;
    mb.y -= M.hubStiffness * this.tiltForward;
    // The rotor's torque reacts on the fuselage about the shaft, against the rotor's spin.
    mb.addScaled(n, -M.direction * qMain);

    // ---- Tail rotor ----
    const T = spec.tail;
    const tOm = (Om * T.speed) / M.speed;
    const tTip = tOm * T.radius;
    const vTail = sc.a.copy(this.omega).cross(this.tail.hub).add(vb);
    const vax = vTail.dot(this.tailAxisBody);
    const tLambdaC = vax / tTip;
    const tIp = Math.sqrt(Math.max(0, vTail.lengthSq() - vax * vax));
    const tMu = tIp / tTip;
    this.tailMu = tMu;
    this.tailLambdaC = tLambdaC;
    const tTheta = this.tailPitch(ctl.pedals);
    const tLambda = tLambdaC + this.tailInflow;
    const tct = thrustCoefficient(
      this.tail.sigma,
      T.liftSlope,
      tTheta,
      T.twist,
      tMu,
      tLambda,
      T.tipLoss,
    );
    const tLambdaH = Math.sqrt(Math.max(1e-6, Math.abs(tct)) / 2);
    const tTarget = glauertInflow(tct, tMu, tLambda, 0.5 * tLambdaH);
    this.tailInflow += (tTarget - this.tailInflow) * Math.min(1, dt / inflowTime(tOm, tLambda));
    const tailThrust = tct * rho * this.tail.area * tTip * tTip;
    const tcp = powerCoefficient(
      tct,
      this.tailInflow,
      tLambdaC,
      T.kappa,
      profilePower(this.tail.sigma, T.cd0, tMu),
    );
    const pTail = tcp * rho * this.tail.area * tTip * tTip * tTip;
    const ft = sc.c.copy(this.tailAxisBody).scale(tailThrust);
    fb.add(ft);
    mb.add(sc.d.copy(this.tail.hub).cross(ft));

    // ---- Fuselage drag ----
    const fd = spec.fuselage.drag;
    const half = 0.5 * rho * tas;
    fb.x -= half * fd[0] * vb.x;
    fb.y -= half * fd[1] * vb.y;
    fb.z -= half * fd[2] * vb.z;

    // ---- Fin and stabilizer in the local flow (v + ω × r) ----
    const fin = spec.fuselage.fin;
    if (fin.area > 0) {
      const v = sc.a.copy(this.omega).cross(this.fin).add(vb);
      const v2 = v.x * v.x + v.y * v.y;
      if (v2 > 0.25) {
        const b2 = Math.atan2(v.y, Math.abs(v.x)) - fin.incidence;
        const side = -0.5 * rho * v2 * fin.area * fin.slope * 0.5 * Math.sin(2 * b2);
        const f = sc.d.set(0, side, 0);
        fb.add(f);
        mb.add(sc.e.copy(this.fin).cross(f));
      }
    }
    const st = spec.fuselage.stabilizer;
    if (st.area > 0) {
      const v = sc.a.copy(this.omega).cross(this.stab).add(vb);
      const v2 = v.x * v.x + v.z * v.z;
      if (v2 > 0.25) {
        const a2 = Math.atan2(v.z, Math.abs(v.x)) + st.incidence;
        const lift = 0.5 * rho * v2 * st.area * st.slope * 0.5 * Math.sin(2 * a2);
        const f = sc.d.set(0, 0, -lift);
        fb.add(f);
        mb.add(sc.e.copy(this.stab).cross(f));
      }
    }
    tel.aero.copy(fb);

    // ---- Gravity ----
    const gw = sc.gw.copy(up).scale(-g * m);
    const gb = this.q.unrotate(gw, sc.gb);
    tel.gravity.copy(gb);

    // ---- Ground ----
    const fwWorld = sc.fw.set(0, 0, 0);
    const mbGround = sc.e.set(0, 0, 0);
    let totalLoad = 0;
    const groundUnder = ground.height(up);
    const low = altitude - groundUnder < 40;
    const skids = spec.gear.kind === 'skids';
    // A castoring wheel turns to its ground track.
    const vgBody = this.q.unrotate(this.vel, sc.d);
    const track = Math.hypot(vgBody.x, vgBody.y) > 0.5 ? Math.atan2(vgBody.y, vgBody.x) : null;
    for (const s of this.supports) {
      if (!low) {
        release(s);
        continue;
      }
      if (s.spec.castor && track !== null)
        s.steer = Math.abs(track) > Math.PI / 2 ? track - Math.sign(track) * Math.PI : track;
      const brake = skids ? 1 : s.spec.braked ? (ctl.parkingBrake ? 1 : clamp(ctl.brake, 0, 1)) : 0;
      const tire = skids ? this.skidTire : s.spec.castor ? this.castorTire : this.tire;
      const load = wheelForce(this, s, s.spec, tire, brake, ground, up, fwWorld, mbGround);
      if (load === ON_WATER) {
        this.crash('Ditched in the water');
        return;
      }
      totalLoad += load;
    }
    const wow = clamp(totalLoad / (0.25 * m * g), 0, 1);
    if (low) {
      const hit = hardPointHit(this, this.contacts, ground);
      if (hit) {
        this.crash(hit.surface === 'water' ? 'Ditched in the water' : 'Struck the ground');
        return;
      }
    }
    mb.add(mbGround);
    const gearB = this.q.unrotate(fwWorld, sc.a);
    tel.gearForce.copy(gearB);

    // ---- Rotor speed and engine ----
    const powerRequired = qMain * Om + pTail;
    const E = spec.engine;
    const hot = Math.max(0, air.temperature - standardAtmosphere(altitude).temperature);
    const hasFuel = this.fuel > 0 || this.unlimitedFuel;
    const available = hasFuel
      ? Math.min(
          E.transmission,
          E.power * (rho / SEA_LEVEL_DENSITY) ** E.lapse * (1 - E.hotLoss * hot),
        )
      : 0;
    // The governor: the load it sees plus a correction toward set speed.
    const I = M.inertia;
    const want = powerRequired + (I * M.speed * (M.speed - Om)) / 0.6;
    const target2 = clamp(want, 0, available);
    this.enginePower += (target2 - this.enginePower) * Math.min(1, dt / E.spool);
    this.enginePower = Math.min(this.enginePower, available);
    const fuelFlow = this.enginePower * E.sfc;
    if (!this.unlimitedFuel) this.fuel = Math.max(0, this.fuel - fuelFlow * dt);

    // ---- Integrate ----
    const rates = eulerRates(this.inertia, this.omega, mb.x, mb.y, mb.z, sc.c);
    const fWorld = this.q.rotate(fb, sc.d).add(fwWorld).add(gw);
    integrate(this, fWorld, m, rates, dt);
    this.rotorOmega = Math.max(0, Om + ((this.enginePower - powerRequired) / Om / I) * dt);
    this.azimuth = (this.azimuth + this.rotorOmega * dt) % (2 * Math.PI);
    this.tailAzimuth = (this.tailAzimuth + tOm * dt) % (2 * Math.PI);

    // ---- Telemetry ----
    const sfx = (fb.x + gearB.x) / m;
    const sfy = (fb.y + gearB.y) / m;
    const sfz = (fb.z + gearB.z) / m;
    tel.alpha = alpha;
    tel.beta = beta;
    tel.tas = tas;
    tel.cas = calibratedAirspeed(tas, air);
    tel.mach = tas / air.speedOfSound;
    tel.qbar = qbar;
    tel.load = (sfx * n.x + sfy * n.y + sfz * n.z) / g;
    tel.normalLoad = -sfz / g;
    tel.altitude = altitude;
    tel.wow = wow;
    tel.fuelFlow = fuelFlow;
    tel.thrust = thrust;
    tel.torque = (qMain * M.speed) / E.transmission;
    tel.rotorSpeed = this.rotorOmega / M.speed;
    tel.powerRequired = powerRequired;
    tel.power = this.enginePower;
    tel.powerAvailable = available;
    tel.mu = mu;
    tel.inflow = this.inflow;
    tel.lambda = lambda;
    tel.tiltForward = this.tiltForward;
    tel.tiltRight = this.tiltRight;
    tel.tailThrust = tailThrust;
    tel.groundEffect = ge;
    tel.hubHeight = hubHeight;
    attitudeTelemetry(this, tel, sc.d);
  }

  updateAttitude(ground?: GroundQuery): void {
    const tel = this.telemetry;
    const up = attitudeTelemetry(this, tel, this.s.d);
    if (ground) tel.radarAltitude = tel.altitude - this.gearHeightNow() - ground.height(up);
  }
}
