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
import { latLonToDirection } from '../../core/coords';
import { DEG, KM, PLANET_RADIUS } from '../../core/units';
import type { Meters, Radians } from '../../core/units';
import { Vec3d } from '../../core/vec3d';

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

/**
 * What `attachOrbitInput` drives: the debug orbit camera and the strategic camera
 * (decision 75) both implement it, so mouse, touch and keyboard behave the same.
 */
export interface CameraControls {
  readonly input: OrbitInput;
  /** Moves the ground under the cursor by a screen drag. `radPerPixel` = vertical FOV / viewport height. */
  drag(dxPixels: number, dyPixels: number, radPerPixel: number): void;
  /** Zooms by `factor` at once, keeping the ground under the screen point (`ox`, `oy`) in place. */
  zoomAt(factor: number, ox: number, oy: number, radPerPixel: number): void;
  /** Turns the view by `angle` (clockwise positive) about the screen point (`ox`, `oy`). */
  rotateAt(angle: Radians, ox: number, oy: number, radPerPixel: number): void;
  tiltBy(dyPixels: number): void;
  turnBy(dxPixels: number): void;
  /** Eased zoom: positive steps zoom out. */
  zoom(steps: number): void;
}

export class OrbitCamera implements CameraControls {
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

  /**
   * Multiplies the altitude by `factor` at once (no easing), keeping the ground
   * under the screen point (`ox`, `oy`) pixels from the viewport center in place.
   * Exact when looking straight down; close enough when tilted. Pinch zoom uses this.
   */
  zoomAt(factor: number, ox: number, oy: number, radPerPixel: number): void {
    const h0 = this.heightAboveGround;
    this.altitude = this.targetAltitude = this.clampAltitude(this.altitude * factor);
    const h1 = this.heightAboveGround;
    // A ground point at offset o moves to o·h0/h1 on screen; drag it back by o·(h0 − h1)/h1.
    const f = (h0 - h1) / h1;
    this.drag(-ox * f, -oy * f, radPerPixel);
  }

  /**
   * Rotates the view so screen content turns by `angle` (clockwise positive,
   * screen y down) about the screen point (`ox`, `oy`) from the viewport center.
   */
  rotateAt(angle: Radians, ox: number, oy: number, radPerPixel: number): void {
    this.heading = wrapAngle(this.heading - angle);
    // Content rotated about the center; move the point that left (ox, oy) back there.
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.drag(ox - (c * ox - s * oy), oy - (s * ox + c * oy), radPerPixel);
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

/** Screen-space change between two finger pairs: centroid motion, scale and rotation. */
export interface TwoFingerStep {
  /** Centroid motion in pixels. */
  dx: number;
  dy: number;
  /** New finger distance / old finger distance (> 1 when spreading). */
  scale: number;
  /** Change in the angle of the line between the fingers (clockwise positive, screen y down). */
  rotation: Radians;
  /** New centroid in the same coordinates as the inputs. */
  cx: number;
  cy: number;
}

interface Point {
  x: number;
  y: number;
}

export function twoFingerStep(a0: Point, b0: Point, a1: Point, b1: Point): TwoFingerStep {
  const cx0 = (a0.x + b0.x) / 2;
  const cy0 = (a0.y + b0.y) / 2;
  const cx = (a1.x + b1.x) / 2;
  const cy = (a1.y + b1.y) / 2;
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  // Fingers almost on top of each other give no usable scale or angle.
  const ok = d0 > 8 && d1 > 8;
  const rotation = ok
    ? wrapAngle(Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x))
    : 0;
  return { dx: cx - cx0, dy: cy - cy0, scale: ok ? d1 / d0 : 1, rotation, cx, cy };
}

/**
 * Wires mouse, touch and keyboard input on `element` to a camera (OrbitCamera or StrategicCamera).
 *
 * - Mouse: left drag moves, right (or shift) drag tilts vertically and turns
 *   horizontally, the wheel zooms.
 * - Touch: one finger drags the ground; two fingers pan, pinch-zoom and twist
 *   about their midpoint, as in map apps; three fingers dragged up or down tilt.
 * - Keys: W/A/S/D move, Q/E turn, R/F climb and descend.
 *
 * Returns a function that detaches the listeners.
 */
export function attachOrbitInput(
  element: HTMLElement,
  camera: CameraControls,
  radPerPixel: () => number,
): () => void {
  let mode: 'rotate' | 'tilt' | null = null;
  let lastX = 0;
  let lastY = 0;
  /** Active touch and pen contacts by pointer id, in client pixels. */
  const touches = new Map<number, Point>();

  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      element.setPointerCapture(e.pointerId);
      return;
    }
    mode = e.button === 2 || e.shiftKey ? 'tilt' : e.button === 0 ? 'rotate' : null;
    if (!mode) return;
    lastX = e.clientX;
    lastY = e.clientY;
    element.setPointerCapture(e.pointerId);
  };
  const onTouchMove = (e: PointerEvent) => {
    const prev = touches.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (cur.x === prev.x && cur.y === prev.y) return;
    const rpp = radPerPixel();
    if (touches.size === 1) {
      camera.drag(cur.x - prev.x, cur.y - prev.y, rpp);
    } else if (touches.size === 2) {
      let other: Point = prev;
      for (const [id, p] of touches) if (id !== e.pointerId) other = p;
      const g = twoFingerStep(prev, other, cur, other);
      const rect = element.getBoundingClientRect();
      const ox = g.cx - (rect.left + rect.width / 2);
      const oy = g.cy - (rect.top + rect.height / 2);
      camera.drag(g.dx, g.dy, rpp);
      if (g.scale !== 1) camera.zoomAt(1 / g.scale, ox, oy, rpp);
      if (g.rotation !== 0) camera.rotateAt(g.rotation, ox, oy, rpp);
    } else {
      // Three or more fingers: the centroid's vertical motion tilts.
      camera.tiltBy((cur.y - prev.y) / touches.size);
    }
    touches.set(e.pointerId, cur);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') {
      onTouchMove(e);
      return;
    }
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
    if (e.pointerType !== 'mouse') touches.delete(e.pointerId);
    else mode = null;
    if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const pixels = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
    camera.zoom(pixels * 0.0015);
  };
  const onContextMenu = (e: Event) => e.preventDefault();
  // iOS Safari fires its own pinch gestures and may zoom the page despite touch-action.
  const onGesture = (e: Event) => e.preventDefault();
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
  for (const t of GESTURE_EVENTS) element.addEventListener(t, onGesture);
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
    for (const t of GESTURE_EVENTS) element.removeEventListener(t, onGesture);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}

const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'];

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function wrapAngle(a: Radians): Radians {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}
