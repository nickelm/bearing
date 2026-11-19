/**
 * Moving a focus over the sphere without a pole (decision 246). Cameras that
 * keep their position as latitude, longitude and a compass heading used to
 * step in the local east/north frame and clamp the latitude short of the pole:
 * near it, the frame turns with longitude, so the screen spun under a small
 * drag and a pan over the pole stopped dead. Here the focus moves along a
 * great circle and "up the screen" is carried along it (parallel transport),
 * so the picture moves as one sheet wherever it is, over the pole included;
 * the heading is read back from the carried direction afterwards.
 */
import type { Radians } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import { latLonToDirection } from '../../core/coords';

/** Closest approach to a pole (rad of latitude), where east and north still exist. */
const POLE_GUARD = 1e-9;

const WORLD_UP = new Vec3d(0, 1, 0);
const n = new Vec3d();
const east = new Vec3d();
const north = new Vec3d();
const ahead = new Vec3d();
const side = new Vec3d();
const u = new Vec3d();
const p = new Vec3d();
const u2 = new Vec3d();
const a2 = new Vec3d();

export interface SpherePlace {
  lat: Radians;
  lon: Radians;
  /** Compass direction of "up the screen" (0 = north, π/2 = east). */
  heading: Radians;
}

/** East and north at a unit direction (left in `east`, `north`); a pole is nudged off first. */
function localFrame(dir: Vec3d, e: Vec3d, nn: Vec3d): void {
  e.copy(WORLD_UP).cross(dir);
  if (e.length() < 1e-12) e.set(1, 0, 0);
  e.normalize();
  nn.copy(dir).cross(e);
}

/**
 * Moves `place` by `forward` meters up the screen and `right` meters to the
 * right on a sphere of `radius`, in place.
 */
export function moveOnSphere(place: SpherePlace, forward: number, right: number, radius: number): void {
  latLonToDirection(place.lat, place.lon, n);
  localFrame(n, east, north);
  const ch = Math.cos(place.heading);
  const sh = Math.sin(place.heading);
  ahead.set(0, 0, 0).addScaled(north, ch).addScaled(east, sh);
  side.set(0, 0, 0).addScaled(east, ch).addScaled(north, -sh);
  u.set(0, 0, 0).addScaled(ahead, forward).addScaled(side, right);
  const dist = u.length();
  if (!(dist > 0)) return;
  u.scale(1 / dist);
  const theta = dist / radius;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // New focus along the great circle, and the direction of travel there.
  p.copy(n).scale(c).addScaled(u, s).normalize();
  u2.copy(n).scale(-s).addScaled(u, c);
  // Carry "ahead": its part along the travel turns with it; the rest stays.
  const along = ahead.dot(u);
  a2.copy(ahead).addScaled(u, -along).addScaled(u2, along);

  const lat = Math.asin(Math.max(-1, Math.min(1, p.y)));
  const limit = Math.PI / 2 - POLE_GUARD;
  place.lat = Math.max(-limit, Math.min(limit, lat));
  place.lon = wrapAngle(Math.atan2(p.x, p.z));
  latLonToDirection(place.lat, place.lon, p);
  localFrame(p, east, north);
  place.heading = wrapAngle(Math.atan2(a2.dot(east), a2.dot(north)));
}

function wrapAngle(a: Radians): Radians {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}
