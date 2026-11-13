/**
 * Great-circle geometry on unit directions (rule 3's frame: +Y north, +Z
 * lat 0 / lon 0, +X lon 90° E). Points are plain xyz tuples so that they stay
 * structured-cloneable in sim state and campaign data; polylines are xyz
 * interleaved arrays. Angles are radians, headings clockwise from north,
 * distances in meters on a sphere of the given radius.
 */
import type { Meters, Radians } from './units';

export type Dir = [number, number, number];

export function dot(a: Readonly<Dir>, b: Readonly<Dir>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalize(a: Readonly<Dir>): Dir {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}

/** Central angle between unit directions (rad), stable for small and large angles. */
export function centralAngle(a: Readonly<Dir>, b: Readonly<Dir>): Radians {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), dot(a, b));
}

export function arcDistance(a: Readonly<Dir>, b: Readonly<Dir>, radius: Meters): Meters {
  return centralAngle(a, b) * radius;
}

/** Point a fraction `f` of the way from a to b along the great circle. */
export function slerp(a: Readonly<Dir>, b: Readonly<Dir>, f: number): Dir {
  const w = centralAngle(a, b);
  if (w < 1e-12) return [a[0], a[1], a[2]];
  const s = Math.sin(w);
  const ka = Math.sin((1 - f) * w) / s;
  const kb = Math.sin(f * w) / s;
  return normalize([a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb]);
}

/** East and north unit tangents at p (east = Y × p; at the poles, a fixed frame). */
export function localFrame(p: Readonly<Dir>): { east: Dir; north: Dir } {
  let ex = p[2];
  let ey = 0;
  let ez = -p[0];
  let l = Math.hypot(ex, ey, ez);
  if (l < 1e-9) {
    ex = 1;
    ey = 0;
    ez = 0;
    l = 1;
  }
  const east: Dir = [ex / l, ey / l, ez / l];
  // north = p × east
  const north: Dir = normalize([
    p[1] * east[2] - p[2] * east[1],
    p[2] * east[0] - p[0] * east[2],
    p[0] * east[1] - p[1] * east[0],
  ]);
  return { east, north };
}

/** Unit tangent at p pointing along `heading` (clockwise from north). */
export function headingTangent(p: Readonly<Dir>, heading: Radians): Dir {
  const { east, north } = localFrame(p);
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return [north[0] * c + east[0] * s, north[1] * c + east[1] * s, north[2] * c + east[2] * s];
}

/** Heading (clockwise from north, 0..2π) of a tangent vector at p. */
export function tangentHeading(p: Readonly<Dir>, t: Readonly<Dir>): Radians {
  const { east, north } = localFrame(p);
  const h = Math.atan2(dot(t, east), dot(t, north));
  return h < 0 ? h + 2 * Math.PI : h;
}

/** Initial heading of the great circle from a to b (clockwise from north). */
export function initialHeading(a: Readonly<Dir>, b: Readonly<Dir>): Radians {
  const d = dot(a, b);
  return tangentHeading(a, [b[0] - a[0] * d, b[1] - a[1] * d, b[2] - a[2] * d]);
}

/** The point `distance` from p along `heading`. */
export function destination(
  p: Readonly<Dir>,
  heading: Radians,
  distance: Meters,
  radius: Meters,
): Dir {
  const t = headingTangent(p, heading);
  const w = distance / radius;
  const c = Math.cos(w);
  const s = Math.sin(w);
  return normalize([p[0] * c + t[0] * s, p[1] * c + t[1] * s, p[2] * c + t[2] * s]);
}

/** The point `distance` from a toward b (past b if longer than a→b). */
export function toward(a: Readonly<Dir>, b: Readonly<Dir>, distance: Meters, radius: Meters): Dir {
  if (centralAngle(a, b) < 1e-12) return [a[0], a[1], a[2]];
  return destination(a, initialHeading(a, b), distance, radius);
}

/** Point i of an xyz-interleaved polyline. */
export function vertex(points: ArrayLike<number>, i: number): Dir {
  return [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
}

/** Cumulative arc length at every vertex of a polyline (m); the last is its length. */
export function polylineStations(points: ArrayLike<number>, radius: Meters): Float64Array {
  const n = points.length / 3;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++)
    s[i] = s[i - 1]! + arcDistance(vertex(points, i - 1), vertex(points, i), radius);
  return s;
}

/**
 * The point at arc length `s` along a polyline (clamped to its ends), with the
 * unit tangent of travel there. `stations` from polylineStations.
 */
export function alongPolyline(
  points: ArrayLike<number>,
  stations: ArrayLike<number>,
  s: Meters,
): { point: Dir; tangent: Dir } {
  const n = stations.length;
  if (n === 1) return { point: vertex(points, 0), tangent: localFrame(vertex(points, 0)).north };
  const total = stations[n - 1]!;
  const x = Math.min(Math.max(s, 0), total);
  // Binary search for the segment holding x.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (stations[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const a = vertex(points, lo);
  const b = vertex(points, hi);
  const len = stations[hi]! - stations[lo]!;
  const f = len > 0 ? (x - stations[lo]!) / len : 0;
  const point = slerp(a, b, f);
  const d = dot(point, b);
  let tangent: Dir = [b[0] - point[0] * d, b[1] - point[1] * d, b[2] - point[2] * d];
  if (Math.hypot(tangent[0], tangent[1], tangent[2]) < 1e-12) {
    const e = dot(a, point);
    tangent = [point[0] - a[0] * e, point[1] - a[1] * e, point[2] - a[2] * e];
  }
  return { point, tangent: normalize(tangent) };
}

/** Arc length along a polyline of the vertex nearest p (a vertex search, enough for dense lines). */
export function nearestStation(
  points: ArrayLike<number>,
  stations: ArrayLike<number>,
  p: Readonly<Dir>,
): Meters {
  let best = -Infinity;
  let at = 0;
  for (let i = 0; i < stations.length; i++) {
    const d = dot(vertex(points, i), p);
    if (d > best) {
      best = d;
      at = stations[i]!;
    }
  }
  return at;
}

/**
 * The stretch [s0, s1] of a polyline, as a new polyline with its end points
 * interpolated (s0 < s1, both clamped to the line).
 */
export function subPolyline(
  points: ArrayLike<number>,
  stations: ArrayLike<number>,
  s0: Meters,
  s1: Meters,
): number[] {
  const out: number[] = [];
  const push = (p: Readonly<Dir>) => out.push(p[0], p[1], p[2]);
  push(alongPolyline(points, stations, s0).point);
  for (let i = 0; i < stations.length; i++) {
    if (stations[i]! > s0 && stations[i]! < s1) push(vertex(points, i));
  }
  push(alongPolyline(points, stations, s1).point);
  return out;
}
