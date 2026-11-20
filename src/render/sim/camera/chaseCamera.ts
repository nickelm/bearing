/**
 * The chase camera (Proposal 0002, The Camera Rig; Free Flight, decision 134):
 * behind and slightly above the aircraft, attached through springs so it lags
 * rolls, pitch changes and acceleration while keeping the aircraft near the
 * center of the screen. Float64 and free of three.js, like the observer camera,
 * so it is testable; the scene copies its eye and axes onto the camera at the
 * origin.
 *
 * - **Frame.** The camera's own forward and up axes follow the aircraft's with
 *   critically damped springs (rotation lag); in flight the forward axis leans
 *   toward the velocity in the aircraft's vertical plane, so what lies along the
 *   flight path (a runway on final) shows above the aircraft, while sideways it
 *   follows the nose, so a crab or a sideslip shows the aircraft from straight
 *   behind (decision 219); its up leans a third of the way toward the local
 *   vertical, so the horizon stays readable in a roll.
 * - **Distance.** The offset behind the aircraft stretches with forward
 *   acceleration through a spring (acceleration lag).
 * - **Free look.** While held, yaw and pitch offsets orbit the camera around the
 *   aircraft; released, they spring back.
 * - **Ground.** On the ground the camera lowers and closes in. It never drops
 *   below the ground: the eye stays 1.5 m above it, and samples along the line
 *   from the aircraft to the eye lift it over rising terrain.
 * - **Helicopters** (a rig with a `hover` schedule; Proposal 0004, Camera Rig).
 *   By horizontal ground speed the pose blends from cruise, where the frame
 *   follows the nose leaning toward the velocity as for jets, to the hover, where
 *   it follows the heading (the nose flattened onto the horizontal) with its up
 *   on the local vertical, and the eye lifts and looks down at the ground under
 *   and ahead of the helicopter. The pose follows the schedule on the ground as
 *   in the air. Free look stays where it is left, at any speed, until the
 *   player recenters it (decision 160); the look point orbits with the eye, so
 *   the helicopter stays in view all the way round, and lowering the eye lifts
 *   the view toward the horizon.
 * - **Zoom.** `zoom` scales the rig's distances (the eye's and, for a
 *   helicopter, the look point's), so the framing's angles hold; 1 is the rig.
 */
import { DEG, KNOT } from '../../../core/units';
import type { Meters, Radians } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import type { RigSpec } from '../../../sim/air/bundles';
import type { Airframe } from '../../../sim/flight/airframe';

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
  /** Helicopters: the speed schedule between the hover and cruise poses; absent for fixed-wing aircraft. */
  hover?: ChaseHoverSchedule;
}

/**
 * A helicopter rig's speed schedule (Proposal 0004, Camera Rig). Speeds are
 * horizontal ground speeds, not airspeeds: the camera frames the ground, and a
 * hover over a spot in a 30 kt wind is still a hover.
 */
export interface ChaseHoverSchedule {
  /** The hover pose holds below `hoverSpeed` (m/s) and the cruise pose above `cruiseSpeed`, blended smoothly between. */
  hoverSpeed: number;
  cruiseSpeed: number;
  /** Hover pose: behind and above the aircraft (m), on the ground as in the air. */
  distance: Meters;
  height: Meters;
  /** The look point ahead of and above the aircraft (m) in the hover and in cruise. */
  hoverAim: [ahead: Meters, up: Meters];
  cruiseAim: [ahead: Meters, up: Meters];
  /**
   * In the hover the look point drops by this share of the height above the
   * ground, up to `groundLookMax` (m), so a hover higher up still shows the
   * ground point under the helicopter.
   */
  groundLook: number;
  groundLookMax: Meters;
}

/**
 * The rig for fast jets: further back and looser (Proposal 0002, Per-type rigs).
 * The camera's default; a flown type takes its rig from its bundle (`rigFromBundle`),
 * and the Kestrel's bundle holds these numbers.
 */
export const FAST_JET_RIG: ChaseRig = {
  distance: 19,
  height: 4,
  groundDistance: 14,
  groundHeight: 2.6,
  rotation: 3.5,
  stretch: 2,
  stretchPerAccel: 0.25,
  fov: 50 * DEG,
};

/**
 * The rig an aircraft bundle names (R1.7): a fast jet's numbers as given, or the
 * helicopter rig scaled by `rotorRadius` (m), the radius of its main rotor.
 */
export function rigFromBundle(rig: RigSpec, rotorRadius = 0): ChaseRig {
  if (rig.kind === 'helicopter') {
    if (!(rotorRadius > 0)) throw new Error('A helicopter rig needs the main rotor radius');
    return helicopterRig(rotorRadius);
  }
  return {
    distance: rig.distance,
    height: rig.height,
    groundDistance: rig.groundDistance,
    groundHeight: rig.groundHeight,
    rotation: rig.rotation,
    stretch: rig.stretch,
    stretchPerAccel: rig.stretchPerAccel,
    fov: rig.fov,
  };
}

/**
 * The rig for a helicopter of rotor radius `rotorRadius` (m): higher than the
 * jet's and, in the aircraft's own size, closer (3 rotor radii against the
 * jet's 4 half-spans for a 7.3 m rotor), in proportion to the rotor so every
 * type frames alike. In cruise (above 40 kt) 2.2 radii + 6 m behind and 0.45 of
 * that above, looking about 13° down; in the hover (below 10 kt) 0.85 of the
 * distance behind, lifted to 0.8 of it, and looking about 30° down, so the ground
 * under and ahead of the helicopter shows in a 60° field of view; higher hovers
 * look further down, by half the height above the ground (up to 0.6 of the
 * distance, about 40° in all), to keep the ground point in view. Free look
 * stays where it is left until recentered.
 */
export function helicopterRig(rotorRadius: Meters): ChaseRig {
  const d = 2.2 * rotorRadius + 6;
  return {
    distance: d,
    height: 0.45 * d,
    groundDistance: 0.85 * d,
    groundHeight: 0.8 * d,
    rotation: 3,
    stretch: 2,
    stretchPerAccel: 0.15,
    fov: 60 * DEG,
    hover: {
      hoverSpeed: 10 * KNOT,
      cruiseSpeed: 40 * KNOT,
      distance: 0.85 * d,
      height: 0.8 * d,
      hoverAim: [0.8 * d, -0.15 * d],
      cruiseAim: [0.9 * d, 0],
      groundLook: 0.5,
      groundLookMax: 0.6 * d,
    },
  };
}

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

/** Sets `t` from airframe `a`: its position, forward and up axes, velocity and whether it is on the ground. */
export function followAirframe(t: ChaseTarget, a: Readonly<Airframe>): void {
  t.pos.copy(a.pos);
  a.bodyAxis(0, t.forward);
  a.bodyAxis(2, t.up).scale(-1);
  t.velocity.copy(a.vel);
  t.onGround = a.onGround;
}

const MIN_CLEARANCE = 1.5;
const MAX_LOOK_PITCH = 80 * DEG;
/** The furthest a helicopter may sit from the view's axis (rad); its rig frames it within 19°. */
const MAX_OFF_AXIS = 20 * DEG;
/** The range of `zoom`, and the factor of one wheel step. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
const ZOOM_STEP = 1.12;

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * A fixed-wing rig's look point is 25 m ahead of the nose, which frames the way ahead
 * from behind; as free look turns the eye away from behind, the look point moves onto
 * the aircraft (fully at ORBIT_FULL off center), so the eye orbits the aircraft itself
 * rather than a point in front of it (owner feedback on R2.4, decision 253).
 * `cosLook` is the cosine of the angle between the eye's direction and straight behind.
 */
export const ORBIT_FULL = 45 * DEG;
export function orbitWeight(cosLook: number): number {
  const a = Math.acos(Math.max(-1, Math.min(1, cosLook)));
  return smooth(a / ORBIT_FULL);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

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
  /** Scale on the rig's distances (MIN_ZOOM..MAX_ZOOM); 1 is the rig's framing. */
  zoom = 1;
  /** The displayed ground height at a unit direction, or null if unknown. */
  groundAt: ((d: Readonly<Vec3d>) => number | null) | null = null;
  /** Highest displayed terrain (m), for the far plane. */
  terrainMaxHeight: Meters = 0;

  /** Outputs, planet-centered world frame, float64. */
  readonly eye = new Vec3d();
  readonly forward = new Vec3d();
  readonly up = new Vec3d();
  /**
   * The view the camera has with its free look centered (fixed-wing rigs): mouse aim
   * reads it, so looking around does not move where the jet flies (decision 198).
   */
  readonly restForward = new Vec3d();
  readonly restUp = new Vec3d();
  /** A fixed-wing rig's free look stays where it is left, as a helicopter's does (decision 198). */
  stickyLook = false;
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
  private agl = 0;
  private initialized = false;
  /** A helicopter's free look is easing back to center (recenter()). */
  private recentering = false;

  /** `rig` picks the type's rig: `FAST_JET_RIG`, or `helicopterRig(rotorRadius)`; reset after changing it. */
  constructor(
    readonly radius: Meters,
    rig: ChaseRig = FAST_JET_RIG,
  ) {
    this.rig = rig;
    this.fov = rig.fov;
  }

  /** The hover schedule's weight, 1 in the hover and 0 in cruise, from the horizontal ground speed (m/s). */
  static hoverWeight(s: Readonly<ChaseHoverSchedule>, groundSpeed: number): number {
    return 1 - smooth((groundSpeed - s.hoverSpeed) / (s.cruiseSpeed - s.hoverSpeed));
  }

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

  /** The view's heading (rad clockwise from north), for the map's camera on a return. */
  get heading(): Radians {
    const p = this.eye;
    const n = p.length() || 1;
    const ux = p.x / n;
    const uy = p.y / n;
    const uz = p.z / n;
    // East = Y × up, north = up × east (rule 3: +Y through the north pole).
    let ex = uz;
    let ez = -ux;
    const el = Math.hypot(ex, ez) || 1;
    ex /= el;
    ez /= el;
    const nx = uy * ez;
    const ny = uz * ex - ux * ez;
    const nz = -uy * ex;
    const f = this.forward;
    return Math.atan2(f.x * ex + f.z * ez, f.x * nx + f.y * ny + f.z * nz);
  }

  /** Free look by a mouse drag (pixels), `radPerPixel` = vertical FOV / viewport height. */
  look(dx: number, dy: number, radPerPixel: number): void {
    this.lookYaw += dx * radPerPixel;
    this.lookPitch = Math.max(
      -MAX_LOOK_PITCH,
      Math.min(MAX_LOOK_PITCH, this.lookPitch - dy * radPerPixel),
    );
  }

  /** Moves the camera closer (steps < 0) or farther (steps > 0), one wheel notch per step. */
  zoomBy(steps: number): void {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * ZOOM_STEP ** steps));
  }

  /** Eases a free look that stays where it is left (a helicopter's) back to center; a new drag cancels it. */
  recenter(): void {
    this.lookYaw = Math.atan2(Math.sin(this.lookYaw), Math.cos(this.lookYaw));
    this.recentering = true;
  }

  /** Centers free look and the zoom at once (a new sortie). */
  resetView(): void {
    this.lookYaw = this.lookPitch = 0;
    this.zoom = 1;
    this.recentering = false;
  }

  update(dt: number): void {
    const t = this.target;
    const radial = t.pos.clone().normalize();
    const rig = this.rig;
    // Helicopters: the schedule's weights from the horizontal ground speed.
    const hv = rig.hover;
    let wHover = 0;
    if (hv) {
      const groundSpeed = t.velocity.clone().addScaled(radial, -t.velocity.dot(radial)).length();
      wHover = ChaseCamera.hoverWeight(hv, groundSpeed);
    }
    // Height above the ground for the hover's look point, smoothed over half a second.
    let agl = 0;
    if (hv && this.groundAt) {
      const g = this.groundAt(radial);
      if (g !== null) agl = Math.max(0, t.pos.length() - this.radius - g);
    }
    const snap = !this.initialized;
    if (!this.initialized) {
      this.camFwd.copy(t.forward);
      this.camUp.copy(t.up);
      this.fwdVel.set(0, 0, 0);
      this.upVel.set(0, 0, 0);
      if (hv) {
        this.dist = lerp(rig.distance, hv.distance, wHover) * this.zoom;
        this.lift = lerp(rig.height, hv.height, wHover) * this.zoom;
      } else {
        this.dist = (t.onGround ? rig.groundDistance : rig.distance) * this.zoom;
        this.lift = (t.onGround ? rig.groundHeight : rig.height) * this.zoom;
      }
      this.distVel = 0;
      this.liftVel = 0;
      this.lastSpeed = t.velocity.length();
      this.accel = 0;
      this.agl = agl;
      this.initialized = true;
    }
    if (hv) this.agl += (agl - this.agl) * Math.min(1, dt * 2);
    const h = Math.max(dt, 1e-4);
    // Forward acceleration, smoothed.
    const speed = t.velocity.length();
    const a = (speed - this.lastSpeed) / h;
    this.lastSpeed = speed;
    this.accel += (a - this.accel) * Math.min(1, dt * 3);
    // In flight the frame leans toward the velocity (85% above 60 m/s): at an
    // approach's 12° of angle of attack a nose-aligned camera would put the runway,
    // which lies along the flight path, behind the airframe.
    // Helicopters lean toward the velocity as they leave the hover.
    // Only within the aircraft's own vertical plane (decision 219): sideways the frame
    // follows the nose, so a jet crabbing into a crosswind is seen straight from behind,
    // the flight path marker off to the side, as its pilot sees it, not side-on along
    // the track.
    const vw = t.onGround ? 0 : 0.85 * (hv ? 1 - wHover : smooth((speed - 30) / 30));
    const aimFwd = t.forward.clone();
    if (vw > 0 && speed > 1) {
      const side = t.forward.clone().cross(t.up);
      const ls = side.length();
      const path = t.velocity.clone();
      if (ls > 1e-9) path.addScaled(side, -path.dot(side) / (ls * ls));
      const lp = path.length();
      if (lp > 1e-9)
        aimFwd
          .scale(1 - vw)
          .addScaled(path, vw / lp)
          .normalize();
    }
    const aimUp = t.up.clone();
    if (hv && wHover > 0) {
      // Hover: the heading, with up on the local vertical; the nose's pitch and roll stay out.
      const heading = t.forward.clone().addScaled(radial, -t.forward.dot(radial));
      if (heading.lengthSq() < 1e-12)
        heading.copy(this.camFwd).addScaled(radial, -this.camFwd.dot(radial));
      if (heading.lengthSq() > 1e-12) {
        aimFwd
          .scale(1 - wHover)
          .addScaled(heading.normalize(), wHover)
          .normalize();
      }
      aimUp.scale(1 - wHover).addScaled(radial, wHover);
    }
    aimUp.addScaled(aimFwd, -aimUp.dot(aimFwd)).normalize();
    if (snap && hv) {
      this.camFwd.copy(aimFwd);
      this.camUp.copy(aimUp);
    }
    // Rotation lag: critically damped springs on the camera's axes.
    const w = rig.rotation;
    for (const [x, v, target] of [
      [this.camFwd, this.fwdVel, aimFwd],
      [this.camUp, this.upVel, aimUp],
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
    // A helicopter's pose follows the schedule instead, on the ground as in the air.
    const dTarget =
      (hv
        ? lerp(rig.distance, hv.distance, wHover)
        : t.onGround
          ? rig.groundDistance
          : rig.distance) *
        this.zoom +
      rig.stretchPerAccel * Math.max(-10, Math.min(20, this.accel));
    const hTarget =
      (hv ? lerp(rig.height, hv.height, wHover) : t.onGround ? rig.groundHeight : rig.height) *
      this.zoom;
    [this.dist, this.distVel] = spring(this.dist, this.distVel, dTarget, rig.stretch, dt);
    [this.lift, this.liftVel] = spring(this.lift, this.liftVel, hTarget, rig.stretch, dt);
    // Free look springs back when released; a helicopter's stays until recentered.
    if (this.lookHeld) this.recentering = false;
    else if ((!hv && !this.stickyLook) || this.recentering) {
      const k = Math.exp(-dt / 0.25);
      this.lookYaw *= k;
      this.lookPitch *= k;
      if (this.recentering && Math.abs(this.lookYaw) + Math.abs(this.lookPitch) < 1e-4) {
        this.lookYaw = this.lookPitch = 0;
        this.recentering = false;
      }
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
    // Look at a point well ahead of the aircraft, so it sits below the center
    // and the way ahead (a runway on approach) shows above it.
    // A helicopter's look point orbits with the free look, opposite the eye, so
    // the helicopter stays in view all the way round and a lowered eye looks up
    // toward the horizon; in the hover it drops with the height above the ground.
    // It rises only as far as the eye really went down: where the ground held a
    // lowered eye up, the full rise tipped the view into the sky and lost the
    // helicopter (decision 160's review).
    const ahead = hv ? lerp(hv.cruiseAim[0], hv.hoverAim[0], wHover) * this.zoom : 0;
    let spAim = sp;
    if (hv && sp < 0 && this.dist > 1e-6) {
      const reached = (eye.clone().sub(t.pos).dot(u) - this.lift * cp) / this.dist;
      spAim = Math.min(0, Math.max(sp, reached));
    }
    const aim = hv
      ? t.pos
          .clone()
          .addScaled(f, cy * cp * ahead)
          .addScaled(right, sy * cp * ahead)
          .addScaled(
            u,
            (lerp(hv.cruiseAim[1], hv.hoverAim[1], wHover) -
              wHover * Math.min(hv.groundLookMax, hv.groundLook * this.agl)) *
              this.zoom -
              spAim * ahead,
          )
      : t.pos
          .clone()
          .addScaled(f, 25 * (1 - orbitWeight(cy * cp)))
          .addScaled(u, 1 - orbitWeight(cy * cp));
    this.forward.copy(aim.sub(this.eye)).normalize();
    // A helicopter stays in the picture: where the ground holds a dragged-down
    // eye close under it, no look point keeps the orbit's framing, so the view
    // turns toward the helicopter until it sits MAX_OFF_AXIS off the axis. The
    // rig's own framing keeps it within 19°, so this acts only there.
    if (hv) {
      const toCraft = t.pos.clone().sub(this.eye).normalize();
      const cos = toCraft.dot(this.forward);
      if (cos < Math.cos(MAX_OFF_AXIS)) {
        const side = this.forward.clone().addScaled(toCraft, -cos);
        if (side.lengthSq() > 1e-12) {
          side.normalize();
          this.forward
            .copy(toCraft)
            .scale(Math.cos(MAX_OFF_AXIS))
            .addScaled(side, Math.sin(MAX_OFF_AXIS));
        } else {
          this.forward.copy(toCraft);
        }
      }
    }
    this.up.copy(u).addScaled(this.forward, -u.dot(this.forward)).normalize();
    // The same view with the look centered: eye behind and above, look point 25 m ahead.
    this.restForward
      .copy(f)
      .scale(25 + this.dist)
      .addScaled(u, 1 - this.lift)
      .normalize();
    this.restUp.copy(u).addScaled(this.restForward, -u.dot(this.restForward)).normalize();
    this.fov = rig.fov;
    // Clip planes: near enough for the aircraft, far to the horizon past the tallest peaks.
    const R = this.radius;
    const alt = Math.max(2, this.altitude);
    const peak = Math.max(0, this.terrainMaxHeight);
    this.near = 0.3;
    this.far = Math.sqrt(2 * R * alt + alt * alt) + Math.sqrt(2 * R * peak + peak * peak) + 2000;
  }
}
