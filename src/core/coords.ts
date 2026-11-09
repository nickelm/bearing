/**
 * Planet coordinate systems.
 *
 * World frame: planet-centered Cartesian, meters, float64.
 *   +Y passes through the north pole.
 *   +Z passes through latitude 0, longitude 0.
 *   +X passes through latitude 0, longitude 90° E.
 * The frame is right-handed. Seen from above the north pole, east (increasing
 * longitude) is counterclockwise, as on Earth.
 *
 * Geodetic: latitude and longitude in radians, altitude in meters above the
 * reference sphere of radius R. The planet is a sphere; terrain height is data
 * stored on top of it, not part of the reference shape.
 *
 * Cube faces: six faces indexed 0..5 = +X, -X, +Y, -Y, +Z, -Z. Each face has
 * (u, v) in [0, 1]². Viewed from outside the planet, u runs right and v runs up,
 * so uAxis × vAxis = normal. Faces use the equi-angular warp,
 * s' = tan(π/4 · s) with s = 2u - 1. Equal steps in u then cover roughly equal
 * angles, so texels stay close to equal in area across a face, which matters
 * for the baked maps. See docs/decisions.md.
 */
import { PLANET_RADIUS } from './units';
import type { Meters, Radians } from './units';
import { Vec3d } from './vec3d';

export const CubeFace = {
  PosX: 0,
  NegX: 1,
  PosY: 2,
  NegY: 3,
  PosZ: 4,
  NegZ: 5,
} as const;
export type CubeFace = (typeof CubeFace)[keyof typeof CubeFace];

export const CUBE_FACE_COUNT = 6;

export interface CubeFaceFrame {
  readonly normal: Readonly<Vec3d>;
  readonly uAxis: Readonly<Vec3d>;
  readonly vAxis: Readonly<Vec3d>;
}

/** Orientation of each cube face. Indexed by CubeFace. Do not reorder: baked maps depend on it. */
export const CUBE_FACES: readonly CubeFaceFrame[] = [
  { normal: new Vec3d(1, 0, 0), uAxis: new Vec3d(0, 0, -1), vAxis: new Vec3d(0, 1, 0) },
  { normal: new Vec3d(-1, 0, 0), uAxis: new Vec3d(0, 0, 1), vAxis: new Vec3d(0, 1, 0) },
  { normal: new Vec3d(0, 1, 0), uAxis: new Vec3d(1, 0, 0), vAxis: new Vec3d(0, 0, -1) },
  { normal: new Vec3d(0, -1, 0), uAxis: new Vec3d(1, 0, 0), vAxis: new Vec3d(0, 0, 1) },
  { normal: new Vec3d(0, 0, 1), uAxis: new Vec3d(1, 0, 0), vAxis: new Vec3d(0, 1, 0) },
  { normal: new Vec3d(0, 0, -1), uAxis: new Vec3d(-1, 0, 0), vAxis: new Vec3d(0, 1, 0) },
];

export interface Geodetic {
  lat: Radians;
  lon: Radians;
  alt: Meters;
}

export interface CubeFaceUv {
  face: CubeFace;
  u: number;
  v: number;
}

const QUARTER_PI = Math.PI / 4;

/** Unit direction for a latitude and longitude. */
export function latLonToDirection(lat: Radians, lon: Radians, out = new Vec3d()): Vec3d {
  const c = Math.cos(lat);
  return out.set(c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon));
}

/** Planet-centered Cartesian position for a geodetic position. */
export function geodeticToCartesian(
  lat: Radians,
  lon: Radians,
  alt: Meters,
  radius: Meters = PLANET_RADIUS,
  out = new Vec3d(),
): Vec3d {
  return latLonToDirection(lat, lon, out).scale(radius + alt);
}

/**
 * Geodetic position for a planet-centered Cartesian position. Longitude is in
 * (-π, π]. At the planet center the result is lat 0, lon 0, alt -R.
 */
export function cartesianToGeodetic(
  p: Readonly<Vec3d>,
  radius: Meters = PLANET_RADIUS,
  out: Geodetic = { lat: 0, lon: 0, alt: 0 },
): Geodetic {
  const r = p.length();
  out.alt = r - radius;
  if (r === 0) {
    out.lat = 0;
    out.lon = 0;
    return out;
  }
  out.lat = Math.asin(Math.min(1, Math.max(-1, p.y / r)));
  out.lon = Math.atan2(p.x, p.z);
  return out;
}

/** Unit direction for a point on a cube face. u and v are in [0, 1]. */
export function cubeFaceUvToDirection(
  face: CubeFace,
  u: number,
  v: number,
  out = new Vec3d(),
): Vec3d {
  const f = CUBE_FACES[face];
  const su = Math.tan(QUARTER_PI * (2 * u - 1));
  const sv = Math.tan(QUARTER_PI * (2 * v - 1));
  return out
    .set(
      f.normal.x + su * f.uAxis.x + sv * f.vAxis.x,
      f.normal.y + su * f.uAxis.y + sv * f.vAxis.y,
      f.normal.z + su * f.uAxis.z + sv * f.vAxis.z,
    )
    .normalize();
}

/** Planet-centered Cartesian position for a point on a cube face at the given altitude. */
export function cubeFaceUvToCartesian(
  face: CubeFace,
  u: number,
  v: number,
  alt: Meters = 0,
  radius: Meters = PLANET_RADIUS,
  out = new Vec3d(),
): Vec3d {
  return cubeFaceUvToDirection(face, u, v, out).scale(radius + alt);
}

/** The cube face a direction falls on: the axis with the largest absolute component. */
export function directionToFace(d: Readonly<Vec3d>): CubeFace {
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  if (ax >= ay && ax >= az) return d.x >= 0 ? CubeFace.PosX : CubeFace.NegX;
  if (ay >= az) return d.y >= 0 ? CubeFace.PosY : CubeFace.NegY;
  return d.z >= 0 ? CubeFace.PosZ : CubeFace.NegZ;
}

/**
 * Cube face and (u, v) for a direction or position. The vector need not be
 * normalized but must be nonzero. On an edge or corner the face is chosen
 * deterministically by `directionToFace`.
 */
export function directionToCubeFace(
  d: Readonly<Vec3d>,
  out: CubeFaceUv = { face: CubeFace.PosX, u: 0, v: 0 },
): CubeFaceUv {
  const face = directionToFace(d);
  return projectToCubeFace(d, face, out);
}

/**
 * (u, v) of a direction projected onto a specific face. Values fall outside
 * [0, 1] when the direction lies over a neighboring face. This is useful for
 * sampling across face seams.
 */
export function projectToCubeFace(
  d: Readonly<Vec3d>,
  face: CubeFace,
  out: CubeFaceUv = { face, u: 0, v: 0 },
): CubeFaceUv {
  const f = CUBE_FACES[face];
  const dn = d.dot(f.normal);
  const su = d.dot(f.uAxis) / dn;
  const sv = d.dot(f.vAxis) / dn;
  out.face = face;
  out.u = (Math.atan(su) / QUARTER_PI + 1) / 2;
  out.v = (Math.atan(sv) / QUARTER_PI + 1) / 2;
  return out;
}

/** Great-circle distance between two directions (any length) on a sphere of the given radius. */
export function greatCircleDistance(
  a: Readonly<Vec3d>,
  b: Readonly<Vec3d>,
  radius: Meters = PLANET_RADIUS,
): Meters {
  // atan2(|a×b|, a·b) is accurate at all angles, unlike acos(a·b).
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return radius * Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), a.dot(b));
}
