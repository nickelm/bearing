/**
 * The urban ground's interim street pattern (proposal 0009, Phase 1; decision 259),
 * shared by the terrain shader (`LightShading.urbanGround`) and the CPU (the town
 * buildings keep off its streets, squares and parks).
 *
 * A town's ground is a grid in its local frame (east and north at its center,
 * `localFrame`), turned to the bearing of its main road and spaced by its size:
 *
 * - **Streets** on every grid line, major (wider) on every MAJOR_EVERY-th line, each
 *   edged by a pale sidewalk.
 * - **Blocks** between them take a ground class from a hash of the block's index and
 *   its distance from the center as a share of the built-up radius: squares in the
 *   core, parks and parking lots between, paved courtyards in the core, and gardens
 *   and yards outside it. Industrial sites take concrete and gravel yards instead.
 *
 * Settlement plans (Phases 3–5) replace the grid near the camera with their own
 * streets and parcels; this pattern stays as the fallback for towns without one.
 */
import type { Vec3d } from '../../../core/vec3d';
import { cellHash, hashBits } from '../../../worldgen/canopy';
import { localFrame } from '../../../worldgen/edits/airfields';

/** Ground classes of the urban ground. */
export const UrbanClass = {
  Street: 0,
  Sidewalk: 1,
  Square: 2,
  Park: 3,
  Parking: 4,
  Garden: 5,
  Courtyard: 6,
  Concrete: 7,
  Gravel: 8,
} as const;
export type UrbanClass = (typeof UrbanClass)[keyof typeof UrbanClass];

/** Every MAJOR_EVERY-th grid line is a major street. */
export const MAJOR_EVERY = 3;
/** Half-widths (m) of major and minor streets, and the sidewalk's width beyond them. */
export const MAJOR_HALF = 7;
export const MINOR_HALF = 4.5;
export const SIDEWALK = 2.5;
/** Squares lie within this share of the built-up radius. */
export const CORE_SHARE = 0.14;
/** Courtyards (rather than gardens) within this share. */
export const INNER_SHARE = 0.4;

/** Grid spacing (m) of a town of `population`: tighter in cities. */
export function urbanSpacing(population: number): number {
  return population >= 60_000 ? 90 : population >= 8_000 ? 105 : 120;
}

/**
 * The hash both sides use for a block: the canopy's 32-bit integer hash (decision 148),
 * which the shader computes bit for bit (`cellHashNode`), as [0, 1].
 */
export function blockHash(i: number, j: number, seed: number): number {
  return hashBits(cellHash(i, j, URBAN_HASH_Z, seed), 4);
}

/** The third lattice coordinate of the block hash, apart from the canopy's own cells. */
export const URBAN_HASH_Z = 0x75b;

/** A town's pattern parameters, one vec4 per light record (`townInfo`). */
export interface UrbanInfo {
  /** Grid bearing (rad, counterclockwise from east, folded to 0..π/2). */
  angle: number;
  /** Grid spacing (m); 0 for records without urban ground. */
  spacing: number;
  /** Seed for the block hash, an integer below 2²⁴ (so float32 keeps it exact). */
  seed: number;
}

/**
 * Ground class at local coordinates (m east, m north of the town's center) for a town
 * with `info`, the point at `share` of its built-up radius (the block takes the share
 * of its own center); `industry` for industrial sites.
 */
export function urbanClassAt(
  x: number,
  y: number,
  share: number,
  info: UrbanInfo,
  industry = false,
): UrbanClass {
  const c = Math.cos(info.angle);
  const s = Math.sin(info.angle);
  const u = x * c + y * s;
  const v = -x * s + y * c;
  const S = info.spacing;
  const line = (w: number) => {
    const k = Math.floor(w / S + 0.5);
    const half = k % MAJOR_EVERY === 0 ? MAJOR_HALF : MINOR_HALF;
    return Math.abs(w - k * S) - half;
  };
  const edge = Math.min(line(u), line(v));
  if (edge < 0) return UrbanClass.Street;
  if (edge < SIDEWALK) return UrbanClass.Sidewalk;
  const bi = Math.floor(u / S);
  const bj = Math.floor(v / S);
  const h = blockHash(bi, bj, info.seed);
  // The share at the block's center, as the shader takes it: one class per block.
  const blockShare =
    (Math.hypot((bi + 0.5) * S, (bj + 0.5) * S) / Math.max(1, Math.hypot(x, y))) * share;
  return blockClass(h, Number.isFinite(blockShare) ? blockShare : share, industry);
}

/** A block's class from its hash and its share of the built-up radius. */
export function blockClass(h: number, share: number, industry: boolean): UrbanClass {
  if (industry) return h < 0.3 ? UrbanClass.Gravel : UrbanClass.Concrete;
  if (share < CORE_SHARE && h < 0.3) return UrbanClass.Square;
  if (h > 0.92) return UrbanClass.Park;
  if (h > 0.85 && share > CORE_SHARE) return UrbanClass.Parking;
  return share < INNER_SHARE ? UrbanClass.Courtyard : UrbanClass.Garden;
}

/** Classes on which no building stands. */
export function isOpenGround(c: UrbanClass): boolean {
  return (
    c === UrbanClass.Street ||
    c === UrbanClass.Sidewalk ||
    c === UrbanClass.Square ||
    c === UrbanClass.Park ||
    c === UrbanClass.Parking
  );
}

/** Local coordinates (m east, m north) of unit direction `d` about `center`, as the shader takes them. */
export function townLocal(
  center: Readonly<Vec3d>,
  d: Readonly<Vec3d>,
  radius: number,
): [number, number] {
  const { east, north } = localFrame(center);
  const dx = d.x - center.x;
  const dy = d.y - center.y;
  const dz = d.z - center.z;
  return [
    (dx * east.x + dy * east.y + dz * east.z) * radius,
    (dx * north.x + dy * north.y + dz * north.z) * radius,
  ];
}

/** Folds a bearing (rad) to 0..π/2: a grid looks the same turned by a right angle. */
export function foldGridAngle(a: number): number {
  const q = Math.PI / 2;
  return ((a % q) + q) % q;
}

/**
 * True if a building of half-size `margin` (m) at local (x, y) stands on built ground:
 * its center not on open ground and no street or sidewalk within `margin` along the grid.
 */
export function buildable(
  x: number,
  y: number,
  share: number,
  info: UrbanInfo,
  margin: number,
  industry = false,
): boolean {
  if (isOpenGround(urbanClassAt(x, y, share, info, industry))) return false;
  const c = Math.cos(info.angle) * margin;
  const s = Math.sin(info.angle) * margin;
  for (const [dx, dy] of [
    [c, s],
    [-c, -s],
    [-s, c],
    [s, -c],
  ] as const) {
    const k = urbanClassAt(x + dx, y + dy, share, info, industry);
    if (k === UrbanClass.Street || k === UrbanClass.Sidewalk) return false;
  }
  return true;
}
