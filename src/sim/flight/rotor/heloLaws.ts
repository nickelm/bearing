/**
 * The helicopter's control layer (Proposal 0004, Controls and Assists; rule
 * 12): turns the pilot's commands (fly-by-mouse, keys) or the director's into
 * raw collective, cyclic and pedals for the flight model. The model never sees
 * an assist; everything here is what a stability and control augmentation
 * system and an autopilot would do.
 *
 * - **Targets.** The mouse moves a pitch-attitude target that holds when the
 *   mouse stops (auto-trim), and turns: below the type's hover speed it slews
 *   the heading to hold, above its turn speed it banks into a coordinated
 *   turn, blended by ground speed between them. A/D command a sideways speed in
 *   the hover (and hold none when let go: drift correction) and bank at speed;
 *   Q/E turn the nose at any speed; W/S command a climb rate and the altitude
 *   holds when they are let go.
 * - **Hover hold** keeps the position and heading; in the Assisted preset it
 *   engages by itself when the helicopter is slow and the cyclic is let go.
 * - **Inner loops.** Attitude errors give an angular acceleration, a moment and,
 *   through the rotor's control power, a disc tilt, with integrators for trim.
 *   The pedals get the torque's feedforward by inverting the tail rotor; the
 *   collective by inverting the main rotor's thrust for the vertical
 *   acceleration wanted. The torque limiter stops the collective short of the
 *   transmission's limit, and near the ground the descent eases (landing aid).
 */
import { Vec3d } from '../../../core/vec3d';
import type { Assists } from './assists';
import type { RotorControls, RotorcraftModel } from './rotorcraftModel';
import { eastNorth } from '../runway';

/** What the pilot asks this step. */
export interface HeloCommand {
  /** Mouse this step, as angles (rad): + nose up; + turn right. */
  mousePitch: number;
  mouseTurn: number;
  /** Keys −1..1: collective (+ up), lateral cyclic (+ right), pedals (+ nose right). */
  collective: number;
  lateral: number;
  pedals: number;
  /** Hover hold toggled this step (H). */
  toggleHover: boolean;
  /** Wheel brakes (wheeled types). */
  brake: number;
  parkingBrake: boolean;
}

export function neutralCommand(): HeloCommand {
  return {
    mousePitch: 0,
    mouseTurn: 0,
    collective: 0,
    lateral: 0,
    pedals: 0,
    toggleHover: false,
    brake: 0,
    parkingBrake: false,
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const G = 9.806_65;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Gains of the inner loops: natural frequency (rad/s) and damping of attitude, and the rest. */
const ATTITUDE_W = 3;
const ATTITUDE_Z = 0.9;
/** Integral gain of the attitude loops (1/s): trims out steady moments (CG, tail rotor, fuselage). */
const TRIM_GAIN = 0.4;
const YAW_GAIN = 2.5;
const YAW_RATE_GAIN = 3;
const CLIMB_GAIN = 1.2;
const ALT_GAIN = 0.5;
const HOLD_POS = 0.35;
const HOLD_VEL = 0.9;
const HOLD_I = 0.04;
/** Time constant (s) of the trim attitude's filter. */
const TRIM_FILTER = 1;
/** Ground speed (m/s) under which hover hold may engage by itself, and the seconds the inputs must rest. */
const HOLD_SPEED = 1.5;
const HOLD_REST = 0.5;
/** Most pitch target away from the trim attitude (rad) at which hover hold engages by itself. */
const HOLD_PITCH = 0.05;

export class HeloLaws {
  /** Attitude and heading targets (rad), the altitude to hold (m above sea level) or null. */
  pitchTarget = 0;
  bankTarget = 0;
  headingTarget = 0;
  altitudeTarget: number | null = null;
  /** Hover hold engaged, and the point it holds (world). */
  hoverHold = false;
  readonly holdPoint = new Vec3d();
  /** Whether the helicopter is down on its gear with the collective lowered. */
  landed = true;
  /** The collective lever the layer gives (0..1). */
  collective = 0;
  /** The torque limiter held the collective back last step. */
  limited = false;
  private trimFwd = 0;
  private trimRight = 0;
  private yawTrim = 0;
  private velIFwd = 0;
  private velIRight = 0;
  /**
   * The attitude that points the sum of the rotors', fins' and fuselage's forces straight up
   * (rad), filtered over a second: the trim attitude for no horizontal acceleration.
   */
  private trimPitch = 0;
  private trimBank = 0;
  private rest = 0;
  private readonly scratch = {
    fwd: new Vec3d(),
    right: new Vec3d(),
    up: new Vec3d(),
    n: new Vec3d(),
  };

  /**
   * Starts over from the helicopter's present state (a spawn or a handback); `grounded`
   * says whether it stands on its gear (before a step the gear carries no load yet).
   */
  reset(m: RotorcraftModel, grounded = m.onGround): void {
    m.updateAttitude();
    const t = m.telemetry;
    // On the ground, the pitch that hovers: the shaft's forward tilt, nose up.
    // On the ground, or hovering at a start, the pitch that hovers: the shaft's forward tilt.
    const slow = Math.hypot(t.groundSpeed, t.verticalSpeed) < 2;
    this.pitchTarget = grounded || slow ? m.spec.main.shaftTilt : t.pitch;
    this.bankTarget = 0;
    this.headingTarget = t.heading;
    this.altitudeTarget = grounded ? null : t.altitude;
    this.hoverHold = false;
    this.holdPoint.copy(m.pos);
    this.landed = grounded;
    // In the air, the collective that holds the present weight; on the gear, down.
    this.collective = grounded ? 0 : invertMonotone((x) => m.thrustFor(x), m.mass * G, 0, 1);
    this.trimFwd = this.trimRight = this.yawTrim = 0;
    this.velIFwd = this.velIRight = 0;
    this.trimPitch = m.spec.main.shaftTilt;
    this.trimBank = 0;
    this.rest = 0;
  }

  /** Writes the controls for one step of `dt` s into `out`. */
  update(
    m: RotorcraftModel,
    cmd: Readonly<HeloCommand>,
    a: Readonly<Assists>,
    dt: number,
    out: RotorControls,
  ): void {
    const spec = m.spec;
    const tel = m.telemetry;
    const sc = this.scratch;
    const up = sc.up.copy(m.pos).normalize();
    const psi = tel.heading;
    const { east, north } = eastNorth(up);
    const fwd = sc.fwd.copy(north).scale(Math.cos(psi)).addScaled(east, Math.sin(psi));
    const right = sc.right.copy(fwd).cross(up);
    const vf = m.vel.dot(fwd);
    const vr = m.vel.dot(right);
    const vs = m.vel.dot(up);
    const gs = Math.hypot(vf, vr);
    const w = smoothstep(spec.controls.hoverSpeed, spec.controls.turnSpeed, gs);
    const onGround = tel.wow > 0.3;

    // ---- Pilot's targets ----
    const mouseMoving = Math.abs(cmd.mousePitch) + Math.abs(cmd.mouseTurn) > 1e-5;
    if (cmd.toggleHover) {
      this.hoverHold = !this.hoverHold;
      if (this.hoverHold) this.engageHold(m);
    }
    if (this.hoverHold && (Math.abs(cmd.mousePitch) > 1e-5 || Math.abs(cmd.lateral) > 0.05)) {
      // The pilot takes the cyclic: carry on from the attitude the hold flew.
      this.hoverHold = false;
      this.pitchTarget = tel.pitch;
    }
    if (this.landed && onGround) this.pitchTarget = this.trimPitch;
    this.pitchTarget += cmd.mousePitch;
    this.headingTarget = wrap(this.headingTarget + cmd.mouseTurn * (1 - w));
    this.bankTarget += cmd.mouseTurn * w + cmd.lateral * w * 0.5 * dt;
    // Out of the turn regime the bank target eases back to level.
    this.bankTarget -= this.bankTarget * (1 - w) * Math.min(1, dt / 0.8);
    if (a.maxPitch !== null) this.pitchTarget = clamp(this.pitchTarget, -a.maxPitch, a.maxPitch);
    if (a.maxBank !== null) this.bankTarget = clamp(this.bankTarget, -a.maxBank, a.maxBank);

    // Hover hold engages by itself when slow and let go (Assisted).
    const inputs = mouseMoving || Math.abs(cmd.lateral) > 0.05 || Math.abs(cmd.pedals) > 0.05;
    this.rest = inputs ? 0 : this.rest + dt;
    // Not while the pitch target asks to accelerate.
    const nearTrim = Math.abs(this.pitchTarget - this.trimPitch) < HOLD_PITCH;
    if (
      a.autoHoverHold &&
      !this.hoverHold &&
      !onGround &&
      gs < HOLD_SPEED &&
      this.rest > HOLD_REST &&
      nearTrim
    )
      this.engageHold(m);

    // ---- The trim attitude: the body forces' resultant pointing up ----
    const f = tel.aero;
    if (-f.z > 0.3 * m.mass * G) {
      const k = Math.min(1, dt / TRIM_FILTER);
      this.trimPitch += (Math.atan2(f.x, -f.z) - this.trimPitch) * k;
      this.trimBank += (Math.atan2(-f.y, -f.z) - this.trimBank) * k;
    }

    // ---- Horizontal: the attitude to fly ----
    let pitchCmd = this.pitchTarget;
    let bankCmd = this.bankTarget;
    if (this.hoverHold || 1 - w > 0) {
      // A velocity loop in the heading frame: hover hold flies to its point; otherwise the
      // lateral axis holds the sideways speed A/D ask for (none: drift correction).
      let vfCmd = vf;
      let vrCmd = cmd.lateral * spec.controls.maxSideSpeed;
      if (this.hoverHold) {
        const d = sc.n.copy(this.holdPoint).sub(m.pos);
        d.addScaled(up, -d.dot(up));
        vfCmd = clamp(HOLD_POS * d.dot(fwd), -3, 3);
        vrCmd = clamp(HOLD_POS * d.dot(right), -3, 3);
      }
      const af = clamp(HOLD_VEL * (vfCmd - vf), -2.5, 2.5);
      const ar = clamp(HOLD_VEL * (vrCmd - vr), -2.5, 2.5);
      // Hover hold trims out what the trim attitude misses, integrating only small errors
      // (a commanded sideways move would wind it up).
      if (!onGround && this.hoverHold) {
        if (Math.abs(vfCmd - vf) < 1)
          this.velIFwd = clamp(this.velIFwd + HOLD_I * (vfCmd - vf) * dt, -0.05, 0.05);
        if (Math.abs(vrCmd - vr) < 1)
          this.velIRight = clamp(this.velIRight + HOLD_I * (vrCmd - vr) * dt, -0.05, 0.05);
      }
      const holdPitch = this.trimPitch - af / G - this.velIFwd;
      const holdBank = this.trimBank + ar / G + this.velIRight;
      if (this.hoverHold) {
        pitchCmd = holdPitch;
        this.pitchTarget = tel.pitch;
        bankCmd = holdBank;
      } else {
        bankCmd = (1 - w) * holdBank + w * this.bankTarget;
      }
    }
    if (a.protection === 'on') {
      // Speed protection: past 85% of the never-exceed speed the nose comes up (a retreating
      // blade stall's warning comes with H4).
      const over = tel.tas - 0.85 * spec.limits.vne;
      if (over > 0) {
        pitchCmd += (1.5 * over) / spec.limits.vne;
      }
      // Power protection: on the torque limit and losing the altitude it holds, ease the nose up.
      if (this.limited && this.altitudeTarget !== null && this.altitudeTarget - tel.altitude > 5)
        this.pitchTarget += 0.03 * dt;
    }
    if (a.maxPitch !== null) pitchCmd = clamp(pitchCmd, -a.maxPitch, a.maxPitch);
    if (a.maxBank !== null) bankCmd = clamp(bankCmd, -a.maxBank, a.maxBank);

    // ---- Cyclic: attitude → angular acceleration → moment → disc tilt ----
    const [ixx, iyy] = spec.inertia;
    const cp = Math.max(
      m.controlPower,
      0.3 * (spec.main.hubStiffness + m.mass * G * -m.main.hub.z),
    );
    const eP = pitchCmd - tel.pitch;
    const eB = wrap(bankCmd - tel.bank);
    const air = clamp(1 - tel.wow * 2, 0, 1);
    if (air > 0.5) {
      // Integrated attitude error (rad·s), held within what 0.3 rad of error would ask.
      this.trimFwd = clamp(this.trimFwd + eP * dt, -0.3 / TRIM_GAIN, 0.3 / TRIM_GAIN);
      this.trimRight = clamp(this.trimRight + eB * dt, -0.3 / TRIM_GAIN, 0.3 / TRIM_GAIN);
    } else {
      this.trimFwd *= 1 - Math.min(1, dt / 0.5);
      this.trimRight *= 1 - Math.min(1, dt / 0.5);
    }
    const w2 = ATTITUDE_W * ATTITUDE_W;
    const aq = w2 * (eP + TRIM_GAIN * this.trimFwd) - 2 * ATTITUDE_Z * ATTITUDE_W * m.omega.y;
    const ap = w2 * (eB + TRIM_GAIN * this.trimRight) - 2 * ATTITUDE_Z * ATTITUDE_W * m.omega.x;
    // The disc lags the body's rates by the flapping time constant (the rotor's own damping):
    // command that lag away, so the loop's damping is the one designed.
    const tau = 16 / (spec.main.lock * Math.max(1, m.rotorOmega));
    const tiltF = (-iyy * aq) / cp - tau * m.omega.y;
    const tiltR = (ixx * ap) / cp + tau * m.omega.x;
    out.cyclicLon = clamp((air * tiltF) / spec.main.cyclic[0], -1, 1);
    out.cyclicLat = clamp((air * tiltR) / spec.main.cyclic[1], -1, 1);

    // ---- Pedals: heading hold in the hover, coordination at speed, the torque's trim ----
    const rmax = spec.controls.maxYawRate;
    if (onGround && this.landed) this.headingTarget = psi;
    this.headingTarget = wrap(this.headingTarget + cmd.pedals * rmax * (1 - w) * dt);
    if (w > 0.5) this.headingTarget = psi;
    const rHover =
      clamp(YAW_GAIN * wrap(this.headingTarget - psi), -rmax, rmax) + cmd.pedals * rmax;
    const v = Math.max(tel.tas, 10);
    const rTurn = a.turnCoordination
      ? (G * Math.tan(clamp(tel.bank, -1.2, 1.2))) / v + 2 * tel.beta + cmd.pedals * rmax * 0.5
      : cmd.pedals * rmax * 0.5;
    const rDes = (1 - w) * rHover + w * rTurn;
    const izz = spec.inertia[2];
    const mzWant = izz * YAW_RATE_GAIN * (rDes - m.omega.z);
    if (a.pedalTrim) {
      // The tail thrust that gives the yaw moment wanted against the main rotor's torque.
      const n = m.discNormal(sc.n);
      const q = (tel.torque * spec.engine.transmission) / spec.main.speed;
      const react = -spec.main.direction * q * n.z;
      const arm = m.tail.hub.clone().cross(m.tailAxisBody).z;
      // An integrator on the yaw rate's error takes up what the feedforward misses (fin, inflow).
      if (!this.landed) {
        const cap = 0.3 * Math.abs(q) + 0.05 * izz;
        this.yawTrim = clamp(this.yawTrim + izz * (rDes - m.omega.z) * dt, -cap, cap);
      }
      const want = (mzWant + this.yawTrim - react) / arm;
      out.pedals = invertMonotone((p) => m.tailThrustFor(p), want, -1, 1);
    } else {
      out.pedals = clamp(cmd.pedals, -1, 1);
    }

    // ---- Collective ----
    if (a.collective === 'climb-rate') {
      let vsCmd: number;
      if (Math.abs(cmd.collective) > 0.05) {
        vsCmd = cmd.collective * spec.controls.maxClimbRate;
        this.altitudeTarget = null;
      } else {
        if (this.altitudeTarget === null && !onGround) this.altitudeTarget = tel.altitude;
        vsCmd =
          this.altitudeTarget === null
            ? 0
            : clamp(ALT_GAIN * (this.altitudeTarget - tel.altitude), -2, 2);
      }
      if (a.landingAid && vsCmd < 0)
        vsCmd = Math.max(vsCmd, -Math.max(0.5, 0.3 * tel.radarAltitude));
      // Down on the gear: with S held any contact lands it (a running landing carries
      // the weight on the rotor for a while); let go, it lands once the gear carries it.
      const down = m.onGround && cmd.collective < -0.05;
      if ((onGround && cmd.collective <= 0.05 && vsCmd <= 0.05) || down) {
        // Down on the gear: the collective goes down and stays there.
        this.landed = true;
        this.altitudeTarget = null;
        this.collective = Math.max(0, this.collective - 0.6 * dt);
      } else {
        if (this.landed && vsCmd > 0.1) this.landed = false;
        if (!this.landed) {
          const az = clamp(CLIMB_GAIN * (vsCmd - vs), -3, 3);
          const n = m.discNormal(sc.n);
          const nUp = Math.max(0.3, m.q.rotate(n, new Vec3d()).dot(up));
          const want = (m.mass * (G + az)) / nUp;
          let c = invertMonotone((x) => m.thrustFor(x), want, 0, 1);
          // The torque limiter keeps the torque under the transmission's limit and the power
          // within what the engine gives, and backs the collective off if the rotor droops: a
          // drooping rotor takes the tail rotor's authority with it.
          if (a.torqueLimiter) {
            const atLimit = tel.power >= 0.99 * tel.powerAvailable;
            const over = Math.max(
              tel.torque - 1,
              atLimit ? 0.97 - tel.rotorSpeed : 0,
              0.93 - tel.rotorSpeed,
            );
            this.limited = over > -0.02 && c > this.collective;
            if (over > 0) c = Math.min(c, this.collective - 2 * over * dt);
          }
          this.collective += clamp(c - this.collective, -0.8 * dt, 0.6 * dt);
        }
      }
    } else {
      this.collective = clamp(this.collective + cmd.collective * 0.4 * dt, 0, 1);
      this.landed = onGround && this.collective < 0.2;
    }
    out.collective = this.collective;
    out.brake = cmd.brake;
    out.parkingBrake = cmd.parkingBrake;
  }

  private engageHold(m: RotorcraftModel): void {
    this.hoverHold = true;
    this.holdPoint.copy(m.pos);
    this.headingTarget = m.telemetry.heading;
    this.velIFwd = 0;
    this.velIRight = 0;
  }
}

/** The x in [lo, hi] where the monotone function f reaches `target` (bisection; clamped at the ends). */
export function invertMonotone(
  f: (x: number) => number,
  target: number,
  lo: number,
  hi: number,
): number {
  const flo = f(lo);
  const fhi = f(hi);
  const rising = fhi >= flo;
  if (rising ? target <= flo : target >= flo) return lo;
  if (rising ? target >= fhi : target <= fhi) return hi;
  let a = lo;
  let b = hi;
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (a + b);
    const v = f(mid);
    if (v < target === rising) a = mid;
    else b = mid;
  }
  return 0.5 * (a + b);
}
