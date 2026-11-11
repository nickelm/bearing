/**
 * The strategic view's camera (visual-style Part II, Camera and Zoom; decision 75).
 *
 * - **Focus.** The camera orbits a focus point on the sea-level sphere (`lat`, `lon`),
 *   which stays at the screen center. Zooming changes the eye's altitude above sea
 *   level between the zoom floor and the ceiling; panning moves the focus.
 * - **Tilt follows altitude.** Straight down above `tiltStart` (about 1,500 km),
 *   easing to `maxTilt` (about 50°) at the floor with a smoothstep in log altitude.
 *   The player does not tilt by hand: right drag turns the heading (its vertical part and
 *   the three-finger tilt gesture do nothing), as do Q/E and the two-finger twist.
 * - **Geometry.** With focus F = R·n, local ahead `a` (by heading) and tilt t, the eye
 *   sits at F + ρ·d, d = n·cos t − a·sin t, where the range ρ gives the eye its
 *   altitude h: |F + ρd| = R + h, so ρ = −R cos t + √(R² cos² t + h² + 2Rh).
 *
 * All state and math are float64 (Vec3d) and Three.js-free, as in the orbit camera;
 * the scene copies the results onto a Three camera at the origin.
 */
import { latLonToDirection } from '../../core/coords';
import { DEG, KM } from '../../core/units';
import type { Meters, Radians } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import type { CameraControls, OrbitInput } from '../common/orbitCamera';

export interface StrategicCameraLimits {
  /** The zoom floor: the lowest eye altitude above sea level. */
  floor: Meters;
  /** The highest eye altitude, where the whole globe shows. */
  ceiling: Meters;
  /** Tilt at the floor. */
  maxTilt: Radians;
  /** At and above this altitude the camera looks straight down. */
  tiltStart: Meters;
  maxLatitude: Radians;
}

/** The zoom floor (Part II; tunable). */
export const STRATEGIC_FLOOR = 100 * KM;
/** The ceiling, where the full globe fills the screen. */
export const STRATEGIC_CEILING = 3000 * KM;
/** Tilt at the floor. */
export const STRATEGIC_MAX_TILT = 50 * DEG;
/** The camera looks straight down from here up (the Globe band's lower edge). */
export const STRATEGIC_TILT_START = 1500 * KM;

export const STRATEGIC_CAMERA_LIMITS: StrategicCameraLimits = {
  floor: STRATEGIC_FLOOR,
  ceiling: STRATEGIC_CEILING,
  maxTilt: STRATEGIC_MAX_TILT,
  tiltStart: STRATEGIC_TILT_START,
  maxLatitude: 89.9 * DEG,
};

/** Tilt for an eye altitude: 0 at and above `tiltStart`, `maxTilt` at and below the floor. */
export function strategicTilt(
  altitude: Meters,
  limits: StrategicCameraLimits = STRATEGIC_CAMERA_LIMITS,
): Radians {
  const lo = Math.log(limits.floor);
  const hi = Math.log(limits.tiltStart);
  const u = clamp((Math.log(Math.max(altitude, 1)) - lo) / (hi - lo), 0, 1);
  const s = u * u * (3 - 2 * u);
  return limits.maxTilt * (1 - s);
}

/** Distance from the focus to an eye at `altitude` above sea level, at tilt `tilt`. */
export function focusRange(radius: Meters, altitude: Meters, tilt: Radians): Meters {
  const c = Math.cos(tilt);
  return (
    -radius * c + Math.sqrt(radius * radius * c * c + altitude * altitude + 2 * radius * altitude)
  );
}

const WORLD_UP = new Vec3d(0, 1, 0);

export class StrategicCamera implements CameraControls {
  /** Focus point at the screen center. */
  lat: Radians = 30 * DEG;
  lon: Radians = 0;
  /** Eye altitude above sea level, and the altitude the zoom is easing toward. */
  altitude: Meters;
  targetAltitude: Meters;
  /** Compass direction of "up the screen" (0 = north, π/2 = east). */
  heading: Radians = 0;
  readonly input: OrbitInput = { forward: 0, right: 0, turn: 0, climb: 0 };

  /** Outputs, updated by `update()`. Planet-centered world frame, float64. */
  readonly eye = new Vec3d();
  readonly forward = new Vec3d();
  readonly up = new Vec3d();
  /** Current tilt (from the altitude). */
  tilt: Radians = 0;
  /** Distance from the eye to the focus. */
  range: Meters = 1;
  near: Meters = 1;
  far: Meters = 1;
  /** Highest displayed terrain above sea level (with exaggeration); widens the clip range. */
  terrainMaxHeight: Meters = 0;

  private readonly radial = new Vec3d();
  private readonly east = new Vec3d();
  private readonly north = new Vec3d();
  private readonly ahead = new Vec3d();
  private readonly side = new Vec3d();

  constructor(
    readonly radius: Meters,
    readonly limits: StrategicCameraLimits = STRATEGIC_CAMERA_LIMITS,
    altitude: Meters = limits.ceiling,
  ) {
    this.altitude = this.targetAltitude = this.clampAltitude(altitude);
    this.update(0);
  }

  /** Moves the focus over the ground: `forwardM` up the screen, `rightM` to the right. */
  move(forwardM: Meters, rightM: Meters): void {
    this.frame();
    const p = this.radial
      .clone()
      .addScaled(this.ahead, forwardM / this.radius)
      .addScaled(this.side, rightM / this.radius)
      .normalize();
    this.lat = clamp(
      Math.asin(clamp(p.y, -1, 1)),
      -this.limits.maxLatitude,
      this.limits.maxLatitude,
    );
    this.lon = wrapAngle(Math.atan2(p.x, p.z));
  }

  /**
   * Grab semantics near the screen center: a pixel spans range·radPerPixel of ground
   * across the screen, and range·radPerPixel / cos(tilt) along it (foreshortening).
   */
  drag(dxPixels: number, dyPixels: number, radPerPixel: number): void {
    const range = focusRange(this.radius, this.altitude, this.tilt);
    const k = radPerPixel * range;
    this.move((dyPixels * k) / Math.cos(this.tilt), -dxPixels * k);
  }

  /** Tilt follows the altitude; a manual tilt does nothing. */
  tiltBy(dyPixels: number): void {
    void dyPixels;
  }

  turnBy(dxPixels: number): void {
    this.heading = wrapAngle(this.heading + dxPixels * 0.005);
  }

  /**
   * Multiplies the altitude by `factor` at once, keeping the ground under the screen
   * point (`ox`, `oy`) about in place: exact at nadir, approximate while tilted (as
   * decision 60's orbit camera). Pinch zoom uses this.
   */
  zoomAt(factor: number, ox: number, oy: number, radPerPixel: number): void {
    const r0 = focusRange(this.radius, this.altitude, this.tilt);
    this.altitude = this.targetAltitude = this.clampAltitude(this.altitude * factor);
    this.tilt = strategicTilt(this.altitude, this.limits);
    const r1 = focusRange(this.radius, this.altitude, this.tilt);
    const f = (r0 - r1) / r1;
    this.drag(-ox * f, -oy * f, radPerPixel);
  }

  rotateAt(angle: Radians, ox: number, oy: number, radPerPixel: number): void {
    this.heading = wrapAngle(this.heading - angle);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.drag(ox - (c * ox - s * oy), oy - (s * ox + c * oy), radPerPixel);
  }

  /** Multiplies the target altitude by exp(steps). Positive steps zoom out. */
  zoom(steps: number): void {
    this.targetAltitude = this.clampAltitude(this.targetAltitude * Math.exp(steps));
  }

  /** Applies keyboard input and zoom easing, then recomputes tilt, eye, orientation and clip planes. */
  update(dt: number): void {
    const inp = this.input;
    if (dt > 0) {
      // Pan speed proportional to altitude: crossing the screen takes about two seconds.
      const speed = 0.6 * this.altitude;
      if (inp.forward || inp.right) this.move(inp.forward * speed * dt, inp.right * speed * dt);
      if (inp.turn) this.heading = wrapAngle(this.heading + inp.turn * 0.8 * dt);
      if (inp.climb) this.targetAltitude *= Math.exp(inp.climb * 1.2 * dt);
    }
    this.targetAltitude = this.clampAltitude(this.targetAltitude);
    const t = dt > 0 ? 1 - Math.exp(-dt * 12) : 1;
    this.altitude = this.clampAltitude(
      Math.exp(
        Math.log(this.altitude) + (Math.log(this.targetAltitude) - Math.log(this.altitude)) * t,
      ),
    );
    this.tilt = strategicTilt(this.altitude, this.limits);

    this.frame();
    const c = Math.cos(this.tilt);
    const s = Math.sin(this.tilt);
    const R = this.radius;
    const h = this.altitude;
    this.range = focusRange(R, h, this.tilt);
    // Eye = focus + range · (radial·cos t − ahead·sin t); look back at the focus.
    this.eye
      .copy(this.radial)
      .scale(R)
      .addScaled(this.radial, this.range * c)
      .addScaled(this.ahead, -this.range * s);
    this.forward.set(0, 0, 0).addScaled(this.radial, -c).addScaled(this.ahead, s);
    this.up.set(0, 0, 0).addScaled(this.radial, s).addScaled(this.ahead, c);

    // Nothing is closer than the eye's clearance over the highest terrain; the far
    // plane reaches the horizon plus the tallest terrain beyond it.
    const top = Math.max(0, this.terrainMaxHeight);
    this.near = Math.max(1, 0.1 * (h - top));
    this.far = 1.05 * (Math.sqrt(h * (2 * R + h)) + Math.sqrt(top * (2 * R + top)));
  }

  /** Local frame at the focus: radial, east, north, then ahead/side by heading. */
  private frame(): void {
    latLonToDirection(this.lat, this.lon, this.radial);
    this.east.copy(WORLD_UP).cross(this.radial).normalize();
    this.north.copy(this.radial).cross(this.east);
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    this.ahead.set(0, 0, 0).addScaled(this.north, ch).addScaled(this.east, sh);
    this.side.set(0, 0, 0).addScaled(this.east, ch).addScaled(this.north, -sh);
  }

  private clampAltitude(a: Meters): Meters {
    return clamp(a, this.limits.floor, this.limits.ceiling);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function wrapAngle(a: Radians): Radians {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}
