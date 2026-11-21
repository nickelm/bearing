/**
 * Rock dressing (Proposal 0010, *Rock Dressing*; decision 299): instanced rock pieces
 * over steep ground, so cliffs, gorges and ridges gain ledges, buttresses, towers and
 * broken edges that a height field cannot hold. Generic and dense, beside the sparse,
 * specific landform props of decision 225 (props.ts), whose placement pattern it
 * shares: a lattice of cells on the level-7 tiles, at most one piece per cell, at a
 * hashed spot, from a pure function of the cell's site. Rule 15: it reads the
 * landform (slope, curvature, province, rock) and biome layers and changes neither.
 *
 * Game-agnostic (owner's addendum): nothing here knows of sides or war. A game sets
 * the density (`DRESSING_TUNING.density`, or `dressingInCell`'s `density`) and
 * whether pieces collide; Bearing's defaults are below.
 *
 * Placement (the proposal's rules):
 * - **cliffs** (slope > `cliffSlope`, about 45°): slabs and ledges laid on the face,
 *   their up the face's normal, by rock: sandstone slabs and ledges, granite domes,
 *   limestone slabs, basalt walls, schist slabs;
 * - **walls** (steep, below a cliff's slope, in layered rock or rifts): buttresses
 *   standing up the slope;
 * - **crests** (convex and steep): teeth, spires, pinnacles, columns or tors;
 * - **feet** (concave, moderately steep, below steeper ground): scree fans;
 * - **open high ground** (alpine meadow, moorland, tundra, gentle slopes): boulders.
 *
 * Pieces sink into the ground (`sink`): their models reach below their origin, and
 * the layer stands them on the lowest ground under their footprint.
 */
import { rng } from '../core/rng';
import type { WorldSeed } from '../core/rng';
import { Biome } from './biomes';
import { cellHash, hashBits } from './canopy';
import { isLayered, Rock, rockOf } from './lithology';
import { Province } from './provinces';

export const DRESSING_KINDS = [
  'rock-sand-slab',
  'rock-sand-ledge',
  'rock-sand-buttress',
  'rock-sand-spire',
  'rock-granite-dome',
  'rock-granite-boulder',
  'rock-granite-tor',
  'rock-lime-slab',
  'rock-lime-pinnacle',
  'rock-basalt-columns',
  'rock-basalt-wall',
  'rock-schist-slab',
  'rock-schist-fin',
  'rock-scree',
  'rock-crest-tooth',
  'rock-boulder',
] as const;
export type DressingKind = (typeof DRESSING_KINDS)[number];

/** Level-7 tile samples per dressing cell along each axis (about 95 m on the campaign planet). */
export const DRESSING_STRIDE = 2;

/** How a piece stands: on the face (its up the ground's normal) or upright (up the vertical). */
export type DressingPose = 'face' | 'upright';

/**
 * Each kind's size at scale 1 (m: its largest extent), the spread of its scale, its pose and
 * its collision radius at scale 1 (m; pieces larger than `collideAbove` collide).
 */
export const DRESSING_SIZE: Readonly<
  Record<
    DressingKind,
    { size: number; scale: [number, number]; pose: DressingPose; radius: number }
  >
> = {
  'rock-sand-slab': { size: 22, scale: [0.6, 3], pose: 'face', radius: 10 },
  'rock-sand-ledge': { size: 34, scale: [0.6, 2.5], pose: 'face', radius: 14 },
  'rock-sand-buttress': { size: 32, scale: [0.5, 2.5], pose: 'upright', radius: 8 },
  'rock-sand-spire': { size: 36, scale: [0.4, 2.2], pose: 'upright', radius: 6 },
  'rock-granite-dome': { size: 36, scale: [0.5, 2.5], pose: 'face', radius: 16 },
  'rock-granite-boulder': { size: 12, scale: [0.4, 1.6], pose: 'upright', radius: 5 },
  'rock-granite-tor': { size: 20, scale: [0.5, 2], pose: 'upright', radius: 8 },
  'rock-lime-slab': { size: 24, scale: [0.6, 3], pose: 'face', radius: 11 },
  'rock-lime-pinnacle': { size: 28, scale: [0.4, 2.2], pose: 'upright', radius: 6 },
  'rock-basalt-columns': { size: 22, scale: [0.5, 2.5], pose: 'upright', radius: 7 },
  'rock-basalt-wall': { size: 26, scale: [0.5, 3], pose: 'face', radius: 12 },
  'rock-schist-slab': { size: 20, scale: [0.6, 3], pose: 'face', radius: 9 },
  'rock-schist-fin': { size: 15, scale: [0.6, 2.5], pose: 'upright', radius: 6 },
  'rock-scree': { size: 32, scale: [0.6, 3], pose: 'face', radius: 0 },
  'rock-crest-tooth': { size: 22, scale: [0.5, 2.5], pose: 'upright', radius: 5 },
  'rock-boulder': { size: 8, scale: [0.5, 2], pose: 'upright', radius: 3 },
};

/** Tuning knobs (decision 299). */
export const DRESSING_TUNING = {
  /** Density factor over every chance below (a game's or the quality tier's knob). */
  density: 1,
  /** Slopes (m/m): a cliff above tan 45°, a wall above tan 32°. */
  cliffSlope: 1,
  wallSlope: 0.62,
  /** Chance per cell on a cliff, a wall, a crest, a foot and open high ground. */
  cliff: 0.75,
  wall: 0.3,
  crest: 0.45,
  foot: 0.35,
  open: 0.06,
  /** Curvature (drop from the mean of the ground ±2 samples per meter): convex below, concave above. */
  convex: -0.06,
  concave: 0.05,
  /** Pieces larger than this (m, size × scale) collide (the proposal's 20 m). */
  collideAbove: 20,
  /** How far each upright piece sinks below the lowest ground under it, per meter of size. */
  sink: 0.12,
  /**
   * How far a piece laid on a face sinks below the ground at its spot, per meter of size:
   * enough that a flat slab on a convex slope does not overhang its downslope edge and
   * show a dark underside to a camera below it.
   */
  faceSink: 0.15,
};

/** What placement reads at a cell. */
export interface DressingSite {
  /** Ground height (m; negative at sea). */
  height: number;
  /** Slope (m/m) at the cell, and the steepest slope within a cell upslope (for feet). */
  slope: number;
  upslope: number;
  /** Fine curvature (m/m): the ground's drop from the mean of its neighbors per meter; negative convex. */
  curvature: number;
  lithology: number;
  province: number;
  biome: number;
  /** Water, a town, a road or an airfield here: nothing stands. */
  blocked: boolean;
}

export interface DressingItem {
  kind: DressingKind;
  /** Spot inside the cell, 0..1 on each axis. */
  fx: number;
  fy: number;
  scale: number;
  /** Turn about the piece's up (rad). */
  yaw: number;
  /** Shade multiplier of the piece's colors (0.85–1.15). */
  shade: number;
}

const OPEN_HIGH: ReadonlySet<number> = new Set([
  Biome.Alpine,
  Biome.Tundra,
  Biome.Moorland,
  Biome.RockyDesert,
  Biome.ColdDesert,
]);

const SEED_PICK = 0x71c3a5;
const SEED_LOOK = 0x3b9d27;

/** The dressing's hash seed of a world (its own stream, rule 5). */
export function dressingSeed(worldSeed: WorldSeed): number {
  return Math.floor(rng(worldSeed, 'rock-dressing').nextFloat() * 2 ** 32) >>> 0;
}

/** Kinds for each role by rock: [cliff face, wall, crest]. */
function kindsFor(lithology: number): {
  cliff: DressingKind[];
  wall: DressingKind;
  crest: DressingKind[];
} {
  const rock = rockOf(lithology);
  switch (rock) {
    case Rock.Sandstone:
    case Rock.Shale:
      return {
        cliff: ['rock-sand-slab', 'rock-sand-ledge'],
        wall: 'rock-sand-buttress',
        crest: ['rock-sand-spire', 'rock-crest-tooth'],
      };
    case Rock.Granite:
      return {
        cliff: ['rock-granite-dome', 'rock-granite-dome'],
        wall: 'rock-granite-tor',
        crest: ['rock-granite-tor', 'rock-crest-tooth'],
      };
    case Rock.Limestone:
      return {
        cliff: ['rock-lime-slab', 'rock-lime-slab'],
        wall: 'rock-lime-pinnacle',
        crest: ['rock-lime-pinnacle', 'rock-crest-tooth'],
      };
    case Rock.Basalt:
    case Rock.Ash:
      return {
        cliff: ['rock-basalt-wall', 'rock-basalt-columns'],
        wall: 'rock-basalt-columns',
        crest: ['rock-basalt-columns', 'rock-crest-tooth'],
      };
    case Rock.Schist:
      return {
        cliff: ['rock-schist-slab', 'rock-schist-slab'],
        wall: 'rock-schist-fin',
        crest: ['rock-schist-fin', 'rock-crest-tooth'],
      };
    default:
      // Loess, till and no rock: plain slabs where they stand steep, teeth on crests.
      return {
        cliff: ['rock-schist-slab', 'rock-granite-dome'],
        wall: 'rock-schist-fin',
        crest: ['rock-crest-tooth', 'rock-crest-tooth'],
      };
  }
}

/** The kind a cell's site supports and its chance, before density and the hash. */
export function dressingChance(
  s: DressingSite,
): { kind: DressingKind; p: number; pick: number } | null {
  if (s.blocked || s.height <= 0) return null;
  const T = DRESSING_TUNING;
  const k = kindsFor(s.lithology);
  // Young, sharp ranges and rifts carry more broken rock; old, worn ones less.
  const ruggedness =
    s.province === Province.YoungCollision || s.province === Province.Rift
      ? 1.25
      : s.province === Province.OldMountains || s.province === Province.Shield
        ? 0.75
        : 1;
  if (s.curvature < T.convex && s.slope > 0.35)
    return { kind: k.crest[0]!, p: T.crest * ruggedness, pick: 1 };
  if (s.slope > T.cliffSlope) return { kind: k.cliff[0]!, p: T.cliff * ruggedness, pick: 0 };
  if (s.slope > T.wallSlope) {
    // Buttresses where rock is layered or faulted; slabs elsewhere.
    const layered = isLayered(s.lithology) || s.province === Province.Rift;
    return layered
      ? { kind: k.wall, p: T.wall * ruggedness, pick: 2 }
      : { kind: k.cliff[1]!, p: T.wall * 0.6 * ruggedness, pick: 0 };
  }
  if (s.curvature > T.concave && s.slope > 0.18 && s.upslope > T.wallSlope)
    return { kind: 'rock-scree', p: T.foot, pick: 3 };
  if (OPEN_HIGH.has(s.biome) && s.slope < 0.45)
    return {
      kind: rockOf(s.lithology) === Rock.Granite ? 'rock-granite-boulder' : 'rock-boulder',
      p: T.open,
      pick: 4,
    };
  return null;
}

/**
 * The piece of cell (gx, gy) on `face` (dressing-lattice indices), or null. Deterministic:
 * the same cell gives the same piece whatever tile or order asks for it. `density`
 * scales every chance (a quality tier or a game's choice).
 */
export function dressingInCell(
  seed: number,
  face: number,
  gx: number,
  gy: number,
  site: DressingSite,
  density = DRESSING_TUNING.density,
): DressingItem | null {
  const c = dressingChance(site);
  if (!c || c.p <= 0 || density <= 0) return null;
  const h = cellHash(gx, gy, face, seed ^ SEED_PICK);
  if (hashBits(h, 0) >= Math.min(1, c.p * density)) return null;
  const look = cellHash(gx, gy, face, seed ^ SEED_LOOK);
  // Every other cell of a role takes its second kind, so cliffs mix slabs and ledges.
  let kind = c.kind;
  if (c.pick === 0 && hashBits(look, 22) > 0.55) kind = kindsFor(site.lithology).cliff[1]!;
  if (c.pick === 1 && hashBits(look, 22) > 0.6) kind = kindsFor(site.lithology).crest[1]!;
  const [lo, hi] = DRESSING_SIZE[kind].scale;
  // More small pieces than large: the scale skewed toward its low end.
  const t = hashBits(look, 0);
  return {
    kind,
    fx: 0.15 + 0.7 * hashBits(h, 10),
    fy: 0.15 + 0.7 * hashBits(h, 20),
    scale: lo + (hi - lo) * t * Math.sqrt(t),
    yaw: 2 * Math.PI * hashBits(look, 11),
    shade: 0.85 + 0.3 * hashBits(look, 21),
  };
}

/** Whether a placed piece collides (larger than `collideAbove`), and its radius (m). */
export function dressingCollider(item: DressingItem): number | null {
  const s = DRESSING_SIZE[item.kind];
  if (s.radius <= 0 || s.size * item.scale <= DRESSING_TUNING.collideAbove) return null;
  return s.radius * item.scale;
}
