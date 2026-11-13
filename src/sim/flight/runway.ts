/**
 * Runways for Free Flight (decision 134): one per airbase, from the airbase's
 * coarse-pass record (center, heading, length) and its graded pad's elevation
 * (decision 108). The width is the infrastructure's 45 m.
 *
 * Coordinates in a runway's frame: `along` (m from the center, positive along
 * the runway's heading), `across` (m, positive to the right of the heading) and
 * `height` above the field elevation, all in the tangent plane at the center,
 * which is accurate to centimeters over a runway's few kilometers.
 */
import { DEG } from '../../core/units';
import { Vec3d } from '../../core/vec3d';

export const RUNWAY_WIDTH_M = 45;
/** Overruns counted as runway for outcomes (graded, past each end; m). */
export const RUNWAY_OVERRUN = 200;
/** Touchdown zone: from this far past the threshold to that far (m). */
export const TOUCHDOWN_ZONE: readonly [number, number] = [150, 900];
/** Glide path angle (rad) and its aim point past the threshold (m). */
export const GLIDE_PATH = 3 * DEG;
export const AIM_POINT = 300;

export interface Runway {
  /** The airbase's id. */
  id: number;
  name: string;
  side: 'alliance' | 'pact';
  /** Unit direction of the runway's center. */
  center: Vec3d;
  /** Heading of the runway's axis, radians clockwise from north (0..π). */
  heading: number;
  length: number;
  width: number;
  /** Field elevation (m above sea level): the graded pad's. */
  elevation: number;
}

export interface RunwayEnd {
  /** Landing heading (rad, clockwise from north). */
  heading: number;
  /** Two-digit designator, "09" or "27". */
  designator: string;
  /** Sign of the landing direction along the runway axis (+1 lands toward +along). */
  sign: 1 | -1;
  /** `along` of the threshold (m). */
  threshold: number;
}

export interface RunwayFrame {
  /** Unit tangents at the center: along the heading, and to its right; unit up. */
  fwd: Vec3d;
  right: Vec3d;
  up: Vec3d;
}

/** Local east and north unit vectors at a unit direction. */
export function eastNorth(p: Readonly<Vec3d>): { east: Vec3d; north: Vec3d } {
  const east = new Vec3d(0, 1, 0).cross(p);
  if (east.length() < 1e-9) east.set(1, 0, 0);
  east.normalize();
  const north = new Vec3d(p.x, p.y, p.z).cross(east);
  return { east, north };
}

/** The unit tangent at unit direction `p` pointing along compass `heading`. */
export function headingVector(p: Readonly<Vec3d>, heading: number, out = new Vec3d()): Vec3d {
  const { east, north } = eastNorth(p);
  return out.copy(east).scale(Math.sin(heading)).addScaled(north, Math.cos(heading));
}

/** Compass heading (rad, 0..2π) of world vector `v` at unit direction `p`. */
export function headingOf(p: Readonly<Vec3d>, v: Readonly<Vec3d>): number {
  const { east, north } = eastNorth(p);
  const h = Math.atan2(v.dot(east), v.dot(north));
  return h < 0 ? h + 2 * Math.PI : h;
}

export function runwayFrame(r: Readonly<Runway>): RunwayFrame {
  const up = r.center.clone().normalize();
  const fwd = headingVector(up, r.heading);
  const right = fwd.clone().cross(up).normalize();
  return { fwd, right, up };
}

/** A world point's runway coordinates (m): along, across, height above the field. */
export function toRunway(
  r: Readonly<Runway>,
  frame: Readonly<RunwayFrame>,
  world: Readonly<Vec3d>,
  radius: number,
): { along: number; across: number; height: number } {
  const dir = world.clone().normalize();
  // Tangent-plane coordinates of the direction, scaled to the surface.
  const d = dir.clone().sub(frame.up);
  return {
    along: d.dot(frame.fwd) * radius,
    across: d.dot(frame.right) * radius,
    height: world.length() - radius - r.elevation,
  };
}

/** The unit direction at runway coordinates (along, across). */
export function fromRunway(
  frame: Readonly<RunwayFrame>,
  along: number,
  across: number,
  radius: number,
): Vec3d {
  return frame.up
    .clone()
    .addScaled(frame.fwd, along / radius)
    .addScaled(frame.right, across / radius)
    .normalize();
}

/** The world point (m) at runway coordinates, `height` above the field. */
export function runwayPoint(
  r: Readonly<Runway>,
  frame: Readonly<RunwayFrame>,
  along: number,
  across: number,
  height: number,
  radius: number,
): Vec3d {
  return fromRunway(frame, along, across, radius).scale(radius + r.elevation + height);
}

/** Two-digit designator for a landing heading (rad): tens of degrees, 36 for north. */
export function designator(heading: number): string {
  let n = Math.round(((heading / DEG) % 360) / 10);
  if (n <= 0) n += 36;
  if (n > 36) n -= 36;
  return String(n).padStart(2, '0');
}

/** Both ends of a runway, the one landing along its heading first. */
export function runwayEnds(r: Readonly<Runway>): [RunwayEnd, RunwayEnd] {
  const h = r.heading;
  const back = (h + Math.PI) % (2 * Math.PI);
  return [
    { heading: h, designator: designator(h), sign: 1, threshold: -r.length / 2 },
    { heading: back, designator: designator(back), sign: -1, threshold: r.length / 2 },
  ];
}

/** The end whose landing heading is closest to `heading`. */
export function endFor(r: Readonly<Runway>, heading: number): RunwayEnd {
  const [a, b] = runwayEnds(r);
  const diff = (x: number) => Math.abs(Math.atan2(Math.sin(x - heading), Math.cos(x - heading)));
  return diff(a.heading) <= diff(b.heading) ? a : b;
}

/** Distance past the threshold (m) of a point at `along` for a landing on `end`. */
export function pastThreshold(end: Readonly<RunwayEnd>, along: number): number {
  return (along - end.threshold) * end.sign;
}

/** Whether runway coordinates lie on the runway or its overruns. */
export function onRunway(r: Readonly<Runway>, along: number, across: number): boolean {
  return Math.abs(along) <= r.length / 2 + RUNWAY_OVERRUN && Math.abs(across) <= r.width / 2 + 3;
}

/** The runway nearest unit direction `dir`, and its surface distance (m). */
export function nearestRunway(
  runways: readonly Runway[],
  dir: Readonly<Vec3d>,
  radius: number,
): { runway: Runway; distance: number } | null {
  let best: Runway | null = null;
  let bestD = Infinity;
  for (const r of runways) {
    const d = Math.acos(Math.min(1, Math.max(-1, r.center.dot(dir)))) * radius;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best ? { runway: best, distance: bestD } : null;
}
