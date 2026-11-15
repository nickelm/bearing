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
  max,
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
import { cubeFaceUvToDirection, directionToCubeFace } from '../../../core/coords';
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
  coniferShare,
  EDGE_TREES,
  edgeRise,
  pineShare,
  standAt,
  standTop,
  tropicalShare,
} from '../../../worldgen/canopy';
import { earthElevation, LAPSE_RATE } from '../../../worldgen/climate';
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
  /** Directions where no tree may stand (towns, airfields, roads; decision 65). */
  clear?: (d: Readonly<Vec3d>) => boolean;
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
    return h;
  };
  let meanT = 0;
  /** Climate at the current site: sets the annual mean `meanT` (°C) there. */
  const climateHere = (h: number) => {
    ctx.climate(d, climate);
    meanT = climate[0]! - earthElevation(h, climate[3]!, opts.reliefScale) * LAPSE_RATE;
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
      const interior =
        density(sx + reach, sy) >= CANOPY_THRESHOLD &&
        density(sx - reach, sy) >= CANOPY_THRESHOLD &&
        density(sx, sy + reach) >= CANOPY_THRESHOLD &&
        density(sx, sy - reach) >= CANOPY_THRESHOLD;
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
      if (pick < 0.4) kind = 'tree-shrub';
      else if (meanT > 18 && moisture < 0.45)
        kind = pick < 0.95 || f > 0.15 ? 'tree-acacia' : 'tree-dead';
      // The cold is all conifer: firs and shrubs, no birch (decision 153).
      else if (conifers > 0.9) kind = 'tree-fir';
      else if (conifers > 0.5) kind = pick < 0.75 ? 'tree-fir' : 'tree-birch';
      else kind = pick < 0.6 ? 'tree-birch' : pick < 0.85 ? 'tree-broadleaf' : 'tree-oak';
      push(kind, 'whole', h, scale, angle, tone * (tropicalShare(meanT) > 0.5 ? -1 : 1));
    }
    yield;
  }

  const lists = new Map<string, Float32Array>();
  for (const [k, v] of out) lists.set(k, Float32Array.from(v));
  return { tile: t, part, origin, lists };
}

function smooth(e0: number, e1: number, x: number): number {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
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

export class ForestLayer {
  readonly group = new Group();
  /** Trees on (the simulation view's forests, decision 148). */
  enabled = true;
  /** Crowns inside stands show within this distance (m); the shell is their understory. */
  readonly nearRange = uniform(600);
  /** Whole trees (edges, fringe, open land) show within this distance (m). */
  readonly edgeRange = uniform(1200);
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
  /** Parts being placed, a few rows per frame. */
  private readonly building = new Map<string, Generator<void, TreeInstances, void>>();
  private readonly material: MeshBasicNodeMaterial;
  private readonly geometries = new Map<string, ReturnType<typeof treeGeometry>>();
  private frame = 0;
  private readonly scratch = new Vec3d();
  private readonly center = new Vec3d();
  private lastWorld: unknown = null;
  private clearings: ((d: Readonly<Vec3d>) => boolean) | undefined;
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
      const p = ground.add(ax.mul(local.x).add(up.mul(local.y)).add(az.mul(local.z)).mul(s));
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

  /** Sets where trees must not stand, and rebuilds the trees. */
  setClearings(clear: ((d: Readonly<Vec3d>) => boolean) | undefined): void {
    this.clearings = clear;
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
