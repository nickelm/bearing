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
 */
import { latLonToDirection } from '../core/coords';
import { DEG, KM, PLANET_RADIUS } from '../core/units';
import type { Meters, Radians } from '../core/units';
import { Vec3d } from '../core/vec3d';

export interface OrbitCameraLimits {
  minAltitude: Meters;
  maxAltitude: Meters;
  maxTilt: Radians;
  maxLatitude: Radians;
}

export const DEFAULT_ORBIT_LIMITS: OrbitCameraLimits = {
  minAltitude: 10 * KM,
  maxAltitude: 5000 * KM,
  maxTilt: 75 * DEG,
  maxLatitude: 89.9 * DEG,
};

const WORLD_UP = new Vec3d(0, 1, 0);

export class OrbitCamera {
  lat: Radians = 30 * DEG;
  lon: Radians = 0;
  /** Current altitude above the reference sphere. */
  altitude: Meters;
  /** Altitude the zoom is easing toward. */
  targetAltitude: Meters;
  /** 0 looks straight down (nadir); positive tilts the view toward the north horizon. */
  tilt: Radians = 0;

  /** Outputs, updated by `update()`. Planet-centered world frame, float64. */
  readonly eye = new Vec3d();
  readonly forward = new Vec3d();
  readonly up = new Vec3d();
  near: Meters = 1;
  far: Meters = 1;

  /**
   * Highest displayed terrain above the reference sphere (including any
   * exaggeration). Keeps the camera above it and widens the clip range.
   */
  terrainMaxHeight: Meters = 0;

  private readonly east = new Vec3d();
  private readonly north = new Vec3d();
  private readonly radial = new Vec3d();

  constructor(
    readonly radius: Meters = PLANET_RADIUS,
    readonly limits: OrbitCameraLimits = DEFAULT_ORBIT_LIMITS,
    altitude: Meters = limits.maxAltitude,
  ) {
    this.altitude = this.targetAltitude = this.clampAltitude(altitude);
    this.update(0);
  }

  /** Rotates the globe under the camera by a screen drag. `radPerPixel` = vertical FOV / viewport height. */
  drag(dxPixels: number, dyPixels: number, radPerPixel: number): void {
    // A nadir ground point moves by (screen angle × altitude) over the ground; divide by R for arc angle.
    const k = (radPerPixel * this.altitude) / this.radius;
    this.lat = clamp(this.lat + dyPixels * k, -this.limits.maxLatitude, this.limits.maxLatitude);
    this.lon = wrapAngle(this.lon - (dxPixels * k) / Math.max(Math.cos(this.lat), 1e-3));
  }

  tiltBy(dyPixels: number): void {
    this.tilt = clamp(this.tilt - dyPixels * 0.005, 0, this.limits.maxTilt);
  }

  /** Multiplies the target altitude by exp(steps). Positive steps zoom out. */
  zoom(steps: number): void {
    this.targetAltitude = this.clampAltitude(this.targetAltitude * Math.exp(steps));
  }

  /** Eases altitude toward the zoom target and recomputes eye, orientation and clip planes. */
  update(dt: number): void {
    // Exponential approach in log space: the same feel at 10 km and 5,000 km.
    this.targetAltitude = this.clampAltitude(this.targetAltitude);
    const t = dt > 0 ? 1 - Math.exp(-dt * 12) : 1;
    this.altitude = Math.exp(
      Math.log(this.altitude) + (Math.log(this.targetAltitude) - Math.log(this.altitude)) * t,
    );

    latLonToDirection(this.lat, this.lon, this.radial);
    this.eye.copy(this.radial).scale(this.radius + this.altitude);
    this.east.copy(WORLD_UP).cross(this.radial).normalize();
    this.north.copy(this.radial).cross(this.east);

    const c = Math.cos(this.tilt);
    const s = Math.sin(this.tilt);
    this.forward.set(0, 0, 0).addScaled(this.radial, -c).addScaled(this.north, s);
    this.up.set(0, 0, 0).addScaled(this.radial, s).addScaled(this.north, c);

    // No surface point is closer than (altitude − highest terrain), so half of that is a
    // safe near plane. The farthest visible surface point is the sphere's horizon plus the
    // distance at which the tallest terrain beyond it still pokes above it.
    // TODO(M2): replace with a terrain-aware ground clamp once LOD terrain exists.
    const h = this.altitude;
    const R = this.radius;
    const t0 = Math.max(0, this.terrainMaxHeight);
    this.near = Math.max(1, 0.5 * (h - t0));
    this.far = 1.05 * (Math.sqrt(h * (2 * R + h)) + Math.sqrt(t0 * (2 * R + t0)));
  }

  /** Lowest allowed altitude: the configured minimum, but at least 2 km above the highest terrain. */
  get minAltitude(): Meters {
    return Math.max(this.limits.minAltitude, Math.max(0, this.terrainMaxHeight) + 2000);
  }

  private clampAltitude(a: Meters): Meters {
    return clamp(a, Math.min(this.minAltitude, this.limits.maxAltitude), this.limits.maxAltitude);
  }
}

/** Wires mouse input on `element` to an OrbitCamera. Returns a function that detaches the listeners. */
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
    else camera.tiltBy(dy);
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

  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('contextmenu', onContextMenu);
  return () => {
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onUp);
    element.removeEventListener('pointercancel', onUp);
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('contextmenu', onContextMenu);
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function wrapAngle(a: Radians): Radians {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}
