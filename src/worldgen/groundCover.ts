/**
 * Ground cover (decisions 168, 169, 174): what grows or lies at a point of the
 * ground, as a pure function the renderer and, later, the simulation share
 * (boulders taller than OBSTACLE_HEIGHT are landing obstacles, H3).
 *
 * - **Cells.** One cell per sample of the level-10 tile lattice (about 6 m on
 *   the campaign world), named by cube face and global sample index, so any
 *   caller finds the same cells. Each cell has COVER_SLOTS candidate slots.
 * - **What may grow** comes from the site (`CoverSite`): the tile's cover code,
 *   moisture, annual mean temperature, slope, forest density, aridity and
 *   farmland, sampled once per cell by the caller. `coverMix` turns it into a
 *   probability per slot for each kit model; rock faces and scree mix toward
 *   boulders and pebbles, open land toward tufts, flowers and bushes, and
 *   closed forest has none (the canopy shell covers the ground).
 * - **Where** comes from integer hashes of the cell (`cellHash`, as the
 *   canopy's): each slot's position, kind, scale, turn and shade. Two
 *   low-frequency patterns over blocks of cells make clumps of grass and fields
 *   of boulders, and a third gives each meadow patch one flower color. No RNG
 *   stream is drawn, so no other stage changes (rule 5).
 *
 * Masks that need the world beyond the site (water, roads, towns, airfields)
 * belong to the caller, as for the trees.
 */
import { rng } from '../core/rng';
import type { WorldSeed } from '../core/rng';
import { Biome, TileCover } from './biomes';
import { CANOPY_THRESHOLD, cellHash, hashBits } from './canopy';

/** The kit (render/common/models/specs/cover-*.json, decision 172). */
export const COVER_KINDS = [
  'cover-tuft',
  'cover-tuft-dry',
  'cover-tussock',
  'cover-flowers-cream',
  'cover-flowers-yellow',
  'cover-flowers-violet',
  'cover-reeds',
  'cover-bush',
  'cover-bush-dry',
  'cover-boulder-small',
  'cover-boulder',
  'cover-boulder-large',
  'cover-boulder-lichen',
  'cover-slab',
  'cover-pebbles',
] as const;
export type CoverKind = (typeof COVER_KINDS)[number];

/** Each kind's height at scale 1 (m): the top of its model (tests check them against the specs). */
export const COVER_HEIGHT: Readonly<Record<CoverKind, number>> = {
  'cover-tuft': 0.5,
  'cover-tuft-dry': 0.46,
  'cover-tussock': 0.72,
  'cover-flowers-cream': 0.32,
  'cover-flowers-yellow': 0.265,
  'cover-flowers-violet': 0.35,
  'cover-reeds': 1.365,
  'cover-bush': 0.873,
  'cover-bush-dry': 0.873,
  'cover-boulder-small': 0.39,
  'cover-boulder': 1.02,
  'cover-boulder-large': 1.57,
  'cover-boulder-lichen': 1.03,
  'cover-slab': 1.05,
  'cover-pebbles': 0.1,
};

/** Kinds that are rock: they keep their own color, never sway and never hide under snow. */
export const ROCK_KINDS: ReadonlySet<CoverKind> = new Set([
  'cover-boulder-small',
  'cover-boulder',
  'cover-boulder-large',
  'cover-boulder-lichen',
  'cover-slab',
  'cover-pebbles',
]);

/** Boulders at least this tall (m) are landing obstacles (decision 169). */
export const OBSTACLE_HEIGHT = 0.8;

/** Candidate slots per cell. */
export const COVER_SLOTS = 5;

/** Cells per block of the clump and boulder-field patterns, and of the flower-color patches. */
const PATCH_CELLS = 5;
const FLOWER_CELLS = 9;

const SEED_SLOT = 0x6a09e6;
const SEED_LOOK = 0x3c6ef3;
const SEED_CLUMP = 0x510e52;
const SEED_FIELD = 0x9b05e8;
const SEED_FLOWER = 0x1f83d9;

/** The ground-cover hash seed of a world. */
export function coverSeed(worldSeed: WorldSeed): number {
  return Math.floor(rng(worldSeed, 'ground-cover').nextFloat() * 2 ** 32) >>> 0;
}

/** What `coverMix` needs at a cell. */
export interface CoverSite {
  /** The tile material's cover: a `Biome`, or a `TileCover` (beach, marsh, gravel). */
  cover: number;
  /** Moisture 0..1 (the climate's). */
  moisture: number;
  /** Annual mean temperature at the site (°C). */
  meanT: number;
  /** Slope of the drawn ground (m/m). */
  steep: number;
  /** Forest density 0..1. */
  forest: number;
  /** Aridity 0..1 (decision 126). */
  aridity: number;
  /** Farmland 0..1: fields, where only the verges keep tufts. */
  farmland: number;
  /** How near a field's boundary, 0..1: verges keep and gather tufts and flowers (decision 185). */
  verge?: number;
  /** How near a river's or lake's edge, 0..1 (on dry ground): reeds and lush tufts (decision 185). */
  bank?: number;
  /** How much cliff stands just above, 0..1: talus, boulders fallen from it (decision 185). */
  talus?: number;
}

/** One placed item: its kind, place in the cell (0..1), scale, turn (rad), shade and height (m). */
export interface CoverItem {
  kind: CoverKind;
  u: number;
  v: number;
  scale: number;
  angle: number;
  shade: number;
  height: number;
}

type Mix = Partial<Record<CoverKind | 'flowers', number>>;

/** Open, green land: meadows. */
const MEADOW: Mix = {
  'cover-tuft': 0.72,
  flowers: 0.06,
  'cover-bush': 0.02,
  'cover-boulder-small': 0.003,
};
/** Dry grass and scrub. */
const DRY: Mix = {
  'cover-tuft-dry': 0.55,
  'cover-tussock': 0.12,
  'cover-bush-dry': 0.05,
  'cover-boulder-small': 0.015,
  'cover-pebbles': 0.03,
};
/** Desert: stones, a few dry bushes and tufts. */
const DESERT: Mix = {
  'cover-pebbles': 0.09,
  'cover-boulder-small': 0.03,
  'cover-bush-dry': 0.02,
  'cover-tuft-dry': 0.05,
  'cover-slab': 0.006,
};
/** Tundra: tussocks, lichen rocks. */
const TUNDRA: Mix = {
  'cover-tussock': 0.25,
  'cover-tuft': 0.15,
  'cover-boulder-lichen': 0.03,
  'cover-pebbles': 0.05,
};
/** Alpine meadows and fell. */
const ALPINE: Mix = {
  'cover-tuft': 0.25,
  'cover-tussock': 0.08,
  flowers: 0.03,
  'cover-boulder': 0.02,
  'cover-boulder-lichen': 0.03,
  'cover-boulder-small': 0.05,
  'cover-pebbles': 0.07,
};
/** Rock faces and scree: boulders and stones. */
const ROCK: Mix = {
  'cover-boulder-small': 0.1,
  'cover-boulder': 0.035,
  'cover-boulder-large': 0.01,
  'cover-pebbles': 0.14,
};
/** Talus below a cliff: boulders of every size, and stones. */
const TALUS: Mix = {
  'cover-boulder-small': 0.14,
  'cover-boulder': 0.08,
  'cover-boulder-large': 0.035,
  'cover-pebbles': 0.12,
};
/** Marsh: reeds. */
const MARSH: Mix = { 'cover-reeds': 0.45, 'cover-tuft': 0.25 };
/** River gravel. */
const GRAVEL: Mix = { 'cover-pebbles': 0.35, 'cover-boulder-small': 0.05 };
/** Beach sand. */
const BEACH: Mix = { 'cover-pebbles': 0.02 };

function blend(a: Mix, b: Mix, t: number): Mix {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const out: Mix = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Mix>)
    out[k] = (a[k] ?? 0) * (1 - t) + (b[k] ?? 0) * t;
  return out;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Probability per slot of each kind at a site ('flowers' stands for the three
 * flower tufts, whose color the cell's patch picks). The sum stays under 1.
 */
export function coverMix(s: CoverSite): Mix {
  if (s.forest >= CANOPY_THRESHOLD) return {};
  if (s.cover === TileCover.Marsh) return MARSH;
  if (s.cover === TileCover.Gravel) return GRAVEL;
  if (s.cover === TileCover.Beach) return BEACH;
  let veg: Mix;
  switch (s.cover) {
    case Biome.HotDesert:
    case Biome.ColdDesert:
      veg = DESERT;
      break;
    case Biome.Tundra:
      veg = TUNDRA;
      break;
    case Biome.Alpine:
      veg = ALPINE;
      break;
    case Biome.Shrubland:
    case Biome.Savanna:
      veg = blend(DRY, MEADOW, smooth(0.35, 0.6, s.moisture));
      break;
    case Biome.IceSheet:
    case Biome.SeaIce:
    case Biome.DeepOcean:
    case Biome.Ocean:
    case Biome.Shelf:
      return {};
    default:
      // Grassland and the open land of forest biomes: meadow, drier toward arid ground.
      veg = blend(MEADOW, DRY, smooth(0.3, 0.15, s.moisture) * (s.meanT > 4 ? 1 : 0));
  }
  // The forest's fringe grows bushes.
  const fringe = smooth(0.2, CANOPY_THRESHOLD, s.forest);
  if (fringe > 0) veg = { ...veg, 'cover-bush': (veg['cover-bush'] ?? 0) + 0.06 * fringe };
  // Fields keep tufts only along their verges, and the verges gather them (decision 185).
  if (s.farmland > 0) {
    const verge = s.verge ?? 0;
    const keep = 1 - 0.9 * s.farmland * (1 - verge);
    const kept: Mix = {};
    for (const [k, p] of Object.entries(veg) as [keyof Mix, number][]) kept[k] = p * keep;
    const lush = verge * s.farmland;
    if (lush > 0) {
      kept['cover-tuft'] = (kept['cover-tuft'] ?? 0) + 0.12 * lush;
      kept.flowers = (kept.flowers ?? 0) + 0.03 * lush;
    }
    veg = kept;
  }
  // River and lake banks: reeds at the water's edge where it is warm enough, lush tufts.
  const bank = s.bank ?? 0;
  if (bank > 0) {
    const warm = smooth(0, 6, s.meanT);
    veg = blend(veg, { 'cover-reeds': 0.4 * warm, 'cover-tuft': 0.35 }, 0.85 * bank);
  }
  // Scree on steepish ground, sandstone where it is dry, lichen where cold and wet; below a
  // cliff, its talus (decision 185).
  const steep = smooth(0.35, 0.55, s.steep);
  const talus = (s.talus ?? 0) * 0.9;
  const rocky = Math.max(steep, talus);
  let rock: Mix = talus > steep ? TALUS : ROCK;
  if (s.aridity > 0.4) rock = { ...rock, 'cover-slab': 0.02 * s.aridity + 0.02 * talus };
  else if (s.moisture > 0.35 && s.meanT < 8) rock = { ...rock, 'cover-boulder-lichen': 0.03 };
  const mix = blend(veg, rock, rocky);
  // Nothing stays put on a face steeper than about 30–35° (the owner's review, decision 187):
  // rock faces, buttes' sides and steep hillsides stay bare.
  const hold = 1 - smooth(0.58, 0.72, s.steep);
  if (hold >= 1) return mix;
  const held: Mix = {};
  for (const [k, p] of Object.entries(mix) as [keyof Mix, number][]) held[k] = p * hold;
  return held;
}

/** Each kind's scale range. */
const SCALE: Readonly<Record<CoverKind, readonly [number, number]>> = {
  'cover-tuft': [1.05, 1.75],
  'cover-tuft-dry': [1.05, 1.7],
  'cover-tussock': [0.9, 1.5],
  'cover-flowers-cream': [1.0, 1.45],
  'cover-flowers-yellow': [1.0, 1.45],
  'cover-flowers-violet': [1.0, 1.45],
  'cover-reeds': [0.8, 1.25],
  'cover-bush': [0.7, 1.4],
  'cover-bush-dry': [0.7, 1.3],
  'cover-boulder-small': [0.7, 1.5],
  'cover-boulder': [0.7, 1.4],
  'cover-boulder-large': [0.8, 1.3],
  'cover-boulder-lichen': [0.7, 1.4],
  'cover-slab': [0.6, 1.2],
  'cover-pebbles': [0.8, 1.5],
};

const FLOWERS: readonly CoverKind[] = [
  'cover-flowers-cream',
  'cover-flowers-yellow',
  'cover-flowers-violet',
];

/** Value noise over blocks of `cells` cells, in [0, 1]. */
function patch(gx: number, gy: number, face: number, cells: number, seed: number): number {
  const x = gx / cells;
  const y = gy / cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const tx = x - ix;
  const ty = y - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const at = (a: number, b: number) => hashBits(cellHash(ix + a, iy + b, face, seed), 0);
  return (
    (at(0, 0) * (1 - sx) + at(1, 0) * sx) * (1 - sy) + (at(0, 1) * (1 - sx) + at(1, 1) * sx) * sy
  );
}

/**
 * The items of cell (gx, gy) of cube face `face`: global level-10 sample
 * indices. Appends to `out` and returns it.
 */
export function coverInCell(
  gx: number,
  gy: number,
  face: number,
  seed: number,
  site: CoverSite,
  out: CoverItem[] = [],
): CoverItem[] {
  const mix = coverMix(site);
  const entries = Object.entries(mix) as [keyof Mix, number][];
  if (entries.length === 0) return out;
  // Clumps of grass and fields of boulders: 0.25 to 1.75 times the mean.
  const clump = 0.25 + 1.5 * patch(gx, gy, face, PATCH_CELLS, seed ^ SEED_CLUMP);
  const field = 0.25 + 1.5 * patch(gx, gy, face, PATCH_CELLS, seed ^ SEED_FIELD);
  // One flower color per block of cells, so a meadow has patches of each.
  const flower =
    FLOWERS[
      cellHash(
        Math.floor(gx / FLOWER_CELLS),
        Math.floor(gy / FLOWER_CELLS),
        face,
        seed ^ SEED_FLOWER,
      ) % FLOWERS.length
    ]!;
  // Clumped, a slot's probabilities may add up past one: scale them back.
  let total = 0;
  for (const [k, p] of entries) total += p * (ROCK_KINDS.has(k as CoverKind) ? field : clump);
  const norm = total > 1 ? 1 / total : 1;
  for (let s = 0; s < COVER_SLOTS; s++) {
    const h = cellHash(gx, gy, face * COVER_SLOTS + s, seed ^ SEED_SLOT);
    const look = cellHash(gx, gy, face * COVER_SLOTS + s, seed ^ SEED_LOOK);
    let pick = hashBits(h, 0);
    let kind: CoverKind | null = null;
    for (const [k, p] of entries) {
      const name = k === 'flowers' ? flower : k;
      const q = p * (ROCK_KINDS.has(name) ? field : clump) * norm;
      if (pick < q) {
        kind = name;
        break;
      }
      pick -= q;
    }
    if (!kind) continue;
    const [lo, hi] = SCALE[kind];
    const scale = lo + (hi - lo) * hashBits(look, 0);
    out.push({
      kind,
      u: hashBits(h, 10),
      v: hashBits(h, 20),
      scale,
      angle: hashBits(look, 10) * 2 * Math.PI,
      shade: 0.88 + 0.24 * hashBits(look, 20),
      height: COVER_HEIGHT[kind] * scale,
    });
  }
  return out;
}

/** Whether an item stops a landing (decision 169). */
export function isObstacle(item: CoverItem): boolean {
  return ROCK_KINDS.has(item.kind) && item.height >= OBSTACLE_HEIGHT;
}
