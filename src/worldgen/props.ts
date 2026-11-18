/**
 * Landform props (W7; proposal 0007, decisions 204, 225): tower karst, sandstone
 * pillars and inselbergs, the landforms a height field cannot hold, placed by
 * cell from rock, province and climate (rule 15: they read the landform and biome
 * layers and change neither). Pure and deterministic, shared by the renderer and,
 * for collision, later the sim.
 *
 * Cells lie on a lattice of PROP_CELL m (every PROP_STRIDE samples of the level-7
 * tiles), each holding at most one prop at a hashed spot inside it.
 */
import { rng } from '../core/rng';
import type { WorldSeed } from '../core/rng';
import { Biome } from './biomes';
import { cellHash, hashBits } from './canopy';
import { isLayered, Rock, rockOf } from './lithology';
import { Province } from './provinces';

export const PROP_KINDS = ['prop-karst-tower', 'prop-pillar', 'prop-inselberg'] as const;
export type PropKind = (typeof PROP_KINDS)[number];

/** Level-7 tile samples per prop cell along each axis (about 190 m). */
export const PROP_STRIDE = 4;

/** Height (m) of each kind's model at scale 1, and the spread of its scale. */
export const PROP_SIZE: Readonly<Record<PropKind, { height: number; scale: [number, number] }>> = {
  'prop-karst-tower': { height: 148, scale: [0.6, 1.8] },
  'prop-pillar': { height: 88, scale: [0.6, 1.5] },
  'prop-inselberg': { height: 133, scale: [0.6, 1.3] },
};

const WET_WARM: ReadonlySet<number> = new Set([
  Biome.TropicalRainforest,
  Biome.TropicalSeasonalForest,
  Biome.CloudForest,
  Biome.Mangrove,
  Biome.Savanna,
  Biome.TemperateRainforest,
]);
const DRY: ReadonlySet<number> = new Set([
  Biome.HotDesert,
  Biome.RockyDesert,
  Biome.RedRockDesert,
  Biome.ColdDesert,
  Biome.Shrubland,
]);
const OPEN_WARM: ReadonlySet<number> = new Set([
  Biome.Savanna,
  Biome.HotDesert,
  Biome.RockyDesert,
  Biome.Shrubland,
  Biome.TemperateGrassland,
]);

/** Chance per cell. Tuning knobs (decision 225). */
export const PROP_TUNING = {
  /** Tower karst in limestone under a wet, warm climate (Guilin, Ha Long). */
  karstWet: 0.3,
  /** Scattered towers on limestone elsewhere. */
  karstDry: 0.03,
  /** Drowned towers on a karst shelf (sea 0–40 m deep next to limestone). */
  karstDrowned: 0.22,
  /** Pillars in layered sandstone in a dry climate. */
  pillar: 0.05,
  /** Inselbergs on old granite under open, warm country. */
  inselberg: 0.006,
  /** Near a karst bay or pillar forest wonder, within WONDER_REACH m. */
  wonderDense: 0.5,
  wonderReach: 6000,
};

/** What placement reads at a cell. */
export interface PropSite {
  /** Ground height at the cell (m; negative at sea). */
  height: number;
  /** Ground slope (m/m). */
  slope: number;
  /** Global grid: lithology byte, province, biome at the cell. */
  lithology: number;
  province: number;
  biome: number;
  /** Limestone on land within about a global cell (for drowned towers at sea). */
  karstNear: boolean;
  /** Distance (m) to the nearest karst-bay and pillar-forest wonders (Infinity: none). */
  karstWonder: number;
  pillarWonder: number;
  /** A lake, river, town, road or airfield here: nothing stands. */
  blocked: boolean;
}

export interface PropItem {
  kind: PropKind;
  /** Spot inside the cell, 0..1 on each axis. */
  fx: number;
  fy: number;
  scale: number;
  /** Turn about the vertical (rad). */
  yaw: number;
}

const SEED_PICK = 0x2545f4;
const SEED_LOOK = 0x9e3779;
const SEED_CLUMP = 0x6c8e94;
/** Cells per clump (about 1.5 km): props gather in fields with gaps between them. */
const CLUMP_CELLS = 8;

/** Smooth value noise 0..1 over a lattice of CLUMP_CELLS cells, per face. */
function clump(seed: number, face: number, gx: number, gy: number): number {
  const x = gx / CLUMP_CELLS;
  const y = gy / CLUMP_CELLS;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const s = (t: number) => t * t * (3 - 2 * t);
  const tx = s(x - ix);
  const ty = s(y - iy);
  const v = (a: number, b: number) => hashBits(cellHash(a, b, face, seed ^ SEED_CLUMP), 0);
  return (
    (v(ix, iy) * (1 - tx) + v(ix + 1, iy) * tx) * (1 - ty) +
    (v(ix, iy + 1) * (1 - tx) + v(ix + 1, iy + 1) * tx) * ty
  );
}

/** The props hash seed of a world (its own stream, rule 5). */
export function propSeed(worldSeed: WorldSeed): number {
  return Math.floor(rng(worldSeed, 'props').nextFloat() * 2 ** 32) >>> 0;
}

/** The kind a cell's site supports, and its chance. */
export function propChance(s: PropSite): { kind: PropKind; p: number } | null {
  if (s.blocked) return null;
  const T = PROP_TUNING;
  const rock = rockOf(s.lithology);
  const nearWonder = (d: number) =>
    d < T.wonderReach ? T.wonderDense * (1 - (d / T.wonderReach) ** 2) : 0;
  if (s.height < 0) {
    // Drowned towers on a shallow karst shelf.
    if (s.height > -40 && (s.karstNear || s.karstWonder < T.wonderReach))
      return {
        kind: 'prop-karst-tower',
        p: Math.max(s.karstNear ? T.karstDrowned : 0, nearWonder(s.karstWonder)),
      };
    return null;
  }
  if (rock === Rock.Limestone || s.province === Province.KarstPlatform) {
    const base = WET_WARM.has(s.biome) ? T.karstWet : T.karstDry;
    return { kind: 'prop-karst-tower', p: Math.max(base, nearWonder(s.karstWonder)) };
  }
  if (
    rock === Rock.Sandstone &&
    isLayered(s.lithology) &&
    (DRY.has(s.biome) || s.pillarWonder < T.wonderReach)
  )
    return { kind: 'prop-pillar', p: Math.max(T.pillar, nearWonder(s.pillarWonder)) };
  if (s.pillarWonder < T.wonderReach) return { kind: 'prop-pillar', p: nearWonder(s.pillarWonder) };
  if (
    rock === Rock.Granite &&
    (s.province === Province.Shield || s.province === Province.OldMountains) &&
    OPEN_WARM.has(s.biome) &&
    s.slope < 0.08
  )
    return { kind: 'prop-inselberg', p: T.inselberg };
  return null;
}

/**
 * The prop of cell (gx, gy) on `face` (prop-lattice indices), or null. Deterministic:
 * the same cell gives the same prop whatever tile or order asks for it.
 */
export function propInCell(
  seed: number,
  face: number,
  gx: number,
  gy: number,
  site: PropSite,
): PropItem | null {
  const c = propChance(site);
  if (!c || c.p <= 0) return null;
  // Fields and gaps: the chance swings from none to twice its mean with the clump noise.
  const p = c.p * Math.min(2, Math.max(0, 3 * clump(seed, face, gx, gy) - 0.5));
  const h = cellHash(gx, gy, face, seed ^ SEED_PICK);
  if (hashBits(h, 0) >= p) return null;
  const look = cellHash(gx, gy, face, seed ^ SEED_LOOK);
  const [lo, hi] = PROP_SIZE[c.kind].scale;
  // Larger towers where they crowd less: a scale from the look hash, skewed small.
  const t = hashBits(look, 0);
  return {
    kind: c.kind,
    fx: 0.2 + 0.6 * hashBits(h, 8),
    fy: 0.2 + 0.6 * hashBits(h, 16),
    scale: lo + (hi - lo) * t * t,
    yaw: 2 * Math.PI * hashBits(look, 12),
  };
}
