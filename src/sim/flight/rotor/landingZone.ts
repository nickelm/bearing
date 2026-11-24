/**
 * A landing zone near a point (roadmap R2.9): where a rescue helicopter puts
 * down beside a survivor. A helicopter needs a spot clear of trees for its
 * rotor and level enough for its gear, so the survivor's own point is seldom
 * it: the survivor walks to the helicopter.
 *
 * `chooseLandingZone` searches rings around the point, RING_STEP apart out to
 * `maxDistance`, each sampled every RING_STEP along it from north clockwise,
 * and takes the nearest ring with a clear spot (on that ring, the flattest, then
 * the first). A spot is clear when the rotor's footprint (its center and
 * FOOTPRINT_POINTS on a circle of FOOTPRINT rotor radii) has no water, no forest
 * denser than MAX_FOREST, and a slope under the least of the type's slope limit
 * and MAX_SLOPE, measured as the largest rise from the center to the circle.
 *
 * Pure and deterministic: the ground comes in through a sampler, so the main
 * thread passes the drawn terrain and tests a synthetic one. The approach heading
 * is into the wind when one is given (a helicopter lands into the wind), else
 * the bearing from where the helicopter comes, else north.
 */
import { destination, initialHeading } from '../../../core/greatCircle';
import type { Dir } from '../../../core/greatCircle';
import { DEG } from '../../../core/units';
import type { Meters, Radians } from '../../../core/units';

/** The ground near a landing zone. */
export interface LandingSampler {
  /** Ground height above sea level (m) at unit direction d. */
  height(d: Readonly<Dir>): number;
  /** Forest density 0..1 at d. */
  forest(d: Readonly<Dir>): number;
  /** Whether d is water. */
  water(d: Readonly<Dir>): boolean;
}

export interface LandingZoneOptions {
  /** The planet's radius (m). */
  radius: Meters;
  /** The helicopter's main rotor radius (m). */
  rotorRadius: Meters;
  /** The type's slope limit (rad). */
  slopeLimit: Radians;
  /** Farthest from the point to look (m); default MAX_DISTANCE. */
  maxDistance?: Meters;
  /** The wind at the zone (m/s, toward east and north): the approach heads into it. */
  wind?: { east: number; north: number };
  /** Where the helicopter comes from (unit direction): the approach's bearing without wind. */
  from?: Readonly<Dir>;
}

export interface LandingZone {
  /** The spot (unit direction) and its ground height (m above sea level). */
  point: Dir;
  height: number;
  /** Distance from the point asked for (m). */
  distance: Meters;
  /** The slope over the footprint (rad) and the most forest density in it. */
  slope: Radians;
  forest: number;
  /** The heading to approach and land on (rad, clockwise from north). */
  heading: Radians;
}

export const RING_STEP: Meters = 25;
export const MAX_DISTANCE: Meters = 600;
/** The footprint's radius in rotor radii, and its points on the circle. */
export const FOOTPRINT = 1.5;
export const FOOTPRINT_POINTS = 8;
/** Most forest density in the footprint, and most slope whatever the type allows. */
export const MAX_FOREST = 0.15;
export const MAX_SLOPE: Radians = 8 * DEG;
/** Wind below this (m/s) leaves the heading to the approach's bearing. */
const CALM = 1;

interface Spot {
  point: Dir;
  height: number;
  slope: number;
  forest: number;
}

/** The footprint at d: null if it touches water or forest, else its slope and forest. */
function footprint(d: Dir, sampler: LandingSampler, rf: Meters, radius: Meters): Spot | null {
  if (sampler.water(d)) return null;
  const h0 = sampler.height(d);
  let forest = sampler.forest(d);
  let rise = 0;
  for (let k = 0; k < FOOTPRINT_POINTS; k++) {
    const p = destination(d, (2 * Math.PI * k) / FOOTPRINT_POINTS, rf, radius);
    if (sampler.water(p)) return null;
    forest = Math.max(forest, sampler.forest(p));
    rise = Math.max(rise, Math.abs(sampler.height(p) - h0));
  }
  if (forest > MAX_FOREST) return null;
  return { point: d, height: h0, slope: Math.atan(rise / rf), forest };
}

/** The nearest clear landing spot within `maxDistance` of `point`, or null if there is none. */
export function chooseLandingZone(
  point: Readonly<Dir>,
  sampler: LandingSampler,
  o: LandingZoneOptions,
): LandingZone | null {
  const R = o.radius;
  const rf = FOOTPRINT * o.rotorRadius;
  const limit = Math.min(o.slopeLimit, MAX_SLOPE);
  const most = o.maxDistance ?? MAX_DISTANCE;
  const p0: Dir = [point[0], point[1], point[2]];
  let found: Spot | null = null;
  let distance = 0;
  for (let r = 0; r <= most + 1e-9 && !found; r += RING_STEP) {
    const n = r === 0 ? 1 : Math.max(6, Math.ceil((2 * Math.PI * r) / RING_STEP));
    for (let k = 0; k < n; k++) {
      const d = r === 0 ? p0 : destination(p0, (2 * Math.PI * k) / n, r, R);
      const s = footprint(d, sampler, rf, R);
      if (!s || s.slope > limit) continue;
      if (!found || s.slope < found.slope) {
        found = s;
        distance = r;
      }
    }
  }
  if (!found) return null;
  let heading = 0;
  const w = o.wind;
  if (w && Math.hypot(w.east, w.north) >= CALM) {
    // Into the wind: the nose toward where it blows from.
    heading = Math.atan2(-w.east, -w.north);
  } else if (o.from) {
    heading = initialHeading(o.from, found.point);
  }
  if (heading < 0) heading += 2 * Math.PI;
  return { ...found, distance, heading };
}
