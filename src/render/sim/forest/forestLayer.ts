/**
 * Instanced trees near the camera (decisions 45, 148): the tree kit (decision
 * 147) standing on and in front of the canopy shell.
 *
 * - **Placement** per quarter of a level-10 tile (about 770 m), within `edgeRange` of the
 *   camera and below `maxAltitude`, deterministic from
 *   `rng(seed, "trees").fork(tileKey)`:
 *   - closed forest (density over the canopy threshold) on a jittered lattice
 *     of `CROWN_SPACING` m, so the crowns close. Each tree takes its stand
 *     (worldgen/canopy.ts): conifer stands grow fir and pine, broadleaf stands
 *     broadleaf, oak and birch; its top stands at the canopy height H there,
 *     the height the shell and the simulation use. Trees whose neighborhood is
 *     all closed forest draw only their crowns;
 *   - open land and the forest's fringe on a sparser lattice: shrubs, birch,
 *     broadleaf, oak or acacia by climate, more of them toward the forest edge.
 * - **Ranges.** Crowns inside a stand show within `nearRange`, where the shell
 *   is their understory; whole trees (edges, fringe, open land) within
 *   `edgeRange`. Trees shrink away over the last 30% of their range, into the
 *   rising shell.
 * - **Instance data:** ground point (relative to the tile's origin), up vector,
 *   raw ground height, scale, rotation and shade. The vertex shader applies the
 *   terrain's height exaggeration to the ground point only; trees keep their
 *   real size.
 * - **Shading** as the terrain's: planet lighting, aerial perspective per
 *   vertex, the builder's baked occlusion, broadleaf crowns browning in autumn
 *   and bare in winter, snow on upward-facing crowns.
 * - Meshes are camera-relative (rule 4): a tile's meshes sit at origin − eye.
 */
import {
  BufferAttribute,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  cos,
  cross,
  dot,
  float,
  Fn,
  fract,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  step,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { placeCameraRelative } from '../../common/cameraRelative';
import { sphereOutsideView } from '../../common/terrain/quadtree';
import type { CullView } from '../../common/terrain/quadtree';
import { instanceExtent, instanceSphere } from '../instanceBounds';
import type { InstanceExtent } from '../instanceBounds';
import {
  cubeFaceUvToDirection,
  directionToCubeFace,
  projectToCubeFace,
} from '../../../core/coords';
import { Biome } from '../../../worldgen/biomes';
import { RIVER_SEGMENT_FIELDS } from '../../../worldgen/riverIndex';
import { naturalBank, waterDistance } from '../../common/water/naturalBanks';
import type { RiverIndex } from '../../../worldgen/riverIndex';
import { FARMABLE_BIOMES } from '../../common/palette';
import type { InfraScene, RoadStretch } from '../infra/infraScene';
import { habitabilityAt } from '../../common/habitabilityTexture';
import { rng } from '../../../core/rng';
import type { WorldSeed } from '../../../core/rng';
import {
  tileForDirection,
  tileKey,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import {
  CANOPY_THRESHOLD,
  canopySeed,
  cellHash,
  edgeDraw,
  fieldAt,
  hashBits,
  hedgeShare,
  regionalTerm,
  coniferShare,
  EDGE_TREES,
  edgeRise,
  pineShare,
  standAt,
  standTop,
  tropicalShare,
} from '../../../worldgen/canopy';
import { LAPSE_RATE } from '../../../worldgen/climate';
import { drawnEarthElevation } from '../../common/seasons';
import { MAX_BAKED_LEVEL, NO_LAKE } from '../../../worldgen/gpu/tileSynth';
import type { TileData } from '../../../worldgen/gpu/tileSynth';
import type { ClimateTexture } from '../../common/climateTexture';
import { buildModel } from '../../common/models/builder';
import type { BuiltModel } from '../../common/models/builder';
import { MODEL_SPECS } from '../../common/models/library';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { LandShading } from '../terrain/landShading';
import type { TerrainRenderer } from '../terrain/terrainRenderer';
import { lakeSampler, mapSample, surfaceSampler } from '../../common/terrain/tileMesh';
import { WARMEST_PHASE } from '../../common/seasons';
import { foliage, LEAFLESS_JITTER, LEAFLESS_T } from './foliage';
import type { MeshOptions } from '../../common/terrain/tileMesh';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Level of the tiles trees are placed per (about 1.5 km on the campaign planet)... */
export const TREE_TILE_LEVEL = 10;
/** ...in TREE_SPLIT² parts each (about 770 m), so a part places within a frame's budget. */
export const TREE_SPLIT = 2;
/** Crown lattice in closed forest (m): crowns are about 8–11 m wide, so they touch. */
export const CROWN_SPACING = 8;
/** Lattice of open-land and fringe trees (m). */
export const OPEN_SPACING = 18;
/** Hedgerows (decision 162): lattice (m), half-width of the band along a field boundary (m), share of trees. */
export const HEDGE_SPACING = 3.5;
export const HEDGE_HALF_WIDTH = 1.6;
export const HEDGE_TREES = 0.1;
/** Tree rows along roads (decision 162): spacing (m) and the share of roads with rows, by class. */
export const ROW_SPACING = 11;
export const ROW_SHARE = [0.08, 0.2, 0.3];
/**
 * Woods along rivers (decision 166): spacing along the bank (m), the rows out from the
 * bank and their chance of a tree, and how far beyond the water the first row stands (m).
 */
export const GALLERY_SPACING = 7;
export const GALLERY_ROWS = [0.85, 0.6, 0.35, 0.15];
export const GALLERY_ROW_WIDTH = 7;
export const GALLERY_BANK = 3;
/** Trees keep this far from the drawn water's edge (m; decision 177). */
export const TREE_WATER_MARGIN = 1.5;
/** Landmark trees (decision 166): the chance of one in each part of open land (about 770 m). */
export const LANDMARK_SHARE = 0.3;
const SEED_GALLERY = 0x2f7d61;
/** Biomes above the tree line or without trees: no woods along rivers, no landmarks. */
const TREELESS = new Set<number>([
  Biome.IceSheet,
  Biome.Tundra,
  Biome.Alpine,
  Biome.ColdDesert,
  Biome.RockyDesert,
  Biome.RedRockDesert,
  Biome.FogDesert,
]);
const SEED_LANDMARK = 0x59c3a8;
export const SEED_ROW = 0x4ac215;
/** Level whose mesh surface the trees stand on. */
const GROUND_LEVEL = 10;
/** How far around a tree its neighborhood must be closed forest for a crown-only tree (m). */
const INTERIOR_REACH = 11;

/** The kit's types, each with a whole and, where it has a trunk, a crown-only variant. */
export const TREE_KINDS = [
  'tree-fir',
  'tree-pine',
  'tree-oak',
  'tree-broadleaf',
  'tree-birch',
  'tree-poplar',
  'tree-acacia',
  'tree-shrub',
  'tree-dead',
] as const;
export type TreeKind = (typeof TREE_KINDS)[number];
export type TreeVariant = 'whole' | 'crown';
/** Kinds whose crowns turn in the fall and drop their leaves in winter, with their bare models. */
const DECIDUOUS = new Set<TreeKind>(['tree-oak', 'tree-broadleaf', 'tree-birch', 'tree-poplar']);
const BARE: Partial<Record<TreeKind, string>> = {
  'tree-oak': 'tree-bare',
  'tree-broadleaf': 'tree-bare',
  'tree-birch': 'tree-birch-bare',
  'tree-poplar': 'tree-bare',
};
/** Fall hue by kind (0 yellow, 0.5 orange, 1 red): base and spread across trees. */
const FALL_HUE: Partial<Record<TreeKind, [number, number]>> = {
  'tree-birch': [0.05, 0.1],
  'tree-poplar': [0.08, 0.15],
  'tree-oak': [0.7, 0.6],
  'tree-broadleaf': [0.5, 1],
};
/** Groups that make up a trunk, dropped from crown-only trees. */
const TRUNK_GROUPS = new Set(['trunk', 'wood']);

/**
 * Floats per placed tree: base xyz, up xyz, raw height, scale, angle, shade
 * (the GPU_FLOATS uploaded per instance), then the annual mean temperature at
 * the tree (°C) and the seasonal half-range (K), for the leafless swap.
 */
export const INSTANCE_FLOATS = 12;
export const GPU_FLOATS = 10;

/** A part of a tile: column `i`, row `j` of TREE_SPLIT². */
export interface TreePart {
  i: number;
  j: number;
}

/** Instances of one tile part, by `kind/variant`. */
export interface TreeInstances {
  tile: TileKey;
  part: TreePart;
  origin: Vec3d;
  lists: Map<string, Float32Array>;
}

/** What placement needs beyond the tile's data. */
export interface TreeContext {
  /** Climate at a direction: (sea-level °C, half-range K, moisture, valley floor m). */
  climate: (d: Readonly<Vec3d>, out: Float32Array) => Float32Array;
  /** Directions where no tree may stand (towns, airfields, roads; decision 65), widened by `extra` m. */
  clear?: (d: Readonly<Vec3d>, extra?: number) => boolean;
  /** The strategic graph's habitability 0..1 at a direction: hedges grow on farmland (decision 162). */
  habitability?: (d: Readonly<Vec3d>) => number;
  /** Road stretches through a level-10 tile (by key string): rows of trees (decision 162). */
  roads?: (tile: string) => readonly RoadStretch[];
  /** A fixed share of hedged field boundaries in place of the climate's (previews, the GUI). */
  hedgeShare?: number;
  /** River stretches near a level-10 tile: woods along their banks (decision 166). */
  rivers?: (tile: TileKey) => readonly RiverStretch[];
}

/** A stretch of river for the woods along it (decision 166). */
export interface RiverStretch {
  /** Unit directions of its ends. */
  a: Vec3d;
  b: Vec3d;
  /** Width of the water (m). */
  width: number;
  /** The segment's index, for its draws. */
  id: number;
}

/** Bilinear forest density (0..1) at fractional sample coordinates of a data tile. */
function forestAt(data: TileData, fx: number, fy: number): number {
  const lo = -TILE_BORDER;
  const hi = TILE_TEXELS + TILE_BORDER;
  const x = Math.min(hi, Math.max(lo, fx));
  const y = Math.min(hi, Math.max(lo, fy));
  const x0 = Math.min(hi - 1, Math.floor(x));
  const y0 = Math.min(hi - 1, Math.floor(y));
  const tx = x - x0;
  const ty = y - y0;
  const m = data.material;
  const i = (y0 + TILE_BORDER) * TILE_STRIDE + x0 + TILE_BORDER;
  const f = (k: number) => (m[k]! >>> 24) / 255;
  return (
    (f(i) * (1 - tx) + f(i + 1) * tx) * (1 - ty) +
    (f(i + TILE_STRIDE) * (1 - tx) + f(i + TILE_STRIDE + 1) * tx) * ty
  );
}

/** The level-7 data tile that holds `t`'s samples. */
export function treeDataTile(t: TileKey): TileKey {
  const s = t.level - MAX_BAKED_LEVEL;
  return tileKey(t.face, MAX_BAKED_LEVEL, t.x >> s, t.y >> s);
}

/** Height of each kit model (m), for scaling a tree's top to the canopy height. */
const MODEL_HEIGHT = new Map<TreeKind, number>();
function modelHeight(kind: TreeKind): number {
  let h = MODEL_HEIGHT.get(kind);
  if (h === undefined) {
    h = buildModel(MODEL_SPECS[kind]!, { noAo: true }).bounds.max[1];
    MODEL_HEIGHT.set(kind, h);
  }
  return h;
}

/** Places the trees of part `part` of level-10 tile `t`, deterministically. Pure: no GPU. */
export function placeTrees(
  t: TileKey,
  data: TileData,
  opts: MeshOptions,
  seed: WorldSeed,
  ctx: TreeContext,
  part: TreePart = { i: 0, j: 0 },
): TreeInstances {
  const it = treePlacer(t, data, opts, seed, ctx, part);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/**
 * `placeTrees` a lattice row at a time: yields after each row, so a caller can
 * spread a part's placement over frames (a dense part takes tens of
 * milliseconds); returns the instances.
 */
export function* treePlacer(
  t: TileKey,
  data: TileData,
  opts: MeshOptions,
  seed: WorldSeed,
  ctx: TreeContext,
  part: TreePart = { i: 0, j: 0 },
): Generator<void, TreeInstances, void> {
  const R = opts.radius;
  const size = TILE_TEXELS * (1 << t.level);
  const sampleM = ((Math.PI / 2) * R) / size;
  const ground = surfaceSampler(t, GROUND_LEVEL, data, opts);
  const lake = lakeSampler(t, data);
  const cSeed = canopySeed(seed);
  const r = rng(seed, 'trees').fork(`${tileKeyString(t)}/${part.i}${part.j}`);
  // The part's sample range [x0, x0 + span) × [y0, y0 + span).
  const span = TILE_TEXELS / TREE_SPLIT;
  const x0 = part.i * span;
  const y0 = part.j * span;
  const origin = cubeFaceUvToDirection(
    t.face,
    (t.x * TILE_TEXELS + x0 + span / 2) / size,
    (t.y * TILE_TEXELS + y0 + span / 2) / size,
  ).scale(R);
  const out = new Map<string, number[]>();
  const d = new Vec3d();
  const climate = new Float32Array(4);
  const reach = INTERIOR_REACH / sampleM;
  const density = (sx: number, sy: number) => {
    const [fx, fy] = mapSample(t, data.key, sx, sy);
    return forestAt(data, fx, fy);
  };

  /** The biome at the data sample nearest (sx, sy). */
  const biomeAt = (sx: number, sy: number): number => {
    const [fx, fy] = mapSample(t, data.key, sx, sy);
    const x = Math.min(TILE_TEXELS + TILE_BORDER, Math.max(-TILE_BORDER, Math.round(fx)));
    const y = Math.min(TILE_TEXELS + TILE_BORDER, Math.max(-TILE_BORDER, Math.round(fy)));
    return data.material[(y + TILE_BORDER) * TILE_STRIDE + x + TILE_BORDER]! & 0xff;
  };
  const scratch = new Vec3d();
  /** The direction of sample (sx, sy), in a scratch vector. */
  const scratchDir = (sx: number, sy: number): Vec3d =>
    cubeFaceUvToDirection(
      t.face,
      (t.x * TILE_TEXELS + sx) / size,
      (t.y * TILE_TEXELS + sy) / size,
      scratch,
    );

  // River stretches near the tile: woods along them (below), and every tree keeps out of
  // the water the shader draws, natural banks included (decision 177).
  const stretches = ctx.rivers?.(t) ?? [];
  /** Ground direction and raw height at sample (sx, sy), or null in water, a lake or a clearing. */
  const site = (sx: number, sy: number): number | null => {
    cubeFaceUvToDirection(
      t.face,
      (t.x * TILE_TEXELS + sx) / size,
      (t.y * TILE_TEXELS + sy) / size,
      d,
    );
    const h = ground(sx, sy, d);
    const level = lake(sx, sy);
    if (h <= 0 || (level > NO_LAKE / 2 && level > h)) return null;
    if (ctx.clear?.(d)) return null;
    if (stretches.length > 0 && waterDistance(stretches, d, h, R) < TREE_WATER_MARGIN) return null;
    return h;
  };
  let meanT = 0;
  /** Climate at the current site: sets the annual mean `meanT` (°C) there. */
  const climateHere = (h: number) => {
    ctx.climate(d, climate);
    meanT = climate[0]! - drawnEarthElevation(h, climate[3]!, opts.reliefScale) * LAPSE_RATE;
  };
  const push = (
    kind: TreeKind,
    variant: TreeVariant,
    h: number,
    scale: number,
    angle: number,
    shade: number,
  ) => {
    const key = `${kind}/${variant}`;
    let list = out.get(key);
    if (!list) out.set(key, (list = []));
    list.push(
      d.x * R - origin.x,
      d.y * R - origin.y,
      d.z * R - origin.z,
      d.x,
      d.y,
      d.z,
      h,
      scale,
      angle,
      shade,
      meanT,
      climate[1]!,
    );
  };
  /** A tree of a stand: its kind by the stand and the temperature, its top at `top` m. */
  const standTree = (stand: { conifer: number }, tropical: number, pick: number): TreeKind =>
    stand.conifer
      ? pick < pineShare(meanT)
        ? 'tree-pine'
        : 'tree-fir'
      : pick < 0.45 || tropical > 0.5
        ? 'tree-broadleaf'
        : pick < 0.8
          ? 'tree-oak'
          : 'tree-birch';

  // Closed forest: a crown lattice, each tree at its stand's canopy top.
  const step = CROWN_SPACING / sampleM;
  const cells = Math.ceil(span / step);
  for (let b = 0; b < cells; b++) {
    for (let a = 0; a < cells; a++) {
      // Draw every value for every candidate, so results never depend on rejections.
      const jx = r.nextFloat();
      const jy = r.nextFloat();
      const pick = r.nextFloat();
      const size01 = r.nextFloat();
      const angle = r.range(0, 2 * Math.PI);
      const tone = r.range(0.9, 1.1);
      const sx = x0 + (a + 0.15 + 0.7 * jx) * step;
      const sy = y0 + (b + 0.15 + 0.7 * jy) * step;
      if (sx >= x0 + span || sy >= y0 + span) continue;
      const f = density(sx, sy);
      if (f < CANOPY_THRESHOLD) continue;
      const h = site(sx, sy);
      if (h === null) continue;
      climateHere(h);
      const tropical = tropicalShare(meanT);
      const stand = standAt(d.x * R, d.y * R, d.z * R, coniferShare(meanT), tropical, cSeed);
      // Trees at the edge stand lower, growing to the stand's height inside (decision 153).
      const top =
        standTop(stand, d.x * R, d.y * R, d.z * R, cSeed) *
        (EDGE_TREES + (1 - EDGE_TREES) * edgeRise(f)) *
        (0.85 + 0.25 * size01);
      const kind = standTree(stand, tropical, pick);
      // Inside a stand, crowns only; at its edge, along a road lane or by a town, whole
      // trees (decision 166): their trunks show where the shell slopes down.
      const interior =
        density(sx + reach, sy) >= CANOPY_THRESHOLD &&
        density(sx - reach, sy) >= CANOPY_THRESHOLD &&
        density(sx, sy + reach) >= CANOPY_THRESHOLD &&
        density(sx, sy - reach) >= CANOPY_THRESHOLD &&
        !ctx.clear?.(d, INTERIOR_REACH);
      push(
        kind,
        interior ? 'crown' : 'whole',
        h,
        top / modelHeight(kind),
        angle,
        // Tropical trees keep their leaves: a negative shade marks them evergreen.
        stand.shade * tone * (tropical > 0.5 ? -1 : 1),
      );
    }
    yield;
  }

  // Open land and the fringe: scattered trees and shrubs, more toward the forest.
  const openStep = OPEN_SPACING / sampleM;
  const openCells = Math.ceil(span / openStep);
  for (let b = 0; b < openCells; b++) {
    for (let a = 0; a < openCells; a++) {
      const jx = r.nextFloat();
      const jy = r.nextFloat();
      const keep = r.nextFloat();
      const pick = r.nextFloat();
      const scale = r.range(0.8, 1.25);
      const angle = r.range(0, 2 * Math.PI);
      const tone = r.range(0.88, 1.12);
      const sx = x0 + (a + jx) * openStep;
      const sy = y0 + (b + jy) * openStep;
      if (sx >= x0 + span || sy >= y0 + span) continue;
      const f = density(sx, sy);
      if (f >= CANOPY_THRESHOLD || f < 0.03) continue;
      // The fringe (within 0.15 of the threshold) is half full; open land by its density.
      const fringe = smooth(CANOPY_THRESHOLD - 0.15, CANOPY_THRESHOLD, f);
      if (keep >= 0.5 * fringe + 0.35 * f * (1 - fringe)) continue;
      const h = site(sx, sy);
      if (h === null) continue;
      climateHere(h);
      const moisture = climate[2]!;
      const conifers = coniferShare(meanT);
      if (fringe > 0.25 && pick >= 0.3) {
        // The fringe takes after the forest beside it: the stand's kinds, lower (decision 153).
        const tropical = tropicalShare(meanT);
        const stand = standAt(d.x * R, d.y * R, d.z * R, conifers, tropical, cSeed);
        const kind = standTree(stand, tropical, (pick - 0.3) / 0.7);
        const top = stand.height * EDGE_TREES * (0.75 + (0.35 * (scale - 0.8)) / 0.45);
        const evergreen = tropical > 0.5 ? -1 : 1;
        push(kind, 'whole', h, top / modelHeight(kind), angle, stand.shade * tone * evergreen);
        continue;
      }
      let kind: TreeKind;
      const biome = biomeAt(sx, sy);
      if (pick < 0.4) kind = 'tree-shrub';
      // Acacias in savanna only, not before other forest (decision 162).
      else if (biome === Biome.Savanna)
        kind = pick < 0.95 || f > 0.15 ? 'tree-acacia' : 'tree-dead';
      else if (meanT > 18 && moisture < 0.3) kind = 'tree-shrub';
      // The cold is all conifer: firs and shrubs, no birch (decision 153).
      else if (conifers > 0.9) kind = 'tree-fir';
      else if (conifers > 0.5) kind = pick < 0.75 ? 'tree-fir' : 'tree-birch';
      else kind = pick < 0.6 ? 'tree-birch' : pick < 0.85 ? 'tree-broadleaf' : 'tree-oak';
      push(kind, 'whole', h, scale, angle, tone * (tropicalShare(meanT) > 0.5 ? -1 : 1));
    }
    yield;
  }

  // Hedgerows (decision 162): along the boundaries of the fields the terrain paints, on a
  // jittered lattice, in the share of boundaries the climate and the region hedge. Parts
  // without settled, farmable land or without hedges skip the lattice.
  const hedgeIndex = (sx: number, sy: number): number => {
    cubeFaceUvToDirection(
      t.face,
      (t.x * TILE_TEXELS + sx) / size,
      (t.y * TILE_TEXELS + sy) / size,
      d,
    );
    if ((ctx.habitability?.(d) ?? 0) < 0.3) return 0;
    if (ctx.hedgeShare !== undefined) return ctx.hedgeShare;
    ctx.climate(d, climate);
    return hedgeShare(
      climate[1]!,
      climate[2]!,
      climate[0]! -
        drawnEarthElevation(Math.max(0, climate[3]!), climate[3]!, opts.reliefScale) * LAPSE_RATE,
      0.05,
      regionalTerm(d.x * R, d.y * R, d.z * R, cSeed),
    );
  };
  const probes = [0.15, 0.5, 0.85].flatMap((u) =>
    [0.15, 0.5, 0.85].map((v) => hedgeIndex(x0 + u * span, y0 + v * span)),
  );
  if (ctx.habitability && Math.max(...probes) > 0) {
    const hedgeStep = HEDGE_SPACING / sampleM;
    const hedgeCells = Math.ceil(span / hedgeStep);
    for (let b = 0; b < hedgeCells; b++) {
      for (let a = 0; a < hedgeCells; a++) {
        const jx = r.nextFloat();
        const jy = r.nextFloat();
        const pick = r.nextFloat();
        const size01 = r.nextFloat();
        const angle = r.range(0, 2 * Math.PI);
        const tone = r.range(0.88, 1.12);
        const sx = x0 + (a + jx) * hedgeStep;
        const sy = y0 + (b + jy) * hedgeStep;
        if (sx >= x0 + span || sy >= y0 + span) continue;
        cubeFaceUvToDirection(
          t.face,
          (t.x * TILE_TEXELS + sx) / size,
          (t.y * TILE_TEXELS + sy) / size,
          d,
        );
        const field = fieldAt(d.x * R, d.y * R, d.z * R, cSeed);
        if (field.edge > HEDGE_HALF_WIDTH) continue;
        if (density(sx, sy) >= CANOPY_THRESHOLD - 0.1) continue;
        if (!FARMABLE_BIOMES.has(biomeAt(sx, sy))) continue;
        const hab = ctx.habitability(d);
        if (hab < 0.35) continue;
        const h = site(sx, sy);
        if (h === null) continue;
        climateHere(h);
        // Farmland is flat lowland (decision 127): about 7° and 1.5 km at most.
        const step1 = 1;
        const hx = ground(sx + step1, sy, scratchDir(sx + step1, sy));
        const hy = ground(sx, sy + step1, scratchDir(sx, sy + step1));
        cubeFaceUvToDirection(
          t.face,
          (t.x * TILE_TEXELS + sx) / size,
          (t.y * TILE_TEXELS + sy) / size,
          d,
        );
        const slope = Math.hypot(hx - h, hy - h) / (step1 * sampleM);
        if (slope > 0.12) continue;
        if (drawnEarthElevation(h, climate[3]!, opts.reliefScale) > 1500) continue;
        const share =
          ctx.hedgeShare ??
          hedgeShare(
            climate[1]!,
            climate[2]!,
            meanT,
            slope,
            regionalTerm(d.x * R, d.y * R, d.z * R, cSeed),
          );
        if (edgeDraw(field.cell, field.cell2, cSeed) >= share) continue;
        const tropical = tropicalShare(meanT);
        const evergreen = tropical > 0.5 ? -1 : 1;
        if (pick < HEDGE_TREES) {
          // A tree standing out of the hedge: oak, broadleaf, birch; firs in the cold.
          const conifers = coniferShare(meanT);
          const k = pick / HEDGE_TREES;
          const kind: TreeKind =
            conifers > 0.9
              ? 'tree-fir'
              : k < 0.5
                ? 'tree-oak'
                : k < 0.8
                  ? 'tree-broadleaf'
                  : 'tree-birch';
          push(kind, 'whole', h, 0.6 + 0.4 * size01, angle, tone * evergreen);
        } else {
          push('tree-shrub', 'whole', h, 1.2 + 0.5 * size01, angle, tone * evergreen);
        }
      }
      yield;
    }
  }

  // Rows of trees along roads (decision 162): a share of roads, on one side or both, just
  // outside the road's clearing, poplars in temperate land, birches in the cold.
  for (const st of ctx.roads?.(tileKeyString(t)) ?? []) {
    const roadHash = cellHash(st.road, 0, 0, cSeed ^ SEED_ROW);
    if (hashBits(roadHash, 0) >= ROW_SHARE[st.roadClass]!) continue;
    const length = st.a.distanceTo(st.b) * R;
    const sides = hashBits(roadHash, 10) < 0.5 ? [1, -1] : [hashBits(roadHash, 10) < 0.75 ? 1 : -1];
    const first = Math.ceil(st.along / ROW_SPACING);
    const last = Math.floor((st.along + length) / ROW_SPACING);
    const ab = st.b.clone().sub(st.a);
    for (let k = first; k <= last; k++) {
      const u = (k * ROW_SPACING - st.along) / Math.max(length, 1e-6);
      const on = st.a
        .clone()
        .scale(1 - u)
        .addScaled(st.b, u)
        .normalize();
      const across = on.clone().cross(ab).normalize();
      for (const side of sides) {
        const draw = cellHash(st.road, k, side, cSeed ^ SEED_ROW);
        const p = on
          .clone()
          .addScaled(across, (side * (st.clearing + 2.5)) / R)
          .normalize();
        const uv = projectToCubeFace(p, t.face);
        const sx = uv.u * size - t.x * TILE_TEXELS;
        const sy = uv.v * size - t.y * TILE_TEXELS;
        if (!(sx >= x0 && sx < x0 + span && sy >= y0 && sy < y0 + span)) continue;
        if (density(sx, sy) >= CANOPY_THRESHOLD - 0.1) continue;
        // A few gaps: field gates and lanes.
        if (hashBits(draw, 0) < 0.08) continue;
        const h = site(sx, sy);
        if (h === null) continue;
        climateHere(h);
        // No rows in arid land; dry farmland keeps its lines of poplars.
        if (climate[2]! < 0.12) continue;
        const tropical = tropicalShare(meanT);
        const kind: TreeKind =
          tropical > 0.5 || meanT > 18
            ? 'tree-broadleaf'
            : coniferShare(meanT) > 0.6
              ? 'tree-birch'
              : hashBits(roadHash, 20) < 0.65
                ? 'tree-poplar'
                : 'tree-broadleaf';
        const scale = 0.9 + 0.25 * hashBits(draw, 10);
        push(
          kind,
          'whole',
          h,
          scale,
          hashBits(draw, 20) * 2 * Math.PI,
          (0.9 + 0.2 * hashBits(draw, 5)) * (tropical > 0.5 ? -1 : 1),
        );
      }
    }
    yield;
  }

  // Woods along rivers and streams (decision 166): rows of trees out from each bank, the
  // nearest row nearly full, the outer ones thinning; in open land below the tree line
  // only (forest is already there). Willow-like broadleaf, poplar and birch in temperate
  // land, firs with a few birches in the cold, broadleaf (evergreen) in the tropics and in
  // hot, dry land, where the gallery may be the only trees.
  for (const st of stretches) {
    const length = st.a.distanceTo(st.b) * R;
    if (length < 1) continue;
    const ab = st.b.clone().sub(st.a);
    const across = st.a.clone().cross(ab).normalize();
    const steps = Math.floor(length / GALLERY_SPACING);
    for (let k = 0; k <= steps; k++) {
      for (const side of [1, -1]) {
        for (let row = 0; row < GALLERY_ROWS.length; row++) {
          const draw = cellHash(st.id, k, side * 8 + row, cSeed ^ SEED_GALLERY);
          if (hashBits(draw, 0) >= GALLERY_ROWS[row]!) continue;
          const u = (k + hashBits(draw, 10) * 0.8) / Math.max(steps + 1, 1);
          const on = st.a
            .clone()
            .scale(1 - u)
            .addScaled(st.b, u)
            .normalize();
          // Rows out from the drawn bank, which the shader moves and swells (decision 177):
          // the bank noise at the centerline point, at its ground height.
          const ouv = projectToCubeFace(on, t.face);
          const h0 = ground(ouv.u * size - t.x * TILE_TEXELS, ouv.v * size - t.y * TILE_TEXELS, on);
          const rr = R + Math.max(h0, 0);
          const bank = naturalBank(on.x * rr, on.y * rr, on.z * rr, st.width / 2);
          const out =
            (st.width / 2) * bank.swell +
            Math.max(bank.rough, 0) +
            GALLERY_BANK +
            (row + hashBits(draw, 20) * 0.7) * GALLERY_ROW_WIDTH;
          const p = on.addScaled(across, (side * out + bank.offset) / R).normalize();
          const uv = projectToCubeFace(p, t.face);
          const sx = uv.u * size - t.x * TILE_TEXELS;
          const sy = uv.v * size - t.y * TILE_TEXELS;
          if (!(sx >= x0 && sx < x0 + span && sy >= y0 && sy < y0 + span)) continue;
          if (density(sx, sy) >= CANOPY_THRESHOLD - 0.1) continue;
          if (TREELESS.has(biomeAt(sx, sy))) continue;
          const h = site(sx, sy);
          if (h === null) continue;
          climateHere(h);
          if (climate[2]! < 0.05) continue;
          const tropical = tropicalShare(meanT);
          const conifers = coniferShare(meanT);
          const pick = hashBits(draw, 5);
          // The cold is all conifer, as in open land (decision 153).
          const kind: TreeKind =
            tropical > 0.5 || meanT > 18
              ? 'tree-broadleaf'
              : conifers > 0.9
                ? 'tree-fir'
                : conifers > 0.5
                  ? pick < 0.75
                    ? 'tree-fir'
                    : 'tree-birch'
                  : pick < 0.45
                    ? 'tree-broadleaf'
                    : pick < 0.75
                      ? 'tree-poplar'
                      : 'tree-birch';
          const scale = 0.75 + 0.4 * hashBits(cellHash(draw, 1, 0, 0), 0);
          const tone =
            (0.88 + 0.24 * hashBits(cellHash(draw, 2, 0, 0), 0)) * (tropical > 0.5 ? -1 : 1);
          push(kind, 'whole', h, scale, hashBits(cellHash(draw, 3, 0, 0), 0) * 2 * Math.PI, tone);
        }
      }
    }
    yield;
  }

  // A landmark (decision 166): in some parts of open land one large lone tree, the same
  // every time, that a low-flying pilot can steer by. The part is a level-11 cell.
  {
    const lh = cellHash(
      t.face,
      t.x * TREE_SPLIT + part.i,
      t.y * TREE_SPLIT + part.j,
      cSeed ^ SEED_LANDMARK,
    );
    if (hashBits(lh, 0) < LANDMARK_SHARE) {
      const sx = x0 + (0.15 + 0.7 * hashBits(lh, 10)) * span;
      const sy = y0 + (0.15 + 0.7 * hashBits(lh, 20)) * span;
      let h = density(sx, sy) < 0.2 && !TREELESS.has(biomeAt(sx, sy)) ? site(sx, sy) : null;
      // Well clear of the drawn water (site() leaves `d` at the sample's direction).
      if (h !== null && stretches.length > 0 && waterDistance(stretches, d, h, R) < 15) h = null;
      if (h !== null) {
        climateHere(h);
        const biome = biomeAt(sx, sy);
        const tropical = tropicalShare(meanT);
        const big = 1.55 + 0.4 * hashBits(lh, 5);
        const angle = hashBits(lh, 15) * 2 * Math.PI;
        const evergreen = tropical > 0.5 ? -1 : 1;
        if (biome === Biome.Savanna) push('tree-acacia', 'whole', h, big, angle, 1);
        else if (climate[2]! < 0.2) push('tree-dead', 'whole', h, big, angle, 1);
        else if (coniferShare(meanT) > 0.7) push('tree-fir', 'whole', h, big * 0.9, angle, 1);
        else if (tropical > 0.5) push('tree-broadleaf', 'whole', h, big, angle, evergreen);
        else push('tree-oak', 'whole', h, big, angle, 1);
      }
    }
  }

  const lists = new Map<string, Float32Array>();
  for (const [k, v] of out) lists.set(k, Float32Array.from(v));
  return { tile: t, part, origin, lists };
}

function smooth(e0: number, e1: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
}

/** The river segments that may reach a level-10 tile, as stretches (decision 166). */
export function riverStretches(rivers: RiverIndex, k: TileKey, radius: number): RiverStretch[] {
  const seg = rivers.segments.data;
  const f = rivers.segments.fields ?? RIVER_SEGMENT_FIELDS;
  return rivers.forTile(k, 80, radius).map((s) => ({
    a: new Vec3d(seg[s * f]!, seg[s * f + 1]!, seg[s * f + 2]!),
    b: new Vec3d(seg[s * f + 3]!, seg[s * f + 4]!, seg[s * f + 5]!),
    width: (seg[s * f + 6]! + seg[s * f + 7]!) / 2,
    id: s,
  }));
}

/** A kit model's geometry for a variant: crowns drop the trunk's triangles. */
export function treeGeometry(
  model: BuiltModel,
  variant: TreeVariant,
): { position: Float32Array; normal: Float32Array; color: Float32Array } {
  const keep: number[] = [];
  for (let t = 0; t < model.triangles; t++) {
    const group = model.groupNames[model.group[t]!]!;
    if (variant === 'crown' && TRUNK_GROUPS.has(group)) continue;
    keep.push(t);
  }
  const n = keep.length * 9;
  const position = new Float32Array(n);
  const normal = new Float32Array(n);
  const color = new Float32Array(n);
  keep.forEach((t, k) => {
    position.set(model.position.subarray(t * 9, t * 9 + 9), k * 9);
    normal.set(model.normal.subarray(t * 9, t * 9 + 9), k * 9);
    for (let v = 0; v < 3; v++) {
      const ao = model.ao[t * 3 + v]!;
      for (let c = 0; c < 3; c++) color[k * 9 + v * 3 + c] = model.color[t * 9 + v * 3 + c]! * ao;
    }
  });
  return { position, normal, color };
}

/** One instance list of a part and the meshes its trees are compacted into. */
interface TreeList {
  data: Float32Array;
  range: 'near' | 'edge';
  /** [near, far, leafless]; any may be absent (no geometry, or an evergreen kind). */
  meshes: (Mesh | null)[];
}

interface TreeTile {
  meshes: Mesh[];
  lists: TreeList[];
  origin: Vec3d;
  lastUsed: number;
  /** Where its trees stand, for the frustum test (decision 131). */
  extent: InstanceExtent;
  /** The eye (m) at the last compaction, or null. */
  compactedAt: Vec3d | null;
  /** In view and in range this frame. */
  seen: boolean;
}

/** A part's trees are re-sorted into its meshes after the camera moves this far (m). */
export const COMPACT_STEP = 25;

/** Height of the tallest tree plus a crown's spread (m): the bounding sphere's margin. */
const TREE_MARGIN = 50;

/** A tree's tip lean in a rotor's wash per m/s of outwash (share of its height), and its most (decision 191). */
const TREE_WASH_LEAN = 0.006;
const TREE_WASH_MAX = 0.08;

export class ForestLayer {
  readonly group = new Group();
  /** Trees on (the simulation view's forests, decision 148). */
  enabled = true;
  /** Crowns inside stands show within this distance (m); the shell is their understory. */
  readonly nearRange = uniform(600);
  /** Whole trees (edges, fringe, open land) show within this distance (m). */
  readonly edgeRange = uniform(1200);
  /** A fixed share of hedged field boundaries in place of the climate's, or null (decision 162). */
  hedgeShareOverride: number | null = null;
  /** Beyond this distance trees take their far model (m). */
  readonly lodDistance = uniform(350);

  /** Above this height over the ground, no trees are built or drawn (m). */
  maxAltitude = 4000;
  /** Milliseconds per frame spent placing trees, and sorting placed trees into meshes. */
  buildBudgetMs = 4;
  compactBudgetMs = 2;
  /** Built tiles, drawn trees, and wanted tiles still waiting to be built. */
  readonly stats = { tiles: 0, instances: 0, pending: 0, triangles: 0 };

  private readonly tiles = new Map<string, TreeTile>();
  /** A rotor's wash, camera-relative (decision 191). */
  private readonly wash = {
    center: uniform(new Vector3(0, -1e7, 0)),
    speed: uniform(0),
    radius: uniform(4),
    time: uniform(0),
  };
  /** Parts being placed, a few rows per frame. */
  private readonly building = new Map<string, Generator<void, TreeInstances, void>>();
  private readonly material: MeshBasicNodeMaterial;
  private readonly geometries = new Map<string, ReturnType<typeof treeGeometry>>();
  private frame = 0;
  private readonly scratch = new Vec3d();
  private readonly center = new Vec3d();
  private lastWorld: unknown = null;
  private clearings: ((d: Readonly<Vec3d>, extra?: number) => boolean) | undefined;
  private habitability: ((d: Readonly<Vec3d>) => number) | undefined;
  private roads: ((key: string) => readonly RoadStretch[]) | undefined;
  /** The season the parts were last compacted for: phase (years) and temperature offset. */
  private compactedSeason = [NaN, NaN];

  constructor(
    private readonly terrain: TerrainRenderer,
    lighting: PlanetLighting,
    private readonly climate: ClimateTexture,
    private readonly land: LandShading,
  ) {
    for (const id of new Set(Object.values(BARE)))
      this.geometries.set(id, treeGeometry(buildModel(MODEL_SPECS[id]!), 'whole'));
    for (const kind of TREE_KINDS) {
      const model = buildModel(MODEL_SPECS[kind]!);
      // The far model where the kit has one (`<kind>-lod`), else the same.
      const far = MODEL_SPECS[`${kind}-lod`] ? buildModel(MODEL_SPECS[`${kind}-lod`]!) : model;
      for (const variant of ['whole', 'crown'] as const) {
        this.geometries.set(`${kind}/${variant}/0`, treeGeometry(model, variant));
        this.geometries.set(`${kind}/${variant}/1`, treeGeometry(far, variant));
      }
    }
    this.material = this.buildMaterial(lighting, climate, land);
  }

  private buildMaterial(
    lighting: PlanetLighting,
    climate: ClimateTexture,
    land: LandShading,
  ): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const base = attribute('iBase', 'vec3');
    const up = normalize(attribute('iUp', 'vec3'));
    const params = attribute('iParams', 'vec4'); // raw height, scale, angle, shade
    const ex = this.terrain.exaggerationUniform;
    const perMesh = (key: string, fallback: number) =>
      uniform(fallback).onObjectUpdate(
        ({ object }) =>
          ((object as Mesh | undefined)?.userData[key] as number | undefined) ?? fallback,
      );
    // Crowns inside stands use the near range, whole trees the edge range.
    const range = perMesh('range', 1000);
    const deciduous = perMesh('deciduous', 0);
    const fallBase = perMesh('fallBase', 0.5);
    const fallSpread = perMesh('fallSpread', 1);
    // The model's height (model units), for bending it from the root in a rotor's wash.
    const modelTop = perMesh('height', 12);
    const wash = this.wash;

    // Tree frame: up, and two tangents rotated by the instance angle.
    const t0 = normalize(cross(up, vec3(0.0001, 1, 0.0002)));
    const t1 = cross(up, t0);
    const ca = cos(params.z);
    const sa = sin(params.z);
    const ax = t0.mul(ca).add(t1.mul(sa));
    const az = t1.mul(ca).sub(t0.mul(sa));
    const local = attribute('position', 'vec3');
    const ground = base.add(up.mul(max(params.x, 0).mul(ex)));

    const apInscatter = varyingProperty('vec3', 'vTreeInscatter');
    const apTransmittance = varyingProperty('vec3', 'vTreeTransmittance');
    m.positionNode = Fn(() => {
      // Shrink away over the last 30% of the range (a smooth ramp), into the rising canopy shell.
      const groundRel = modelWorldMatrix.mul(vec4(ground, 1)).xyz;
      const dist = groundRel.length();
      const k = clamp(range.sub(dist).div(max(range.mul(0.3), 1)), 0, 1);
      const s = params.y.mul(k.mul(k).mul(k.mul(-2).add(3)));
      // A hovering rotor's wash (decision 191): trees lean away from where it meets the
      // ground and buffet, tips most and roots planted, over the reach of the grass's rings.
      const offset = groundRel.sub(wash.center);
      const across = offset.sub(up.mul(dot(offset, up)));
      const r = length(across);
      const R = max(wash.radius, 0.5);
      const reach = smoothstep(0, R.mul(0.5), r)
        .mul(min(float(1), R.mul(1.6).div(max(r, 0.01))))
        .mul(smoothstep(R.mul(8), R.mul(5), r));
      const buffet = sin(wash.time.mul(2.3).add(params.z.mul(5.1)))
        .mul(0.4)
        .add(0.6);
      const lean = min(wash.speed.mul(reach).mul(TREE_WASH_LEAN), TREE_WASH_MAX).mul(buffet);
      const rise = clamp(local.y.div(max(modelTop, 1e-3)), 0, 1);
      const sway = across.div(max(r, 0.01)).mul(lean.mul(rise.mul(rise)).mul(modelTop).mul(s));
      const p = ground
        .add(ax.mul(local.x).add(up.mul(local.y)).add(az.mul(local.z)).mul(s))
        .add(sway);
      const ap = lighting.atmosphere.aerialPerspective(
        modelWorldMatrix.mul(vec4(p, 1)).xyz as V3,
        3,
      );
      apInscatter.assign(ap.inscatter);
      apTransmittance.assign(ap.transmittance);
      return p;
    })();

    const n0 = attribute('normal', 'vec3');
    const normal = normalize(ax.mul(n0.x).add(up.mul(n0.y)).add(az.mul(n0.z))) as V3;
    // A negative shade marks an evergreen tree of a deciduous kind (tropical forest).
    const color = attribute('color', 'vec3').mul(abs(params.w));
    const turns = deciduous.mul(step(0, params.w));
    // Seasons (decisions 43, 153): deciduous crowns turn yellow, orange or red by kind and
    // tree, then brown; leafless trees are drawn with their bare models. Snow settles on crowns.
    const crown = clamp(color.y.sub(color.x).mul(20), 0, 1);
    const sample = climate.sample(up as V3);
    const t = land.surfaceTemperature(sample, params.x, up as V3);
    const hue = fallBase.add(fract(params.z.mul(7.31)).sub(0.5).mul(fallSpread));
    let albedo: V3 = mix(color, foliage(color as V3, t, hue as F), crown.mul(turns)) as V3;
    // Snow where the ground has it (cold and wet enough, decided as on the ground), on
    // upward-facing crowns.
    const snow = land
      // Each tree decides at its own place in the snow line's speckled band (decision 157).
      .snowCover(t, float(0), sample.z, fract(params.z.mul(5.71)), float(1))
      .mul(crown)
      // The sloped faces of a fir's tiers hold snow too, so a snowy conifer reads white.
      .mul(smoothstep(0.05, 0.4, dot(normal, up)));
    albedo = land.wet(albedo);
    albedo = mix(albedo, land.snowColor, snow.mul(0.95)) as V3;
    m.colorNode = lighting.applyAerial(
      lighting.shadeDiffuse(albedo, normal, positionWorld as V3),
      apInscatter as V3,
      apTransmittance as V3,
    );
    return m;
  }

  /** A rotor's downwash this frame (planet-centered center) or null; `dt` runs the buffeting. */
  setDownwash(
    wash: { center: { x: number; y: number; z: number }; speed: number; radius: number } | null,
    eye: Readonly<Vec3d>,
    dt: number,
  ): void {
    this.wash.time.value += dt;
    if (!wash || !(wash.speed > 0)) {
      this.wash.speed.value = 0;
      return;
    }
    this.wash.center.value.set(wash.center.x - eye.x, wash.center.y - eye.y, wash.center.z - eye.z);
    this.wash.speed.value = wash.speed;
    this.wash.radius.value = wash.radius;
  }

  /** Planned towns' built masks (decision 278): true built, false natural, null unplanned. */
  cityBuilt: ((d: Readonly<Vec3d>) => boolean | null) | null = null;

  /** Sets where trees must not stand, and rebuilds the trees. */
  setClearings(clear: ((d: Readonly<Vec3d>) => boolean) | undefined): void {
    this.clearings = clear;
    this.clear();
  }

  /**
   * The infrastructure trees follow (decision 162): its clearings, the habitability
   * that places farmland and its hedgerows, and the roads that carry rows of trees.
   * Rebuilds the trees.
   */
  setInfrastructure(scene: InfraScene | null): void {
    // A planned town clears trees where it builds, and its roads; its woods and parks keep
    // theirs (decision 278). Unplanned towns clear their cores as before.
    this.clearings = scene
      ? (d, extra = 0) => {
          const built = this.cityBuilt?.(d) ?? null;
          return built === null
            ? scene.isClear(d, false, extra)
            : built || scene.isClear(d, true, extra);
        }
      : undefined;
    this.habitability = scene
      ? (d) => habitabilityAt(scene.habitability, scene.habitabilityResolution, d)
      : undefined;
    this.roads = scene ? (key) => scene.roadsInTile(key) : undefined;
    this.clear();
  }

  /**
   * Builds and places the tree tiles around `eye`. With `view`, tiles whose
   * bounding sphere lies outside its frustum are not drawn (decision 131).
   * Call once per frame after the terrain.
   */
  update(eye: Readonly<Vec3d>, heightAboveGround: number, view?: CullView): void {
    this.frame++;
    const world = this.terrain.currentWorld;
    const opts = this.terrain.meshOptions();
    if (world !== this.lastWorld) {
      this.clear();
      this.lastWorld = world;
    }
    const show =
      this.enabled &&
      world !== null &&
      opts !== null &&
      opts.mode === 'biome' &&
      heightAboveGround < this.maxAltitude;
    this.group.visible = show;
    // The canopy shell is the understory of the near crowns (decision 148).
    this.terrain.canopy.nearRadius.value = show ? this.nearRange.value : 0;
    if (!show) return;

    // Tiles whose center lies within reach: sample directions over a disk around the camera.
    const R = opts.radius;
    const range = Math.max(this.nearRange.value, this.edgeRange.value);
    const tileSize = ((Math.PI / 2) * R) / (1 << TREE_TILE_LEVEL);
    const reach = range + tileSize;
    const radial = this.scratch.copy(eye).normalize();
    const east = new Vec3d(0, 1, 0).cross(radial);
    if (east.length() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = radial.clone().cross(east);
    const wanted = new Map<string, { tile: TileKey; part: TreePart }>();
    const step = tileSize / TREE_SPLIT / 2;
    const n = Math.ceil(reach / step);
    const d = new Vec3d();
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        if ((i * i + j * j) * step * step > reach * reach) continue;
        d.copy(radial)
          .addScaled(east, (i * step) / R)
          .addScaled(north, (j * step) / R)
          .normalize();
        const k = tileForDirection(d, TREE_TILE_LEVEL);
        // Which part of the tile the direction falls in.
        const uv = directionToCubeFace(d);
        const size = 1 << TREE_TILE_LEVEL;
        const part = {
          i: Math.min(TREE_SPLIT - 1, Math.floor((uv.u * size - k.x) * TREE_SPLIT)),
          j: Math.min(TREE_SPLIT - 1, Math.floor((uv.v * size - k.y) * TREE_SPLIT)),
        };
        wanted.set(`${tileKeyString(k)}/${part.i}${part.j}`, { tile: k, part });
      }
    }

    // Build missing tiles (nearest first) within the time budget.
    const t0 = performance.now();
    const center = ({ tile: k, part }: { tile: TileKey; part: TreePart }) => {
      const size = TILE_TEXELS * (1 << k.level);
      const span = TILE_TEXELS / TREE_SPLIT;
      return cubeFaceUvToDirection(
        k.face,
        (k.x * TILE_TEXELS + (part.i + 0.5) * span) / size,
        (k.y * TILE_TEXELS + (part.j + 0.5) * span) / size,
      ).distanceTo(radial);
    };
    const missing = [...wanted.entries()]
      .filter(([s]) => !this.tiles.has(s))
      .sort((a, b) => center(a[1]) - center(b[1]));
    let pending = 0;
    const ctx: TreeContext = {
      climate: (dir, out) => this.climate.sampleAt(dir, out),
      clear: this.clearings,
      habitability: this.habitability,
      roads: this.roads,
      hedgeShare: this.hedgeShareOverride ?? undefined,
      rivers: world.rivers ? (k) => riverStretches(world.rivers!, k, R) : undefined,
    };
    for (const [s, { tile: k, part }] of missing) {
      const data = this.terrain.dataTile(treeDataTile(k));
      // Low priority: after the terrain's own tiles (whose priorities are pixels of error).
      if (!data) this.terrain.requestDataTile(treeDataTile(k), 1);
      if (!data || performance.now() - t0 > this.buildBudgetMs) {
        pending++;
        continue;
      }
      let it = this.building.get(s);
      if (!it) this.building.set(s, (it = treePlacer(k, data, opts, world.seed, ctx, part)));
      for (;;) {
        const r = it.next();
        if (r.done) {
          this.building.delete(s);
          this.tiles.set(s, this.build(r.value));
          break;
        }
        if (performance.now() - t0 > this.buildBudgetMs) {
          pending++;
          break;
        }
      }
    }
    // Parts no longer wanted stop placing.
    for (const s of this.building.keys()) if (!wanted.has(s)) this.building.delete(s);
    this.stats.pending = pending;

    // Place, and evict tiles not wanted for a while. A part in view is compacted again
    // once the camera has moved COMPACT_STEP m: its meshes then hold only the trees in
    // range, each in its near or far mesh by its own distance. The nearest stale parts
    // go first, within the budget (at least one per frame).
    const ex = this.terrain.exaggerationUniform.value;
    const shownReach = Math.max(this.nearRange.value, this.edgeRange.value);
    const stale: { tile: TreeTile; nearest: number }[] = [];
    // A day of season, or a temperature change, re-sorts every part (leafless trees).
    const phase = this.land.seasonPhase.value;
    const tempOffset = this.land.temperatureOffset.value;
    if (
      !(Math.abs(phase - this.compactedSeason[0]!) < 1 / 365) ||
      tempOffset !== this.compactedSeason[1]
    ) {
      this.compactedSeason = [phase, tempOffset];
      for (const tile of this.tiles.values()) tile.compactedAt = null;
    }
    for (const [s, tile] of this.tiles) {
      tile.seen = false;
      if (wanted.has(s)) {
        tile.lastUsed = this.frame;
        const radius = instanceSphere(tile.origin, tile.extent, ex, TREE_MARGIN, this.center);
        const inView = !view || !sphereOutsideView(this.center, radius, view);
        const nearest = this.center.distanceTo(eye) - radius;
        tile.seen = inView && nearest < shownReach;
        if (tile.seen && (!tile.compactedAt || tile.compactedAt.distanceTo(eye) > COMPACT_STEP))
          stale.push({ tile, nearest });
      } else if (this.frame - tile.lastUsed > 120) {
        for (const m of tile.meshes) {
          this.group.remove(m);
          m.geometry.dispose();
        }
        this.tiles.delete(s);
      }
    }
    stale.sort((a, b) => a.nearest - b.nearest);
    const c0 = performance.now();
    for (const [k, { tile }] of stale.entries()) {
      if (k > 0 && performance.now() - c0 > this.compactBudgetMs) break;
      this.compact(tile, eye, ex);
    }
    let instances = 0;
    let triangles = 0;
    for (const tile of this.tiles.values()) {
      for (const m of tile.meshes) {
        m.userData.range =
          m.userData.variant === 'crown' ? this.nearRange.value : this.edgeRange.value;
        const g = m.geometry as InstancedBufferGeometry;
        m.visible = tile.seen && g.instanceCount > 0;
        if (!m.visible) continue;
        instances += g.instanceCount;
        triangles += g.instanceCount * (m.userData.triangles as number);
        placeCameraRelative(m, tile.origin, eye);
      }
    }
    this.stats.tiles = this.tiles.size;
    this.stats.instances = instances;
    this.stats.triangles = triangles;
  }

  /** Sorts a part's trees within range into its near and far meshes, by distance from `eye`. */
  private compact(tile: TreeTile, eye: Readonly<Vec3d>, ex: number): void {
    tile.compactedAt = (tile.compactedAt ?? new Vec3d()).copy(eye);
    // The eye relative to the part's origin, in float64.
    const ex0 = eye.x - tile.origin.x;
    const ey0 = eye.y - tile.origin.y;
    const ez0 = eye.z - tile.origin.z;
    const lodAt2 = this.lodDistance.value ** 2;
    const seasonal = Math.cos((this.land.seasonPhase.value - WARMEST_PHASE) * 2 * Math.PI);
    const offset = this.land.temperatureOffset.value;
    for (const list of tile.lists) {
      // Trees a step beyond the range stay, so the shader's fade never runs out of them
      // before the next compaction.
      const r =
        (list.range === 'near' ? this.nearRange.value : this.edgeRange.value) + COMPACT_STEP;
      const r2 = r * r;
      const d = list.data;
      const n = d.length / INSTANCE_FLOATS;
      const counts = [0, 0, 0];
      const near = list.meshes[0] ?? null;
      const far = list.meshes[1] ?? near;
      const bare = list.meshes[2] ?? null;
      const targets = [near, far, bare];
      for (let i = 0; i < n; i++) {
        const o = i * INSTANCE_FLOATS;
        const h = Math.max(d[o + 6]!, 0) * ex;
        const dx = d[o]! + d[o + 3]! * h - ex0;
        const dy = d[o + 1]! + d[o + 4]! * h - ey0;
        const dz = d[o + 2]! + d[o + 5]! * h - ez0;
        const dist2 = dx * dx + dy * dy + dz * dz;
        if (dist2 > r2) continue;
        let slot: number = dist2 < lodAt2 || !list.meshes[1] ? 0 : 1;
        // Leafless in winter (decision 153): each tree below its own threshold, the
        // surface temperature the shaders compute, takes its bare model.
        if (bare && d[o + 9]! > 0) {
          const hemisphere = Math.max(-1, Math.min(1, d[o + 4]! * 20));
          const t = d[o + 10]! + d[o + 11]! * seasonal * hemisphere + offset;
          const angle = d[o + 8]!;
          const jitter = ((angle * 3.17) % 1) - 0.5;
          if (t < LEAFLESS_T + 2 * LEAFLESS_JITTER * jitter) slot = 2;
        }
        const mesh = targets[slot];
        if (!mesh) continue;
        const g = mesh.geometry as InstancedBufferGeometry;
        const k = counts[slot === 1 && far === near ? 0 : slot]!++;
        (g.getAttribute('iBase').array as Float32Array).set(d.subarray(o, o + 3), k * 3);
        (g.getAttribute('iUp').array as Float32Array).set(d.subarray(o + 3, o + 6), k * 3);
        (g.getAttribute('iParams').array as Float32Array).set(
          d.subarray(o + 6, o + GPU_FLOATS),
          k * 4,
        );
      }
      for (const [j, mesh] of [near, far, bare].entries()) {
        if (!mesh || (j === 1 && mesh === near)) continue;
        const g = mesh.geometry as InstancedBufferGeometry;
        const count = counts[j]!;
        g.instanceCount = count;
        for (const [name, size] of [
          ['iBase', 3],
          ['iUp', 3],
          ['iParams', 4],
        ] as const) {
          const a = g.getAttribute(name) as InstancedBufferAttribute;
          a.clearUpdateRanges();
          if (count > 0) {
            a.addUpdateRange(0, count * size);
            a.needsUpdate = true;
          }
        }
      }
    }
  }

  private build(inst: TreeInstances): TreeTile {
    const meshes: Mesh[] = [];
    const lists: TreeList[] = [];
    for (const [key, data] of inst.lists) {
      const count = data.length / INSTANCE_FLOATS;
      if (count === 0) continue;
      const [kind, variant] = key.split('/') as [TreeKind, TreeVariant];
      const pair: (Mesh | null)[] = [];
      const bareId = BARE[kind];
      for (const lod of [0, 1, 2]) {
        const geo = this.geometries.get(lod === 2 ? (bareId ?? '') : `${key}/${lod}`);
        if (!geo || geo.position.length === 0) {
          pair.push(null);
          continue;
        }
        // Each mesh holds the trees compacted into it, at most all of them.
        const g = new InstancedBufferGeometry();
        g.setAttribute('position', new BufferAttribute(geo.position, 3));
        g.setAttribute('normal', new BufferAttribute(geo.normal, 3));
        g.setAttribute('color', new BufferAttribute(geo.color, 3));
        g.setAttribute('iBase', new InstancedBufferAttribute(new Float32Array(count * 3), 3));
        g.setAttribute('iUp', new InstancedBufferAttribute(new Float32Array(count * 3), 3));
        g.setAttribute('iParams', new InstancedBufferAttribute(new Float32Array(count * 4), 4));
        g.instanceCount = 0;
        const mesh = new Mesh(g, this.material);
        mesh.userData.variant = variant;
        mesh.userData.lod = lod;
        mesh.userData.range = variant === 'crown' ? this.nearRange.value : this.edgeRange.value;
        mesh.userData.deciduous = DECIDUOUS.has(kind) && lod < 2 ? 1 : 0;
        const fall = FALL_HUE[kind] ?? [0.5, 1];
        mesh.userData.fallBase = fall[0];
        mesh.userData.fallSpread = fall[1];
        mesh.userData.triangles = geo.position.length / 9;
        let top = 0;
        for (let v = 1; v < geo.position.length; v += 3) top = Math.max(top, geo.position[v]!);
        mesh.userData.height = top;
        mesh.frustumCulled = false;
        mesh.visible = false;
        this.group.add(mesh);
        meshes.push(mesh);
        pair.push(mesh);
      }
      lists.push({ data, range: variant === 'crown' ? 'near' : 'edge', meshes: pair });
    }
    return {
      meshes,
      lists,
      origin: inst.origin,
      lastUsed: this.frame,
      extent: instanceExtent([...inst.lists.values()], INSTANCE_FLOATS),
      compactedAt: null,
      seen: false,
    };
  }

  /** Drops all trees (world change). */
  clear(): void {
    this.building.clear();
    for (const tile of this.tiles.values()) {
      for (const m of tile.meshes) {
        this.group.remove(m);
        m.geometry.dispose();
      }
    }
    this.tiles.clear();
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
