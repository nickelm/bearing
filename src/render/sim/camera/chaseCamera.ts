/**
 * The chase camera (Proposal 0002, The Camera Rig; Free Flight, decision 134):
 * behind and slightly above the aircraft, attached through springs so it lags
 * rolls, pitch changes and acceleration while keeping the aircraft near the
 * center of the screen. Float64 and free of three.js, like the observer camera,
 * so it is testable; the scene copies its eye and axes onto the camera at the
 * origin.
 *
 * - **Frame.** The camera's own forward and up axes follow the aircraft's with
 *   critically damped springs (rotation lag); its up leans a third of the way
 *   toward the local vertical, so the horizon stays readable in a roll.
 * - **Distance.** The offset behind the aircraft stretches with forward
 *   acceleration through a spring (acceleration lag).
 * - **Free look.** While held, yaw and pitch offsets orbit the camera around the
 *   aircraft; released, they spring back.
 * - **Ground.** On the ground the camera lowers and closes in. It never drops
 *   below the ground: the eye stays 1.5 m above it, and samples along the line
 *   from the aircraft to the eye lift it over rising terrain.
 */
import { DEG } from '../../../core/units';
import type { Meters, Radians } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';

export interface ChaseRig {
  /** Behind and above the aircraft in flight (m). */
  distance: Meters;
  height: Meters;
  /** On the ground. */
  groundDistance: Meters;
  groundHeight: Meters;
  /** Natural frequencies (rad/s): rotation lag and distance lag. */
  rotation: number;
  stretch: number;
  /** Extra distance per m/s² of forward acceleration. */
  stretchPerAccel: number;
  /** Vertical field of view (rad). */
  fov: Radians;
}

/** The rig for fast jets: further back and looser (Proposal 0002, Per-type rigs). */
export const FAST_JET_RIG: ChaseRig = {
  distance: 19,
  height: 4.5,
  groundDistance: 14,
  groundHeight: 2.6,
  rotation: 3.5,
  stretch: 2,
  stretchPerAccel: 0.25,
  fov: 50 * DEG,
};

/** The pose the camera follows. */
export interface ChaseTarget {
  /** Aircraft reference point (world, m). */
  pos: Vec3d;
  /** Aircraft forward and up axes (world unit vectors). */
  forward: Vec3d;
  up: Vec3d;
  /** Velocity (world, m/s). */
  velocity: Vec3d;
  onGround: boolean;
}

const MIN_CLEARANCE = 1.5;
const MAX_LOOK_PITCH = 80 * DEG;

/** Critically damped spring step for a scalar. */
function spring(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const a = omega * omega * (target - x) - 2 * omega * v;
  const nv = v + a * dt;
  return [x + nv * dt, nv];
}

export class ChaseCamera {
  rig: ChaseRig = FAST_JET_RIG;
  readonly target: ChaseTarget = {
    pos: new Vec3d(0, 0, 1),
    forward: new Vec3d(1, 0, 0),
    up: new Vec3d(0, 0, 1),
    velocity: new Vec3d(),
    onGround: true,
  };
  /** Free look: offsets (rad) and whether the player holds them. */
  lookYaw = 0;
  lookPitch = 0;
  lookHeld = false;
  /** The displayed ground height at a unit direction, or null if unknown. */
  groundAt: ((d: Readonly<Vec3d>) => number | null) | null = null;
  /** Highest displayed terrain (m), for the far plane. */
  terrainMaxHeight: Meters = 0;

  /** Outputs, planet-centered world frame, float64. */
  readonly eye = new Vec3d();
  readonly forward = new Vec3d();
  readonly up = new Vec3d();
  near: Meters = 0.3;
  far: Meters = 1e5;
  fov: Radians = FAST_JET_RIG.fov;
  /** Height of the eye above the ground (m). */
  height: Meters = 0;

  private readonly camFwd = new Vec3d(1, 0, 0);
  private readonly camUp = new Vec3d(0, 0, 1);
  private readonly fwdVel = new Vec3d();
  private readonly upVel = new Vec3d();
  private dist = FAST_JET_RIG.distance;
  private distVel = 0;
  private lift = FAST_JET_RIG.height;
  private liftVel = 0;
  private lastSpeed = 0;
  private accel = 0;
  private initialized = false;

  constructor(readonly radius: Meters) {}

  /** Snaps the springs to the target, e.g. on a respawn. */
  reset(): void {
    this.initialized = false;
  }

  get lat(): Radians {
    const p = this.eye;
    return Math.asin(Math.max(-1, Math.min(1, p.y / (p.length() || 1))));
  }

  get lon(): Radians {
    return Math.atan2(this.eye.x, this.eye.z);
  }

  get altitude(): Meters {
    return this.eye.length() - this.radius;
  }

  get tilt(): Radians {
    return 0;
  }

  /** Free look by a mouse drag (pixels), `radPerPixel` = vertical FOV / viewport height. */
  look(dx: number, dy: number, radPerPixel: number): void {
    this.lookYaw += dx * radPerPixel;
    this.lookPitch = Math.max(
      -MAX_LOOK_PITCH,
      Math.min(MAX_LOOK_PITCH, this.lookPitch - dy * radPerPixel),
    );
  }

  update(dt: number): void {
    const t = this.target;
    const radial = t.pos.clone().normalize();
    const rig = this.rig;
    if (!this.initialized) {
      this.camFwd.copy(t.forward);
      this.camUp.copy(t.up);
      this.fwdVel.set(0, 0, 0);
      this.upVel.set(0, 0, 0);
      this.dist = t.onGround ? rig.groundDistance : rig.distance;
      this.lift = t.onGround ? rig.groundHeight : rig.height;
      this.distVel = 0;
      this.liftVel = 0;
      this.lastSpeed = t.velocity.length();
      this.accel = 0;
      this.initialized = true;
    }
    const h = Math.max(dt, 1e-4);
    // Forward acceleration, smoothed.
    const speed = t.velocity.length();
    const a = (speed - this.lastSpeed) / h;
    this.lastSpeed = speed;
    this.accel += (a - this.accel) * Math.min(1, dt * 3);
    // Rotation lag: critically damped springs on the camera's axes.
    const w = rig.rotation;
    for (const [x, v, target] of [
      [this.camFwd, this.fwdVel, t.forward],
      [this.camUp, this.upVel, t.up],
    ] as const) {
      const acc = target
        .clone()
        .sub(x)
        .scale(w * w)
        .addScaled(v, -2 * w);
      v.addScaled(acc, dt);
      x.addScaled(v, dt).normalize();
    }
    // Lean the camera's up toward the local vertical; re-orthonormalize.
    const f = this.camFwd.clone().normalize();
    const u = this.camUp.clone().scale(2).addScaled(radial, 1);
    u.addScaled(f, -u.dot(f)).normalize();
    // Distance and height, lower and closer on the ground.
    const dTarget =
      (t.onGround ? rig.groundDistance : rig.distance) +
      rig.stretchPerAccel * Math.max(-10, Math.min(20, this.accel));
    const hTarget = t.onGround ? rig.groundHeight : rig.height;
    [this.dist, this.distVel] = spring(this.dist, this.distVel, dTarget, rig.stretch, dt);
    [this.lift, this.liftVel] = spring(this.lift, this.liftVel, hTarget, rig.stretch, dt);
    // Free look springs back when released.
    if (!this.lookHeld) {
      const k = Math.exp(-dt / 0.25);
      this.lookYaw *= k;
      this.lookPitch *= k;
    }
    // Offset behind and above, turned by the free look about the camera's up and right.
    const right = f.clone().cross(u).normalize();
    const cy = Math.cos(this.lookYaw);
    const sy = Math.sin(this.lookYaw);
    const cp = Math.cos(this.lookPitch);
    const sp = Math.sin(this.lookPitch);
    // Direction from the aircraft to the eye.
    const back = f
      .clone()
      .scale(-cy * cp)
      .addScaled(right, -sy * cp)
      .addScaled(u, sp);
    const eye = t.pos
      .clone()
      .addScaled(back, this.dist)
      .addScaled(u, this.lift * cp);
    // Terrain: keep the eye and the line to it above the ground.
    if (this.groundAt) {
      let raise = 0;
      for (let i = 1; i <= 4; i++) {
        const p = t.pos.clone().addScaled(eye.clone().sub(t.pos), i / 4);
        const r = p.length();
        const g = this.groundAt(p.clone().scale(1 / r));
        if (g === null) continue;
        const need = this.radius + g + MIN_CLEARANCE - r;
        raise = Math.max(raise, need * (4 / i));
      }
      if (raise > 0) eye.addScaled(eye.clone().normalize(), Math.min(raise, this.dist * 2));
      const r = eye.length();
      const g = this.groundAt(eye.clone().scale(1 / r));
      this.height = r - this.radius - Math.max(0, g ?? 0);
      if (g !== null && this.height < MIN_CLEARANCE) {
        eye.scale((this.radius + g + MIN_CLEARANCE) / r);
        this.height = MIN_CLEARANCE;
      }
    } else {
      this.height = eye.length() - this.radius;
    }
    this.eye.copy(eye);
    // Look at a point a little ahead of and above the aircraft, so it sits below center.
    const aim = t.pos.clone().addScaled(f, 6).addScaled(u, 1.2);
    this.forward.copy(aim.sub(this.eye)).normalize();
    this.up.copy(u).addScaled(this.forward, -u.dot(this.forward)).normalize();
    this.fov = rig.fov;
    // Clip planes: near enough for the aircraft, far to the horizon past the tallest peaks.
    const R = this.radius;
    const alt = Math.max(2, this.altitude);
    const peak = Math.max(0, this.terrainMaxHeight);
    this.near = 0.3;
    this.far = Math.sqrt(2 * R * alt + alt * alt) + Math.sqrt(2 * R * peak + peak * peak) + 2000;
  }
}
