/**
 * Corridor edits (decision 161): the formation of a road, railway or canal
 * and its banks, along a polyline with a design elevation at each point.
 *
 * Within `halfWidth` of the centerline the surface is the design elevation z
 * of the nearest point on the polyline. Beyond it the terrain h is clamped
 * between the fill bank below and the cut bank above:
 *
 *   h' = clamp(h, z − (d − w) / fillRun, z + (d − w) / cutRun)
 *
 * so an embankment falls at 1 : fillRun to the ground and a cutting rises at
 * 1 : cutRun to it, with no case split between cut and fill. Over the last
 * `fade` meters before `reach` the edit blends back to the terrain, so it
 * never ends in a step; a corridor that would need banks wider than its reach
 * is a viaduct or a tunnel, which the aligner (N5) makes a structure instead.
 *
 * Segments are chords between unit directions, measured like the river carve
 * (`carveRivers` in tileSynth.ts): the chord's distance × R. A chord sags
 * L² / 8R below the sphere, so segments are split to CORRIDOR_MAX_SEGMENT
 * (500 m: 3 cm on a 1,000 km planet).
 */
import type { Vec3d } from '../../core/vec3d';

export interface CorridorEdit {
  /** Centerline, unit directions, xyz interleaved (at least two points). */
  points: Float64Array;
  /** Design elevation at each point (physical m). */
  elevation: Float64Array;
  /** Half-width of the flat formation: road crown or ballast bed (m). */
  halfWidth: number;
  /** Horizontal run per meter of fill bank (1.5 for 1 : 1.5). */
  fillRun: number;
  /** Horizontal run per meter of cut bank (1 in rock, 2 in soil). */
  cutRun: number;
  /** Distance from the centerline beyond which the edit does nothing (m, > halfWidth). */
  reach: number;
  /** Width of the blend back to the terrain inside `reach` (m). */
  fade: number;
  /** Larger wins where corridors overlap (class rank). */
  priority: number;
}

/** Defaults for a corridor's banks: fill 1 : 1.5, cut 1 : 1, fading out over 10 m. */
export const CORRIDOR_BANKS = { fillRun: 1.5, cutRun: 1, fade: 10 };

/** Values per prepared segment: a.xyz, b.xyz, zA, zB, halfWidth, fillRun, cutRun, reach, fade, priority, corridor. */
export const CORRIDOR_SEGMENT_FIELDS = 15;

/** Throws unless corridor `c` (number `ci`, for the message) is well formed. */
export function validateCorridor(c: CorridorEdit, ci: number): void {
  if (!(c.reach > c.halfWidth) || c.fade < 0 || c.fillRun <= 0 || c.cutRun <= 0)
    throw new Error(`corridor ${ci}: needs reach > halfWidth, fade ≥ 0 and positive runs`);
  if (c.elevation.length < 2 || c.points.length !== c.elevation.length * 3)
    throw new Error(
      `corridor ${ci}: ${c.points.length / 3} points, ${c.elevation.length} elevations`,
    );
}

/** Flattens corridors into one segment table (see CORRIDOR_SEGMENT_FIELDS). */
export function corridorSegments(corridors: readonly CorridorEdit[]): Float64Array {
  let n = 0;
  for (const c of corridors) n += Math.max(0, c.elevation.length - 1);
  const out = new Float64Array(n * CORRIDOR_SEGMENT_FIELDS);
  let o = 0;
  corridors.forEach((c, ci) => {
    validateCorridor(c, ci);
    for (let i = 0; i + 1 < c.elevation.length; i++) {
      for (let k = 0; k < 6; k++) out[o + k] = c.points[i * 3 + k]!;
      out[o + 6] = c.elevation[i]!;
      out[o + 7] = c.elevation[i + 1]!;
      out[o + 8] = c.halfWidth;
      out[o + 9] = c.fillRun;
      out[o + 10] = c.cutRun;
      out[o + 11] = c.reach;
      out[o + 12] = Math.min(c.fade, c.reach - c.halfWidth);
      out[o + 13] = c.priority;
      out[o + 14] = ci;
      o += CORRIDOR_SEGMENT_FIELDS;
    }
  });
  return out;
}

function smoothstep(a: number, b: number, x: number): number {
  if (b <= a) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Distance (m) from `dir` to segment s and the design elevation at its nearest point. */
export function segmentNearest(
  seg: Float64Array,
  s: number,
  dir: Readonly<Vec3d>,
  radius: number,
): { d: number; z: number } {
  const o = s * CORRIDOR_SEGMENT_FIELDS;
  const ax = seg[o]!;
  const ay = seg[o + 1]!;
  const az = seg[o + 2]!;
  const bx = seg[o + 3]! - ax;
  const by = seg[o + 4]! - ay;
  const bz = seg[o + 5]! - az;
  const px = dir.x - ax;
  const py = dir.y - ay;
  const pz = dir.z - az;
  const len2 = bx * bx + by * by + bz * bz;
  const t = len2 > 1e-30 ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / len2)) : 0;
  const d = Math.hypot(px - t * bx, py - t * by, pz - t * bz) * radius;
  return { d, z: seg[o + 6]! + (seg[o + 7]! - seg[o + 6]!) * t };
}

/**
 * One corridor's effect at a point, from the nearest of its segments `ids`
 * (all of one corridor): the target height and the edit's weight (1 out to
 * reach − fade, 0 from reach on). `null` when out of reach.
 */
export function corridorAt(
  seg: Float64Array,
  ids: readonly number[],
  dir: Readonly<Vec3d>,
  h: number,
  radius: number,
): { target: number; weight: number; cover: number } | null {
  let best = -1;
  let bestD = Infinity;
  let bestZ = 0;
  for (const s of ids) {
    const n = segmentNearest(seg, s, dir, radius);
    if (n.d < bestD) {
      bestD = n.d;
      bestZ = n.z;
      best = s;
    }
  }
  if (best < 0) return null;
  const o = best * CORRIDOR_SEGMENT_FIELDS;
  const w = seg[o + 8]!;
  const reach = seg[o + 11]!;
  if (bestD >= reach) return null;
  const fade = seg[o + 12]!;
  let target: number;
  if (bestD <= w) target = bestZ;
  else {
    const e = bestD - w;
    target = Math.min(Math.max(h, bestZ - e / seg[o + 9]!), bestZ + e / seg[o + 10]!);
  }
  const weight = 1 - smoothstep(reach - fade, reach, bestD);
  // Bare ground: the formation, fading over a quarter of its width (at least 2 m) beyond it.
  const cover = 1 - smoothstep(w, w + Math.max(2, 0.5 * w), bestD);
  return { target, weight, cover };
}
