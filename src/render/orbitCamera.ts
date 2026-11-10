/**
 * Orbit camera for the globe view. All state and math are float64 (Vec3d);
 * nothing here touches Three.js, which keeps it testable. The scene copies
 * the results onto a Three camera that sits at the origin (camera-relative
 * rendering).
 *
 * Why not three's OrbitControls: it dollies by a factor of the distance to the
 * target (the planet center), so near the surface each wheel step moves tens
 * of kilometers. Here zoom scales *altitude*, and drag speed scales with
 * altitude, so the grabbed ground point roughly tracks the cursor at any height.
 *
 * Down low (milestone 2) the camera can fly: it keeps `minClearance` above
 * the ground under it (`groundHeight`, set by the scene from the terrain
 * tiles), turns by `heading`, tilts nearly to the horizon below 50 km, and
 * moves with the keyboard (`input`) at a speed proportional to altitude.
 */
import { latLonToDirection } from '../core/coords';
import { DEG, KM, PLANET_RADIUS } from '../core/units';
import type { Meters, Radians } from '../core/units';
import { Vec3d } from '../core/vec3d';

export interface OrbitCameraLimits {
  /** Lowest altitude above the ground under the camera (or above the highest terrain if unknown). */
  minAltitude: Meters;
  maxAltitude: Meters;
  maxTilt: Radians;
  maxLatitude: Radians;
}

export const DEFAULT_ORBIT_LIMITS: OrbitCameraLimits = {
  minAltitude: 500,
  maxAltitude: 5000 * KM,
  maxTilt: 75 * DEG,
  maxLatitude: 89.9 * DEG,
};

/** Below this altitude the camera may tilt nearly to the horizon. */
const LOW_ALTITUDE = 50 * KM;
const LOW_MAX_TILT = 87 * DEG;
/** Clearance kept above the highest terrain when the ground under the camera is unknown. */
const UNKNOWN_GROUND_CLEARANCE = 2000;

/** Keyboard flight input, each in −1..1. */
export interface OrbitInput {
  forward: number;
  right: number;
  turn: number;
  climb: number;
}

const WORLD_UP = new Vec3d(0, 1, 0);

export class OrbitCamera {
  lat: Radians = 30 * DEG;
  lon: Radians = 0;
  /** Current altitude above the reference sphere. */
  altitude: Meters;
  /** Altitude the zoom is easing toward. */
  targetAltitude: Meters;
  /** 0 looks straight down (nadir); positive tilts the view toward the horizon ahead. */
  tilt: Radians = 0;
  /** Compass direction of "ahead" (0 = north, π/2 = east). */
  heading: Radians = 0;
  readonly input: OrbitInput = { forward: 0, right: 0, turn: 0, climb: 0 };

  /** Outputs, updated by `update()`. Planet-centered world frame, float64. */
  readonly eye = new Vec3d();
  readonly forward = new Vec3d();
  readonly up = new Vec3d();
  near: Meters = 1;
  far: Meters = 1;

  /**
   * Highest displayed terrain above the reference sphere (including any
   * exaggeration). Widens the clip range, and bounds the altitude when the
   * ground under the camera is unknown.
   */
  terrainMaxHeight: Meters = 0;
  /** Displayed ground height under the camera, if known (set each frame by the scene). */
  groundHeight: Meters | null = null;

  private readonly east = new Vec3d();
  private readonly north = new Vec3d();
  private readonly radial = new Vec3d();
  private readonly ahead = new Vec3d();
  private readonly side = new Vec3d();

  constructor(
    readonly radius: Meters = PLANET_RADIUS,
    readonly limits: OrbitCameraLimits = DEFAULT_ORBIT_LIMITS,
    altitude: Meters = limits.maxAltitude,
  ) {
    this.altitude = this.targetAltitude = this.clampAltitude(altitude);
    this.update(0);
  }

  /** Steepest tilt allowed at the current altitude. */
  get maxTilt(): Radians {
    return this.altitude < LOW_ALTITUDE
      ? Math.max(this.limits.maxTilt, LOW_MAX_TILT)
      : this.limits.maxTilt;
  }

  /** Moves the camera over the ground: `forwardM` along the heading, `rightM` to the right. */
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

  /** Rotates the globe under the camera by a screen drag. `radPerPixel` = vertical FOV / viewport height. */
  drag(dxPixels: number, dyPixels: number, radPerPixel: number): void {
    // A nadir ground point moves by (screen angle × height above ground); grab semantics.
    const k = radPerPixel * this.heightAboveGround;
    this.move(dyPixels * k, -dxPixels * k);
  }

  tiltBy(dyPixels: number): void {
    this.tilt = clamp(this.tilt - dyPixels * 0.005, 0, this.maxTilt);
  }

  turnBy(dxPixels: number): void {
    this.heading = wrapAngle(this.heading + dxPixels * 0.005);
  }

  /** Multiplies the target altitude by exp(steps). Positive steps zoom out. */
  zoom(steps: number): void {
    this.targetAltitude = this.clampAltitude(this.targetAltitude * Math.exp(steps));
  }

  /** Height of the eye above the ground under it (or above sea level if unknown). */
  get heightAboveGround(): Meters {
    return Math.max(1, this.altitude - Math.max(0, this.groundHeight ?? 0));
  }

  /** Applies keyboard input and zoom easing, then recomputes eye, orientation and clip planes. */
  update(dt: number): void {
    const inp = this.input;
    if (dt > 0) {
      // Ground speed proportional to height above ground: crossing a screen takes about two seconds.
      const speed = Math.max(50, this.heightAboveGround);
      if (inp.forward || inp.right) this.move(inp.forward * speed * dt, inp.right * speed * dt);
      if (inp.turn) this.heading = wrapAngle(this.heading + inp.turn * 0.8 * dt);
      if (inp.climb) this.targetAltitude *= Math.exp(inp.climb * 1.2 * dt);
    }
    // Exponential approach in log space: the same feel at 500 m and 5,000 km.
    this.targetAltitude = this.clampAltitude(this.targetAltitude);
    const t = dt > 0 ? 1 - Math.exp(-dt * 12) : 1;
    this.altitude = Math.exp(
      Math.log(this.altitude) + (Math.log(this.targetAltitude) - Math.log(this.altitude)) * t,
    );
    // Never below the ground clamp, even while easing.
    this.altitude = Math.max(this.altitude, this.minAltitude);
    this.tilt = clamp(this.tilt, 0, this.maxTilt);

    this.frame();
    this.eye.copy(this.radial).scale(this.radius + this.altitude);
    const c = Math.cos(this.tilt);
    const s = Math.sin(this.tilt);
    this.forward.set(0, 0, 0).addScaled(this.radial, -c).addScaled(this.ahead, s);
    this.up.set(0, 0, 0).addScaled(this.radial, s).addScaled(this.ahead, c);

    // Near plane: a tenth of the clearance above the ground below (terrain ahead can be
    // closer than the ground below when tilted), at least 1 m. Far plane: the sphere's
    // horizon plus the distance at which the tallest terrain beyond it still shows.
    const h = this.altitude;
    const R = this.radius;
    const top = Math.max(0, this.terrainMaxHeight);
    const clearance = this.groundHeight === null ? h - top : h - Math.max(0, this.groundHeight);
    this.near = Math.max(1, 0.1 * clearance);
    this.far = 1.05 * (Math.sqrt(h * (2 * R + h)) + Math.sqrt(top * (2 * R + top)));
  }

  /** Lowest allowed altitude: `minAltitude` above the ground (2 km above the highest terrain if unknown). */
  get minAltitude(): Meters {
    if (this.groundHeight !== null) return Math.max(0, this.groundHeight) + this.limits.minAltitude;
    return Math.max(
      this.limits.minAltitude,
      Math.max(0, this.terrainMaxHeight) + UNKNOWN_GROUND_CLEARANCE,
    );
  }

  /** Local frame at the camera's lat/lon: radial, east, north, then ahead/side by heading. */
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
    return clamp(a, Math.min(this.minAltitude, this.limits.maxAltitude), this.limits.maxAltitude);
  }
}

const KEYS: Record<string, [keyof OrbitInput, number]> = {
  KeyW: ['forward', 1],
  KeyS: ['forward', -1],
  KeyD: ['right', 1],
  KeyA: ['right', -1],
  KeyE: ['turn', 1],
  KeyQ: ['turn', -1],
  KeyR: ['climb', 1],
  KeyF: ['climb', -1],
};

/**
 * Wires mouse and keyboard input on `element` to an OrbitCamera. Left drag
 * moves, right (or shift) drag tilts vertically and turns horizontally,
 * the wheel zooms; W/A/S/D move, Q/E turn, R/F climb and descend. Returns a
 * function that detaches the listeners.
 */
export function attachOrbitInput(
  element: HTMLElement,
  camera: OrbitCamera,
  radPerPixel: () => number,
): () => void {
  let mode: 'rotate' | 'tilt' | null = null;
  let lastX = 0;
  let lastY = 0;

  const onDown = (e: PointerEvent) => {
    mode = e.button === 2 || e.shiftKey ? 'tilt' : e.button === 0 ? 'rotate' : null;
    if (!mode) return;
    lastX = e.clientX;
    lastY = e.clientY;
    element.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!mode) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (mode === 'rotate') camera.drag(dx, dy, radPerPixel());
    else {
      camera.tiltBy(dy);
      camera.turnBy(dx);
    }
  };
  const onUp = (e: PointerEvent) => {
    mode = null;
    if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const pixels = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
    camera.zoom(pixels * 0.0015);
  };
  const onContextMenu = (e: Event) => e.preventDefault();
  const held = new Set<string>();
  const applyKeys = () => {
    const inp = camera.input;
    inp.forward = inp.right = inp.turn = inp.climb = 0;
    for (const code of held) {
      const k = KEYS[code];
      if (k) inp[k[0]] += k[1];
    }
  };
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (typing(e) || !(e.code in KEYS)) return;
    held.add(e.code);
    applyKeys();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    held.delete(e.code);
    applyKeys();
  };
  const onBlur = () => {
    held.clear();
    applyKeys();
  };

  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onUp);
    element.removeEventListener('pointercancel', onUp);
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function wrapAngle(a: Radians): Radians {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}
