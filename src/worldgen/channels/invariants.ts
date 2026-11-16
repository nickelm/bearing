/**
 * River invariants as measurements (decision 161, N2; proposal 0005's
 * verification table): what decisions 146 and 147 promise about the vector
 * rivers, measured on a `RiverIndex` so tests and tools can watch them over
 * many seeds while the planform changes.
 *
 * - **Monotone surface.** Along every polyline the water surface (smooth and
 *   stepped) never rises downstream by more than `tolerance`, and a tributary
 *   ends no lower than the river it joins starts.
 * - **No humps.** The bed (the surface less the channel's depth, 1 + 0.02 w
 *   as the tile kernel cuts it) has no interior local maximum along a polyline.
 * - **No ladders.** D8 drainage runs along the grid's axes and diagonals; a
 *   ladder shows as headings that cluster at multiples of 45° in the face's
 *   own (u, v) frame, and as stair-steps: short segments whose turns
 *   alternate. Both are reported against what a smooth line would give.
 * - **Sinuosity** per polyline (channel length over the chord), as a baseline
 *   for the regime work.
 */
import { directionToCubeFace } from '../../core/coords';
import type { CubeFaceUv } from '../../core/coords';
import { Vec3d } from '../../core/vec3d';
import { NO_SURFACE, RIVER_SEGMENT_FIELDS } from '../riverIndex';
import type { RiverIndex } from '../riverIndex';

export interface RiverInvariantOptions {
  /** Planet radius (m). */
  radius: number;
  /** Global grid cell size (m): stair-steps are segments shorter than two cells. */
  cellSize: number;
  /** Allowed rise of a surface downstream (m). Default 1 mm. */
  tolerance?: number;
  /** Half-width of the band around each multiple of 45° counted as on the grid (rad). Default 2.5°. */
  diagonalBand?: number;
  /** Least turn counted in a stair-step (rad). Default 20°. */
  stairTurn?: number;
}

export interface RiverInvariants {
  polylines: number;
  segments: number;
  /** Total channel length (m). */
  length: number;
  /** Steps along a polyline where the smooth or stepped surface rose more than the tolerance. */
  surfaceRises: number;
  /** Largest such rise (m). */
  maxSurfaceRise: number;
  /** Tributaries that end lower than the river they join starts, by more than the tolerance. */
  junctionRises: number;
  /** Tributaries whose last point is not the first point of the river they join (more than 1 m apart). */
  junctionGaps: number;
  /** Interior points where the bed stands above both neighbors by more than the tolerance. */
  bedMaxima: number;
  /** Largest such hump (m). */
  maxBedHump: number;
  /** Share of channel length (in-face segments) with a heading within the band of a multiple of 45°. */
  gridAligned: number;
  /** What a heading spread evenly would give: band / 22.5°. */
  gridAlignedUniform: number;
  /** Triples of segments whose turns alternate, each at least `stairTurn`, around a segment shorter than two cells. */
  stairSteps: number;
  /** Stair-steps per 1,000 km of channel. */
  stairStepsPer1000Km: number;
  /** Sinuosity of each polyline at least 20 cells long (length over chord). */
  sinuosity: number[];
}

const F = RIVER_SEGMENT_FIELDS;

export function riverInvariants(
  index: RiverIndex,
  downstream: Int32Array,
  opts: RiverInvariantOptions,
): RiverInvariants {
  const tol = opts.tolerance ?? 1e-3;
  const band = opts.diagonalBand ?? (2.5 * Math.PI) / 180;
  const stairTurn = opts.stairTurn ?? (20 * Math.PI) / 180;
  const R = opts.radius;
  const d = index.segments.data;
  const lines = index.lines;
  const nLines = lines.length - 1;
  const out: RiverInvariants = {
    polylines: nLines,
    segments: index.segments.count,
    length: 0,
    surfaceRises: 0,
    maxSurfaceRise: 0,
    junctionRises: 0,
    junctionGaps: 0,
    bedMaxima: 0,
    maxBedHump: 0,
    gridAligned: 0,
    gridAlignedUniform: band / (Math.PI / 8),
    stairSteps: 0,
    stairStepsPer1000Km: 0,
    sinuosity: [],
  };
  const a = new Vec3d();
  const b = new Vec3d();
  const ua: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const ub: CubeFaceUv = { face: 0, u: 0, v: 0 };
  let inFace = 0;
  let aligned = 0;
  const segLen = (s: number) => {
    const o = s * F;
    a.set(d[o]!, d[o + 1]!, d[o + 2]!);
    b.set(d[o + 3]!, d[o + 4]!, d[o + 5]!);
    return Math.acos(Math.min(1, a.dot(b))) * R;
  };
  const bed = (s: number, end: 0 | 1) => d[s * F + 8 + end]! - (1 + 0.02 * d[s * F + 6 + end]!);
  for (let k = 0; k < nLines; k++) {
    const s0 = lines[k]!;
    const s1 = lines[k + 1]!;
    if (s1 <= s0) continue;
    const carved = d[s0 * F + 8]! < NO_SURFACE * 0.5;
    let len = 0;
    const headings: number[] = [];
    const lengths: number[] = [];
    for (let s = s0; s < s1; s++) {
      const o = s * F;
      const L = segLen(s);
      len += L;
      lengths.push(L);
      if (carved) {
        for (const [x, y] of [
          [o + 8, o + 9],
          [o + 10, o + 11],
        ] as const) {
          const rise = d[y]! - d[x]!;
          if (rise > tol) {
            out.surfaceRises++;
            out.maxSurfaceRise = Math.max(out.maxSurfaceRise, rise);
          }
        }
        if (s > s0) {
          // Between segments: the joint is shared, so compare the surfaces there.
          for (const off of [0, 2]) {
            const rise = d[o + 8 + off]! - d[(s - 1) * F + 9 + off]!;
            if (rise > tol) {
              out.surfaceRises++;
              out.maxSurfaceRise = Math.max(out.maxSurfaceRise, rise);
            }
          }
        }
      }
      // Heading in the face's (u, v) frame, where D8 steps are axes and diagonals.
      directionToCubeFace(a.set(d[o]!, d[o + 1]!, d[o + 2]!), ua);
      directionToCubeFace(b.set(d[o + 3]!, d[o + 4]!, d[o + 5]!), ub);
      if (ua.face === ub.face && L > 0) {
        const h = Math.atan2(ub.v - ua.v, ub.u - ua.u);
        const m = ((h % (Math.PI / 4)) + Math.PI / 4) % (Math.PI / 4);
        inFace += L;
        if (m < band || m > Math.PI / 4 - band) aligned += L;
        headings.push(h);
      } else headings.push(NaN);
    }
    out.length += len;
    // Bed humps at interior joints: the bed at each joint against the joints either side.
    if (carved) {
      const beds: number[] = [bed(s0, 0)];
      for (let s = s0; s < s1; s++) beds.push(bed(s, 1));
      for (let i = 1; i + 1 < beds.length; i++) {
        const hump = beds[i]! - Math.max(beds[i - 1]!, beds[i + 1]!);
        if (hump > tol) {
          out.bedMaxima++;
          out.maxBedHump = Math.max(out.maxBedHump, hump);
        }
      }
    }
    // Stair-steps: turns that alternate around a short segment.
    for (let i = 1; i + 1 < headings.length; i++) {
      const t0 = turn(headings[i - 1]!, headings[i]!);
      const t1 = turn(headings[i]!, headings[i + 1]!);
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
      if (lengths[i]! >= 2 * opts.cellSize) continue;
      if (Math.abs(t0) >= stairTurn && Math.abs(t1) >= stairTurn && Math.sign(t0) !== Math.sign(t1))
        out.stairSteps++;
    }
    // Junction with the river downstream.
    const j = downstream[k]!;
    if (j >= 0 && j < nLines && lines[j + 1]! > lines[j]!) {
      const last = (s1 - 1) * F;
      const first = lines[j]! * F;
      a.set(d[last + 3]!, d[last + 4]!, d[last + 5]!);
      b.set(d[first]!, d[first + 1]!, d[first + 2]!);
      if (a.distanceTo(b) * R > 1) out.junctionGaps++;
      if (carved && d[first + 8]! < NO_SURFACE * 0.5 && d[first + 8]! - d[last + 9]! > tol)
        out.junctionRises++;
    }
    if (len >= 20 * opts.cellSize) {
      a.set(d[s0 * F]!, d[s0 * F + 1]!, d[s0 * F + 2]!);
      const e = (s1 - 1) * F;
      b.set(d[e + 3]!, d[e + 4]!, d[e + 5]!);
      const chord = Math.acos(Math.min(1, a.dot(b))) * R;
      if (chord > 0) out.sinuosity.push(len / chord);
    }
  }
  out.gridAligned = inFace > 0 ? aligned / inFace : 0;
  out.stairStepsPer1000Km = out.length > 0 ? (out.stairSteps * 1e6) / out.length : 0;
  return out;
}

/** Signed turn from heading h0 to h1, in (−π, π]. */
function turn(h0: number, h1: number): number {
  let t = h1 - h0;
  while (t > Math.PI) t -= 2 * Math.PI;
  while (t <= -Math.PI) t += 2 * Math.PI;
  return t;
}

/** The median of `xs` (0 for none). */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : 0.5 * (s[m - 1]! + s[m]!);
}
