/**
 * Airfields sited on the eroded world (decision 220).
 *
 * The coarse pass places airbases on its 6 km grid (decision 65), where a coastal
 * cell may be 7 m of flat land. The eroded global grid resolves that cell at 1.5 km
 * and adds the relief the coarse map has not got: the cell can turn out to be
 * shallow sea, a fjord or a mountainside. Siting is the airfields' alignment tier
 * (rule 13): the coarse record stays what campaign logic reads, and the runway the
 * renderer draws, the flight model lands on and the observer stands beside is moved
 * to the dry spot within `SITING_RADIUS` that needs the least grading (a little
 * distance, turn and elevation count against it), its heading turned at most
 * `SITING_TURN` from the coarse one. Where nothing there grades fairly, the search
 * widens to `SITING_WIDE_RADIUS`.
 *
 * A field whose own pad is dry and gently graded stays exactly where it is, so most
 * fields never move. Pure and deterministic: a function of the heights given.
 */
import { Vec3d } from '../../core/vec3d';
import type { Airbase, Infrastructure } from '../strategic/infrastructure';

/** Farthest a field moves from its coarse point (m): about one coarse cell, so spur roads still reach it. */
export const SITING_RADIUS = 6000;
/**
 * Where nothing within SITING_RADIUS grades better than SITING_FAIR (a steep island,
 * a fjord coast), the search widens to this (m), at the cost of a longer spur road.
 */
export const SITING_WIDE_RADIUS = 15_000;
/** Candidate rings per km of radius (every 500 m). */
const RINGS_PER_KM = 2;
/** Largest turn of the runway from the coarse heading (rad), in steps of SITING_TURN / 3. */
export const SITING_TURN = (45 * Math.PI) / 180;
/** Lowest ground (m) a pad sample may have: below it the pad is in the sea or at its edge. */
export const SITING_DRY = 4;
/** A pad whose heights vary less than this (RMS, m) is graded gently enough to stay put. */
export const SITING_GOOD = 20;
/** Grading RMS (m) beyond which the wider search is tried. */
export const SITING_FAIR = 40;
/**
 * Costs in m of grading RMS: per m moved, per radian turned, and per m of field
 * elevation, so a field takes the coastal plain over an equally flat summit.
 */
const MOVE_COST = 0.004;
const TURN_COST = 10;
const HEIGHT_COST = 0.01;

/** The graded pad around a runway, in m from its center: along beyond each end, and across. */
export interface PadFootprint {
  overrun: number;
  across0: number;
  across1: number;
  /**
   * The blend back to the terrain around the pad (m). It must be dry too: edits leave
   * the sea alone (rule 13), so a pad graded high beside the sea stands on a wall.
   */
  margin: number;
}

export interface SitingResult {
  infrastructure: Infrastructure;
  /** Per airbase (in `airbases` order): how far it moved (m) and its pad's grading RMS (m) after. */
  moved: Float32Array;
  rms: Float32Array;
  /** Airbases with no dry spot within the radius, left at their coarse point. */
  wet: number[];
}

/** The unit direction `along` m forward on `heading` and `across` m to its right from p. */
function offset(p: Readonly<Vec3d>, heading: number, along: number, across: number, R: number) {
  const east = new Vec3d(0, 1, 0).cross(p);
  if (east.length() < 1e-9) east.set(1, 0, 0);
  east.normalize();
  const north = p.clone().cross(east);
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  return p
    .clone()
    .addScaled(east, (fx * along + fy * across) / R)
    .addScaled(north, (fy * along - fx * across) / R)
    .normalize();
}

/**
 * The pad's grading RMS and mean height (m) at a point and heading, or null where
 * a sample is wet (below SITING_DRY, or in a lake by `wetAt`).
 */
function padRms(
  p: Readonly<Vec3d>,
  heading: number,
  length: number,
  pad: PadFootprint,
  R: number,
  heightAt: (d: Readonly<Vec3d>) => number,
  wetAt: ((d: Readonly<Vec3d>) => boolean) | null,
): { rms: number; mean: number } | null {
  const a0 = -length / 2 - pad.overrun;
  const a1 = length / 2 + pad.overrun;
  let sum = 0;
  let sum2 = 0;
  let count = 0;
  for (let a = 0; a <= 8; a++) {
    for (let c = 0; c <= 2; c++) {
      const d = offset(
        p,
        heading,
        a0 + ((a1 - a0) * a) / 8,
        pad.across0 + ((pad.across1 - pad.across0) * c) / 2,
        R,
      );
      const h = heightAt(d);
      if (h < SITING_DRY || wetAt?.(d)) return null;
      sum += h;
      sum2 += h * h;
      count++;
    }
  }
  // The margin's ring: dry, but not graded, so it does not count toward the RMS.
  const m = pad.margin;
  for (let k = 0; k < 24; k++) {
    const t = k / 24;
    const side = Math.floor(t * 4);
    const f = t * 4 - side;
    const along =
      side === 0
        ? a0 - m + f * (a1 - a0 + 2 * m)
        : side === 2
          ? a1 + m - f * (a1 - a0 + 2 * m)
          : side === 1
            ? a1 + m
            : a0 - m;
    const across =
      side === 1
        ? pad.across0 - m + f * (pad.across1 - pad.across0 + 2 * m)
        : side === 3
          ? pad.across1 + m - f * (pad.across1 - pad.across0 + 2 * m)
          : side === 0
            ? pad.across0 - m
            : pad.across1 + m;
    const d = offset(p, heading, along, across, R);
    if (heightAt(d) < SITING_DRY || wetAt?.(d)) return null;
  }
  const mean = sum / count;
  return { rms: Math.sqrt(Math.max(0, sum2 / count - mean * mean)), mean };
}

/** Heading folded into 0..π, as airbases store it. */
const fold = (h: number) => ((h % Math.PI) + Math.PI) % Math.PI;

/**
 * Sites every airbase of `infra` on the ground `heightAt` (m at a unit direction,
 * the eroded global grid), avoiding lakes where `wetAt` says so. Returns a copy of
 * the infrastructure with the sited points and headings; everything else is shared.
 */
export function siteAirfields(
  infra: Infrastructure,
  radius: number,
  pad: PadFootprint,
  heightAt: (d: Readonly<Vec3d>) => number,
  wetAt: ((d: Readonly<Vec3d>) => boolean) | null = null,
): SitingResult {
  const n = infra.airbases.length;
  const moved = new Float32Array(n);
  const rms = new Float32Array(n);
  const wet: number[] = [];
  const airbases: Airbase[] = infra.airbases.map((b, i) => {
    const p0 = new Vec3d(...b.point).normalize();
    const own = padRms(p0, b.heading, b.runwayLength, pad, radius, heightAt, wetAt);
    if (own && own.rms <= SITING_GOOD) {
      rms[i] = own.rms;
      return b;
    }
    let best = { cost: Infinity, p: p0, h: b.heading, rms: own?.rms ?? 0, dist: 0 };
    // Rings out to `outer`, starting at ring `from` (the near ones are done already).
    const search = (from: number, outer: number) => {
      const rings = Math.round((outer / 1000) * RINGS_PER_KM);
      for (let ring = from; ring <= rings; ring++) {
        const dist = ring * (1000 / RINGS_PER_KM);
        const around = ring === 0 ? 1 : 8 * ring;
        for (let k = 0; k < around; k++) {
          const p = ring === 0 ? p0 : offset(p0, (2 * Math.PI * k) / around, dist, 0, radius);
          for (let t = -3; t <= 3; t++) {
            const turn = (SITING_TURN * t) / 3;
            const g = padRms(p, b.heading + turn, b.runwayLength, pad, radius, heightAt, wetAt);
            if (!g) continue;
            const cost =
              g.rms + MOVE_COST * dist + TURN_COST * Math.abs(turn) + HEIGHT_COST * g.mean;
            if (cost < best.cost) best = { cost, p, h: b.heading + turn, rms: g.rms, dist };
          }
        }
      }
      return rings + 1;
    };
    const next = search(0, SITING_RADIUS);
    if (!Number.isFinite(best.cost) || best.rms > SITING_FAIR) search(next, SITING_WIDE_RADIUS);
    if (!Number.isFinite(best.cost)) {
      wet.push(b.id);
      rms[i] = own?.rms ?? 0;
      return b;
    }
    moved[i] = best.dist;
    rms[i] = best.rms;
    return { ...b, point: [best.p.x, best.p.y, best.p.z], heading: fold(best.h) };
  });
  return { infrastructure: { ...infra, airbases }, moved, rms, wet };
}
