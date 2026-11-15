/**
 * The canopy height field (proposal 0003, decision 148): how high a forest's
 * crowns stand above the ground at a point, shared by everything that needs
 * to agree on it. The renderer draws its canopy shell and stands its trees on
 * it (`render/common/canopyNode.ts` is this file's TSL twin, tested to agree);
 * the simulation will read it for line of sight and tree strikes.
 *
 *   H(p) = cover(forest) × stand height × (1 + lump)
 *
 * - **Cover.** Closed canopy where the forest density (decision 44) reaches
 *   the canopy threshold, 0.42, the contour the terrain's canopy shading
 *   follows (decision 71). The trees at the edge stand lower, growing to the
 *   stand's height over EDGE_RISE of density (decision 153).
 * - **Stands.** A forest is a mosaic of stands: cells of a 3D Voronoi diagram
 *   over points on the sea-level sphere, sites jittered in a lattice of
 *   `STAND_CELL` m, so the sphere cuts them into irregular polygons 100–400 m
 *   across. Each stand draws its kind (conifer or broadleaf, by the
 *   climate's conifer share at the point), an age that sets its height, a
 *   young stand now and then, and a shade.
 * - **Lumps.** Value noise of `LUMP_CELL` m lifts and lowers the canopy by up
 *   to `LUMP` of its height, so the shell reads as crowns from afar.
 *
 * All randomness is an integer hash of lattice cells and a seed: the GPU
 * reproduces it bit for bit, so CPU and GPU pick the same stands.
 */
import { rng } from '../core/rng';
import type { WorldSeed } from '../core/rng';

/** Forest density at which the canopy closes (decision 71's `forestThreshold`). */
export const CANOPY_THRESHOLD = 0.42;
/** Stand lattice (m): one Voronoi site per cell. */
export const STAND_CELL = 220;
/** Canopy lump lattice (m) and relative amplitude. */
export const LUMP_CELL = 45;
export const LUMP = 0.12;
/** Share of young stands, and their height relative to a mature stand of their kind. */
export const YOUNG_SHARE = 0.1;
export const YOUNG_HEIGHT = 0.75;
/** Mature stand heights (m): [lowest, spread] by kind. */
export const STAND_HEIGHTS = {
  conifer: [18, 8],
  broadleaf: [14, 8],
  tropical: [28, 10],
} as const;
/** Stand shade (albedo multiplier): lowest and spread. */
export const STAND_SHADE = [0.86, 0.28] as const;

/** The 32-bit seed the canopy hash uses for a world. */
export function canopySeed(worldSeed: WorldSeed): number {
  return Math.floor(rng(worldSeed, 'canopy').nextFloat() * 2 ** 32) >>> 0;
}

/** Integer hash of a lattice cell and a seed, as an unsigned 32-bit value. */
export function cellHash(ix: number, iy: number, iz: number, seed: number): number {
  let h =
    Math.imul(ix | 0, 0x8da6b343) ^
    Math.imul(iy | 0, 0xd8163841) ^
    Math.imul(iz | 0, 0xcb1ab31f) ^
    (seed | 0);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Ten bits of a hash, from bit `shift`, as [0, 1]. Exact in float32 too. */
export function hashBits(h: number, shift: number): number {
  return ((h >>> shift) & 1023) / 1023;
}

/** Seeds of the hash's uses, so they do not correlate. */
export const SEED_SITE = 0;
export const SEED_STAND = 0x51ed27;
export const SEED_LUMP = 0x2c1b3c;
export const SEED_SHADE = 0x7a3d91;

export interface Stand {
  /** The stand's lattice cell, for seeding what grows in it. */
  cell: [number, number, number];
  /** The stand's hash (SEED_STAND), for further draws. */
  hash: number;
  /** 1 for a conifer stand, 0 for broadleaf. */
  conifer: number;
  /** Mature canopy height of the stand (m), before lumps. */
  height: number;
  /** Albedo multiplier. */
  shade: number;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Conifer share of stands at an annual mean temperature (°C), as the terrain's canopy shading. */
export function coniferShare(meanT: number): number {
  return smooth(CONIFER_T[0], CONIFER_T[1], meanT);
}

/**
 * Annual mean temperatures (°C) between which stands turn from broadleaf to
 * conifer: all conifer in the cold (owner, decision 153). The terrain's canopy
 * shading uses the same pair.
 */
export const CONIFER_T = [11, 6] as const;

/**
 * Share of pines among a conifer stand's trees: none in the cold, where stands
 * are all pointed firs, up to 40% in warm conifer forest (decision 153).
 */
export function pineShare(meanT: number): number {
  return 0.4 * smooth(4, 9, meanT);
}

/**
 * How far the canopy has risen at a forest density (decision 153): 0 on the
 * edge's contour, 1 a little inside it. The canopy shell rises from the ground
 * at the edge by this; trees there stand at EDGE_TREES of the stand's height
 * and grow to full height inside.
 */
export const EDGE_RISE = 0.12;
export const EDGE_TREES = 0.55;
export function edgeRise(forest: number): number {
  return smooth(CANOPY_THRESHOLD, CANOPY_THRESHOLD + EDGE_RISE, forest);
}

/** Tropical share at an annual mean temperature (°C). */
export function tropicalShare(meanT: number): number {
  return smooth(18, 24, meanT);
}

/**
 * The stand at point `p` on the sea-level sphere (planet-centered m: the unit
 * direction times the radius), given the conifer and tropical shares there.
 */
export function standAt(
  x: number,
  y: number,
  z: number,
  conifer: number,
  tropical: number,
  seed: number,
): Stand {
  const qx = x / STAND_CELL;
  const qy = y / STAND_CELL;
  const qz = z / STAND_CELL;
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const iz = Math.floor(qz);
  const fx = qx - ix;
  const fy = qy - iy;
  const fz = qz - iz;
  let best = Infinity;
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const h = cellHash(ix + dx, iy + dy, iz + dz, seed ^ SEED_SITE);
        const rx = dx + 0.1 + 0.8 * hashBits(h, 0) - fx;
        const ry = dy + 0.1 + 0.8 * hashBits(h, 10) - fy;
        const rz = dz + 0.1 + 0.8 * hashBits(h, 20) - fz;
        const d = rx * rx + ry * ry + rz * rz;
        if (d < best) {
          best = d;
          bx = dx;
          by = dy;
          bz = dz;
        }
      }
    }
  }
  const cell: [number, number, number] = [ix + bx, iy + by, iz + bz];
  const h = cellHash(cell[0], cell[1], cell[2], seed ^ SEED_STAND);
  const isConifer = hashBits(h, 0) < conifer ? 1 : 0;
  const age = hashBits(h, 10);
  const kind = isConifer ? STAND_HEIGHTS.conifer : STAND_HEIGHTS.broadleaf;
  let height = kind[0] + kind[1] * age;
  height += (STAND_HEIGHTS.tropical[0] + STAND_HEIGHTS.tropical[1] * age - height) * tropical;
  if (hashBits(h, 20) < YOUNG_SHARE) height *= YOUNG_HEIGHT;
  const shade =
    STAND_SHADE[0] +
    STAND_SHADE[1] * hashBits(cellHash(cell[0], cell[1], cell[2], seed ^ SEED_SHADE), 0);
  return { cell, hash: h, conifer: isConifer, height, shade };
}

/** Canopy lumps: value noise in [-1, 1] with a lattice of LUMP_CELL m. */
export function canopyLump(x: number, y: number, z: number, seed: number): number {
  const qx = x / LUMP_CELL;
  const qy = y / LUMP_CELL;
  const qz = z / LUMP_CELL;
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const iz = Math.floor(qz);
  const s = (t: number) => t * t * (3 - 2 * t);
  const ux = s(qx - ix);
  const uy = s(qy - iy);
  const uz = s(qz - iz);
  const at = (dx: number, dy: number, dz: number) =>
    hashBits(cellHash(ix + dx, iy + dy, iz + dz, seed ^ SEED_LUMP), 0);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const x0 = lerp(lerp(at(0, 0, 0), at(1, 0, 0), ux), lerp(at(0, 1, 0), at(1, 1, 0), ux), uy);
  const x1 = lerp(lerp(at(0, 0, 1), at(1, 0, 1), ux), lerp(at(0, 1, 1), at(1, 1, 1), ux), uy);
  return lerp(x0, x1, uz) * 2 - 1;
}

/** The canopy top above the ground in a stand (m): its height with the lumps. */
export function standTop(stand: Stand, x: number, y: number, z: number, seed: number): number {
  return stand.height * (1 + LUMP * canopyLump(x, y, z, seed));
}

/**
 * The canopy height field H (m above the ground) at sea-level sphere point
 * `p`: zero where the forest density is under the threshold, the stand's
 * lumpy top where the canopy is closed.
 */
export function canopyHeight(
  x: number,
  y: number,
  z: number,
  forest: number,
  meanT: number,
  seed: number,
): number {
  if (forest < CANOPY_THRESHOLD) return 0;
  const stand = standAt(x, y, z, coniferShare(meanT), tropicalShare(meanT), seed);
  return standTop(stand, x, y, z, seed) * (EDGE_TREES + (1 - EDGE_TREES) * edgeRise(forest));
}
