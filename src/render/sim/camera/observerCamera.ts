/**
 * The observer camera (V1, decision 72): a person standing at a base or a
 * port, looking around. All state and math are float64 (Vec3d) and nothing
 * here touches Three.js, so it is testable; the scene copies the results onto
 * its camera at the origin, as with the orbit camera.
 *
 * - **Where:** over a station's spot (observerStations.ts), at an eye height
 *   above the ground from 2 m to 20 km, the simulation view's envelope.
 *   W/A/S/D move the spot within LEASH of the station, at 80 m/s near the
 *   ground and twice the eye height per second higher up, five times faster
 *   with Shift; R/F raise and lower the eye.
 * - **Looking:** a drag (either mouse button, or one or two fingers) is
 *   mouse-look: right turns right, down looks down (owner reviews: grab
 *   semantics felt inverted, with the mouse and with a finger); Q/E turn; the wheel and pinch zoom the field of view from 70° down to 5°,
 *   like binoculars.
 * - **Touch:** the on-screen stick, height slider and ×5 toggle
 *   (ui/touchControls.ts) feed `stick`, added to the keys.
 * - **Ground:** the scene sets `groundHeight`, the displayed surface under the
 *   eye, every frame; until it is known the eye stands over sea level.
 * - **Clip planes:** a near plane of a tenth of the eye height (at most 1 m,
 *   at least 0.1 m), and the far plane at the horizon plus the tallest
 *   terrain beyond it. This range needs the reversed depth buffer (main.ts).
 */
import { DEG, KM } from '../../../core/units';
import type { Meters, Radians } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import { BOOST } from '../../common/orbitCamera';
import type { CameraControls, OrbitInput } from '../../common/orbitCamera';
import { localFrame } from '../infra/infraScene';
import type { ObserverStation } from './observerStations';

/** Eye height above the ground: from standing to the simulation view's ceiling. */
export const OBSERVER_MIN_HEIGHT = 2;
export const OBSERVER_MAX_HEIGHT = 20 * KM;
/** How far the observer may roam from the station's spot (m): about the promotion bubble. */
export const OBSERVER_LEASH = 25 * KM;
/** Vertical field of view: widest and narrowest (binoculars). */
export const OBSERVER_MAX_FOV = 70 * DEG;
export const OBSERVER_MIN_FOV = 5 * DEG;
export const OBSERVER_DEFAULT_FOV = 45 * DEG;
const MAX_PITCH = 85 * DEG;

export class ObserverCamera implements CameraControls {
  readonly input: OrbitInput = { forward: 0, right: 0, turn: 0, climb: 0 };
  /** The on-screen controls on touch screens (ui/touchControls.ts), added to the keys. */
  readonly stick = { forward: 0, right: 0, climb: 0, boost: 0 };
  station: ObserverStation | null = null;
  /** Unit direction of the spot the observer stands over. */
  readonly spot = new Vec3d(0, 0, 1);
  /** Eye height above the ground (m). */
  height: Meters = OBSERVER_MIN_HEIGHT;
  /** Compass direction the observer faces (0 = north, π/2 = east). */
  heading: Radians = 0;
  /** Up from the horizon (negative looks down). */
  pitch: Radians = 0;
  /** Vertical field of view (rad). */
  fov: Radians = OBSERVER_DEFAULT_FOV;

  /** Displayed ground height under the eye, if known (set each frame by the scene). */
  groundHeight: Meters | null = null;
  /** Highest displayed terrain (m), for the far plane. */
  terrainMaxHeight: Meters = 0;

  /** Outputs, updated by `update()`. Planet-centered world frame, float64. */
  readonly eye = new Vec3d();
  readonly forward = new Vec3d();
  readonly up = new Vec3d();
  near: Meters = 1;
  far: Meters = 1;

  private readonly east = new Vec3d();
  private readonly north = new Vec3d();

  constructor(readonly radius: Meters) {
    this.update(0);
  }

  /** Stands at a station: its spot, eye height, facing and pitch; the zoom resets. */
  setStation(s: ObserverStation | null): void {
    this.station = s;
    if (!s) return;
    this.spot.copy(s.point).normalize();
    this.height = clamp(s.height, OBSERVER_MIN_HEIGHT, OBSERVER_MAX_HEIGHT);
    this.heading = wrapAngle(s.facing);
    this.pitch = s.pitch;
    this.fov = OBSERVER_DEFAULT_FOV;
    this.groundHeight = null;
    this.update(0);
  }

  /** Latitude and longitude of the spot, and the eye's altitude above the sphere (status and clock). */
  get lat(): Radians {
    return Math.asin(clamp(this.spot.y, -1, 1));
  }

  get lon(): Radians {
    return Math.atan2(this.spot.x, this.spot.z);
  }

  get altitude(): Meters {
    return Math.max(0, this.groundHeight ?? 0) + this.height;
  }

  /** As the orbit camera reports it: 0 looks straight down, π/2 at the horizon. */
  get tilt(): Radians {
    return Math.PI / 2 + this.pitch;
  }

  get heightAboveGround(): Meters {
    return this.height;
  }

  /** Walks the spot `forwardM` along the heading and `rightM` to the right, within the leash. */
  walk(forwardM: Meters, rightM: Meters): void {
    const { east, north } = localFrame(this.spot);
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    const e = (s * forwardM + c * rightM) / this.radius;
    const n = (c * forwardM - s * rightM) / this.radius;
    const next = this.spot.clone().addScaled(east, e).addScaled(north, n).normalize();
    const home = this.station?.point;
    if (home) {
      const d = Math.acos(clamp(next.dot(home), -1, 1)) * this.radius;
      if (d > OBSERVER_LEASH) {
        // Pull back onto the leash's circle around home.
        const t = OBSERVER_LEASH / d;
        next
          .scale(t)
          .addScaled(home, 1 - t)
          .normalize();
      }
    }
    this.spot.copy(next);
  }

  /**
   * Turns the head by a screen drag, as mouse-look: dragging right turns right
   * and dragging down looks down, by the angle the drag spans on screen.
   */
  drag(dxPixels: number, dyPixels: number, radPerPixel: number): void {
    // radPerPixel is for the scene camera's field of view, which follows this.fov.
    this.heading = wrapAngle(this.heading + dxPixels * radPerPixel);
    this.pitch = clamp(this.pitch - dyPixels * radPerPixel, -MAX_PITCH, MAX_PITCH);
  }

  zoomAt(factor: number): void {
    this.fov = clamp(this.fov * factor, OBSERVER_MIN_FOV, OBSERVER_MAX_FOV);
  }

  /** A two-finger twist does not turn the observer: it would jitter the heading while pinching. */
  rotateAt(): void {}

  tiltBy(dyPixels: number): void {
    this.pitch = clamp(this.pitch - dyPixels * 0.005, -MAX_PITCH, MAX_PITCH);
  }

  turnBy(dxPixels: number): void {
    this.heading = wrapAngle(this.heading + dxPixels * 0.005);
  }

  /** Wheel: positive steps widen the view. */
  zoom(steps: number): void {
    this.fov = clamp(this.fov * Math.exp(steps), OBSERVER_MIN_FOV, OBSERVER_MAX_FOV);
  }

  /** Applies keyboard input, then recomputes eye, orientation and clip planes. */
  update(dt: number): void {
    const inp = this.input;
    const st = this.stick;
    if (dt > 0) {
      // A brisk pace on the ground, faster from higher up; Shift (or ×5) for more.
      const boost = inp.boost || st.boost ? BOOST : 1;
      const speed = Math.max(80, 2 * this.height) * boost;
      const forward = clamp(inp.forward + st.forward, -1, 1);
      const right = clamp(inp.right + st.right, -1, 1);
      const climb = clamp(inp.climb + st.climb, -1, 1);
      if (forward || right) this.walk(forward * speed * dt, right * speed * dt);
      if (inp.turn) this.heading = wrapAngle(this.heading + inp.turn * 0.8 * dt);
      if (climb) {
        this.height = clamp(
          this.height * Math.exp(climb * 1.2 * dt),
          OBSERVER_MIN_HEIGHT,
          OBSERVER_MAX_HEIGHT,
        );
      }
    }
    const { east, north } = localFrame(this.spot);
    this.east.copy(east);
    this.north.copy(north);
    const r = this.radius + this.altitude;
    this.eye.copy(this.spot).scale(r);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    this.forward
      .set(0, 0, 0)
      .addScaled(this.east, cp * sh)
      .addScaled(this.north, cp * ch)
      .addScaled(this.spot, sp);
    // Camera up: the radial direction tipped back by the pitch.
    this.up
      .set(0, 0, 0)
      .addScaled(this.east, -sp * sh)
      .addScaled(this.north, -sp * ch)
      .addScaled(this.spot, cp);

    this.near = clamp(0.1 * this.height, 0.1, 1);
    const top = Math.max(0, this.terrainMaxHeight);
    const R = this.radius;
    const h = this.altitude;
    this.far = 1.05 * (Math.sqrt(h * (2 * R + h)) + Math.sqrt(top * (2 * R + top)));
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function wrapAngle(a: Radians): Radians {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}
