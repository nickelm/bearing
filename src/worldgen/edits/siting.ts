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
import { RoadClass } from '../strategic/graph';
import type { RoadNetwork } from '../strategic/graph';
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
  const spurs = resiteSpurs(infra.spurs, infra.airbases, airbases);
  return { infrastructure: { ...infra, airbases, spurs }, moved, rms, wet };
}

/**
 * Spur roads to sited fields (decision 221). The coarse pass ends a field's spur at
 * its cell's center, the field's coarse point. Where siting moved the field, that end
 * moves to the sited point, and the alignment stage routes the last leg over the
 * terrain. A field whose cell was already on the road network has no spur: it gets a
 * new one from its coarse point to the sited point. New spurs are appended, so the
 * spur bridges keep their indices.
 */
export function resiteSpurs(
  spurs: RoadNetwork,
  before: readonly Airbase[],
  after: readonly Airbase[],
): RoadNetwork {
  const points = Float64Array.from(spurs.points);
  const added: { cell: number; from: readonly number[]; to: readonly number[] }[] = [];
  const ends = new Map<number, number[]>();
  for (let k = 0; k < spurs.count; k++) {
    const a = spurs.offsets[k]!;
    const b = spurs.offsets[k + 1]! - 1;
    if (b <= a) continue;
    for (const p of [a, b]) {
      const cell = spurs.cells[p]!;
      let l = ends.get(cell);
      if (!l) ends.set(cell, (l = []));
      l.push(p);
    }
  }
  for (let i = 0; i < before.length; i++) {
    const b0 = before[i]!;
    const b1 = after[i]!;
    if (b0 === b1) continue;
    const at = ends.get(b0.cell);
    if (at) {
      for (const p of at) points.set(b1.point, p * 3);
    } else added.push({ cell: b0.cell, from: b0.point, to: b1.point });
  }
  if (added.length === 0) return { ...spurs, points };
  const n = spurs.count + added.length;
  const offsets = new Uint32Array(n + 1);
  offsets.set(spurs.offsets);
  const base = spurs.offsets[spurs.count]!;
  added.forEach((_, j) => (offsets[spurs.count + j + 1] = base + 2 * (j + 1)));
  const grow = <T extends Float64Array | Int32Array>(src: T, extra: number[]): T => {
    const out = new (src.constructor as new (n: number) => T)(src.length + extra.length);
    out.set(src);
    out.set(extra, src.length);
    return out;
  };
  const roadClass = new Uint8Array(n);
  roadClass.set(spurs.roadClass);
  roadClass.fill(RoadClass.Secondary, spurs.count);
  const traffic = new Float32Array(n);
  traffic.set(spurs.traffic);
  const route = new Int32Array(n).fill(-1);
  route.set(spurs.route);
  return {
    count: n,
    offsets,
    cells: grow(
      spurs.cells,
      added.flatMap((a) => [a.cell, a.cell]),
    ),
    points: grow(
      points,
      added.flatMap((a) => [...a.from, ...a.to]),
    ),
    roadClass,
    traffic,
    route,
  };
}

/** A natural wonder sited on the eroded world (decision 221). */
export interface SitedWonder {
  /** Feature index in the graph. */
  feature: number;
  /** `WonderKind`. */
  kind: number;
  /** Unit direction of the shape's center. */
  dir: [number, number, number];
  /** The ground it stands on (m): the mean height on a ring round it. */
  base: number;
  /** How far it moved from the feature's anchor (m). */
  moved: number;
  /**
   * The ground's RMS deviation (m) round and under the sited shape; above
   * WONDER_MAX_UNEVEN the tiles leave the wonder unshaped: on rough ground a shape
   * drew walls, not a landmark. NaN where no dry (or shallow-sea) site was found.
   */
  uneven: number;
}

/** Ground rougher than this (RMS, m) under a wonder's site leaves it unshaped (decision 221). */
export const WONDER_MAX_UNEVEN = 60;

/** Radius (m) of each shaped kind (tile kernel, `WONDER_SHAPES`); others are not moved. */
export const WONDER_SITE_RADIUS: Readonly<Record<number, number>> = {
  0: 3200, // tepui
  6: 3500, // caldera
  9: 1600, // monolith
  10: 280, // blue hole
};
/** Farthest a wonder moves from its coarse anchor (m). */
export const WONDER_SITING_RADIUS = 8000;

/**
 * Sites each wonder on the eroded ground (decision 221). A wonder's anchor is a coarse
 * cell's center, and the eroded world can put a mountainside, a valley or the sea
 * there: a dome raised from the anchor's height over the plain beside it drew a flat
 * cylinder. The shaped kinds move, within WONDER_SITING_RADIUS, to where the ground on a
 * ring round the shape (1.3 radii out) and under it is most even: dry land for a tepui,
 * caldera or monolith, sea 2–40 m deep for a blue hole. The shape stands on the ring's
 * mean height. Kinds the tiles do not shape stay at their anchors.
 */
export function siteWonders(
  ids: readonly number[],
  kindOf: (feature: number) => number,
  anchorOf: (feature: number) => Vec3d,
  radius: number,
  heightAt: (d: Readonly<Vec3d>) => number,
  /** Lakes, salt lakes and playas: no land wonder stands in one. */
  wetAt: ((d: Readonly<Vec3d>) => boolean) | null = null,
): SitedWonder[] {
  return ids.map((id) => {
    const kind = kindOf(id);
    const a = anchorOf(id).normalize();
    const shapeR = WONDER_SITE_RADIUS[kind];
    const ringMean = (p: Vec3d, r: number) => {
      let s = 0;
      for (let k = 0; k < 16; k++) s += heightAt(offset(p, (k / 16) * 2 * Math.PI, r, 0, radius));
      return s / 16;
    };
    if (shapeR === undefined) {
      return { feature: id, kind, dir: [a.x, a.y, a.z], base: heightAt(a), moved: 0, uneven: 0 };
    }
    const sea = kind === 10;
    const ringR = sea ? 3 * shapeR : 1.3 * shapeR;
    let best = { cost: Infinity, p: a, base: ringMean(a, ringR), dist: 0, sd: NaN };
    const step = 1000;
    for (let ring = 0; ring * step <= WONDER_SITING_RADIUS; ring++) {
      const dist = ring * step;
      const around = ring === 0 ? 1 : 8 * ring;
      for (let k = 0; k < around; k++) {
        const p = ring === 0 ? a : offset(a, (2 * Math.PI * k) / around, dist, 0, radius);
        const hs: number[] = [];
        for (let j = 0; j < 16; j++)
          hs.push(heightAt(offset(p, (j / 16) * 2 * Math.PI, ringR, 0, radius)));
        for (let j = 0; j < 8; j++)
          hs.push(heightAt(offset(p, (j / 8) * 2 * Math.PI, 0.6 * ringR, 0, radius)));
        hs.push(heightAt(p));
        const ok = sea
          ? hs.every((h) => h < -2 && h > -40)
          : hs.every((h) => h > 5) &&
            !(
              wetAt &&
              (wetAt(p) ||
                wetAt(offset(p, 0, ringR, 0, radius)) ||
                wetAt(offset(p, Math.PI, ringR, 0, radius)) ||
                wetAt(offset(p, Math.PI / 2, ringR, 0, radius)) ||
                wetAt(offset(p, -Math.PI / 2, ringR, 0, radius)))
            );
        if (!ok) continue;
        const mean = hs.reduce((x, y) => x + y, 0) / hs.length;
        const sd = Math.sqrt(hs.reduce((x, y) => x + (y - mean) ** 2, 0) / hs.length);
        // Lower ground counts a little: a monolith or tepui rises from a plain.
        const cost = sd + 0.002 * dist + (sea ? Math.abs(mean + 15) : 0.01 * mean);
        if (cost < best.cost) best = { cost, p, base: ringMean(p, ringR), dist, sd };
      }
    }
    return {
      feature: id,
      kind,
      dir: [best.p.x, best.p.y, best.p.z],
      base: best.base,
      moved: best.dist,
      uneven: best.sd,
    };
  });
}
