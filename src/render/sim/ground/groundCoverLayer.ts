/**
 * Ground cover near a low camera (G3; decisions 168, 169, 174): the kit of
 * decision 172 placed by `worldgen/groundCover.ts`, in a ring around the eye.
 *
 * - **Chunks.** A level-10 tile is cut into COVER_SPLIT² chunks of 32 samples
 *   (about 190 m). A chunk's cells are placed once, on the CPU, when the
 *   chunk comes within reach, and kept while it stays near.
 * - **On the drawn triangle.** Each item sits on the plane of the level-10
 *   mesh triangle under it, interpolated from the mesh's own vertex heights on
 *   its own diagonal (tileMesh.ts), so a 0.4 m tuft neither floats over a facet
 *   nor sinks into it. The item stores that point as a base and a
 *   displacement per unit of exaggeration, so the vertex shader follows the
 *   terrain's exaggeration as the mesh does.
 * - **Masks.** No cover in the sea, lakes or river water (the river index's
 *   stretches), on roads, airfields or in towns (the infrastructure's
 *   clearings), or under closed forest (the placement function).
 * - **Color from the ground.** Each item carries the open ground's color at its
 *   cell (the tile vertex color with the land shader's moisture tint); green
 *   parts of plants take it under the model's own light and dark shades, so a
 *   tuft matches its meadow, its desert or its tundra. The season browns them
 *   with the grass, snow hides plants and lies on rocks' tops, rain darkens all.
 * - **Drawing.** One instanced mesh per kind (at most 15 draws). When the eye
 *   has moved or turned far enough, the items within each kind's range and in
 *   front of the camera are copied into the meshes, relative to an anchor at
 *   the eye (float64 first, rule 4). Items shrink into the ground over the last
 *   30% of their range. Above every kind's range, the layer draws nothing.
 */
import {
  BufferAttribute,
  FrontSide,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute,
  clamp,
  cos,
  cross,
  dot,
  float,
  Fn,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { Color, Vector3 } from 'three/webgpu';
import { placeCameraRelative } from '../../common/cameraRelative';
import { cubeFaceUvToDirection, directionToCubeFace } from '../../../core/coords';
import { tileForDirection, tileKeyString, TILE_TEXELS } from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import { earthElevation, LAPSE_RATE } from '../../../worldgen/climate';
import { FARMABLE_BIOMES, srgbToLinear } from '../../common/palette';
import { NO_LAKE } from '../../../worldgen/gpu/tileSynth';
import type { TileData } from '../../../worldgen/gpu/tileSynth';
import { COVER_KINDS, coverInCell, coverSeed, ROCK_KINDS } from '../../../worldgen/groundCover';
import type { CoverItem, CoverKind, CoverSite } from '../../../worldgen/groundCover';
import { buildModel } from '../../common/models/builder';
import type { BuiltModel } from '../../common/models/builder';
import { MODEL_SPECS } from '../../common/models/library';
import { habitabilityAt } from '../../common/habitabilityTexture';
import type { ClimateTexture } from '../../common/climateTexture';
import {
  colorFor,
  lakeSampler,
  mapSample,
  materialAt,
  surfaceSampler,
} from '../../common/terrain/tileMesh';
import type { MeshOptions } from '../../common/terrain/tileMesh';
import { TILE_SEGMENTS } from '../../common/terrain/quadtree';
import { sphereOutsideView } from '../../common/terrain/quadtree';
import type { CullView } from '../../common/terrain/quadtree';
import { WARMEST_PHASE } from '../../common/seasons';
import type { InfraScene } from '../infra/infraScene';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { LandShading } from '../terrain/landShading';
import type { TerrainRenderer } from '../terrain/terrainRenderer';
import { riverStretches, treeDataTile } from '../forest/forestLayer';
import { canopySeed, fieldAt } from '../../../worldgen/canopy';
import { airVelocity } from '../../../sim/flight/wind';
import type { WeatherView } from '../../../sim/weather/frame';
import type { RiverStretch } from '../forest/forestLayer';

type V3 = Node<'vec3'>;

/** How far (mesh quads, about 24 m each) a cell looks for a cliff above it (decision 185). */
const TALUS_REACH = 2;

/** Chunks: the level-10 tiles, cut COVER_SPLIT ways along each axis. */
export const COVER_TILE_LEVEL = 10;
export const COVER_SPLIT = 8;
/** Floats per item: base (3), displacement per exaggeration (3), up (3), scale, angle, mean T, half-range, color (3). */
export const COVER_FLOATS = 16;

/** Each kind's range (m): full size to 70% of it, gone at it; nothing above it either. */
export const COVER_RANGE: Readonly<Record<CoverKind, number>> = {
  'cover-tuft': 150,
  'cover-tuft-dry': 150,
  'cover-flowers-cream': 140,
  'cover-flowers-yellow': 140,
  'cover-flowers-violet': 140,
  'cover-pebbles': 120,
  'cover-tussock': 220,
  'cover-reeds': 260,
  'cover-bush': 450,
  'cover-bush-dry': 450,
  'cover-boulder-small': 300,
  'cover-boulder': 650,
  'cover-boulder-lichen': 650,
  'cover-slab': 700,
  'cover-boulder-large': 800,
};

/** How far each plant bends in the wind (1: a grass tuft; rocks do not). */
const STIFFNESS: Partial<Record<CoverKind, number>> = {
  'cover-tuft': 1,
  'cover-tuft-dry': 1,
  'cover-flowers-cream': 0.9,
  'cover-flowers-yellow': 0.9,
  'cover-flowers-violet': 0.9,
  'cover-tussock': 0.8,
  'cover-reeds': 1.1,
  'cover-bush': 0.2,
  'cover-bush-dry': 0.2,
};

/** Tip lean (fraction of the plant's height) per m/s of wind across it, and its most. */
const LEAN_PER_SPEED = 0.05;
const MAX_LEAN = 0.85;
/** The wash's lean per m/s against the wind's. */
const WASH_GAIN = 1.8;
/** Length (m) of the waves a wind drives across a meadow. */
const WIND_WAVE = 9;
/** Spacing of the downwash's travelling rings, in rotor radii, and their least spacing (m). */
const WASH_RING = 0.8;

/**
 * A rotor's downwash at the ground (decision 176): where it meets the ground,
 * the outwash speed there (m/s) and the rotor's radius (m).
 */
export interface GroundDownwash {
  /** Planet-centered point where the disc's axis meets the ground (m). */
  center: Readonly<Vec3d>;
  /** Outwash speed near one rotor radius out (m/s). */
  speed: number;
  /** Rotor radius (m). */
  radius: number;
}

/** What the layer needs from the air each frame. */
export interface CoverAir {
  /** The weather (null: still air). */
  view: WeatherView | null;
  gameTime: number;
  /** Real seconds since the last frame (0 while paused). */
  dt: number;
}

/** Part I's middle grassland shade (linear): green parts of the kit are drawn relative to it. */
const GRASS_REFERENCE = new Color().setHex(0x7a8c4a);

/** How far the shading normal bends toward the vertical (0: the face's own normal). */
const BEND = 0.45;

/** Groups of the kit that take the ground's color (the rest keep their own: flowers, rock). */
const TINTED_GROUPS = new Set(['dark', 'mid', 'light']);

/** What placement needs beyond the tile's data. */
export interface CoverContext {
  /** Climate at a direction: (sea-level °C, half-range K, moisture, valley floor m). */
  climate: (d: Readonly<Vec3d>, out: Float32Array) => Float32Array;
  /** Directions where nothing may stand (towns, airfields, roads), widened by `extra` m. */
  clear?: (d: Readonly<Vec3d>, extra?: number) => boolean;
  /** Habitability 0..1: fields on settled, farmable, flat land (decision 127). */
  habitability?: (d: Readonly<Vec3d>) => number;
  /** River stretches near a level-10 tile. */
  rivers?: (tile: TileKey) => readonly RiverStretch[];
  /** The world's canopy seed, for the fields' boundaries (verges, decision 185). */
  fieldSeed?: number;
}

/** The items of one chunk, by kind, relative to its origin. */
export interface CoverChunk {
  tile: TileKey;
  part: { i: number; j: number };
  origin: Vec3d;
  /** Mean height of its ground (m, before exaggeration), to place its bounds. */
  lift: number;
  lists: Map<CoverKind, Float32Array>;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Places chunk (part.i, part.j) of level-10 tile `t`. Pure: no GPU. `seed` is
 * the world's `coverSeed`.
 */
export function placeCoverChunk(
  t: TileKey,
  part: { i: number; j: number },
  data: TileData,
  opts: MeshOptions,
  seed: number,
  ctx: CoverContext,
): CoverChunk {
  const it = coverPlacer(t, part, data, opts, seed, ctx);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** Rows of cells `coverPlacer` places between yields. */
const PLACER_ROWS = 4;

/**
 * `placeCoverChunk` a few rows at a time: yields after every PLACER_ROWS rows of
 * cells, so a caller can spread a chunk over frames; returns the chunk.
 */
export function* coverPlacer(
  t: TileKey,
  part: { i: number; j: number },
  data: TileData,
  opts: MeshOptions,
  seed: number,
  ctx: CoverContext,
): Generator<void, CoverChunk, void> {
  const R = opts.radius;
  const size = TILE_TEXELS * (1 << t.level);
  const sampleM = ((Math.PI / 2) * R) / size;
  const span = TILE_TEXELS / COVER_SPLIT;
  const step = TILE_TEXELS / TILE_SEGMENTS;
  const x0 = part.i * span;
  const y0 = part.j * span;
  const dirAt = (sx: number, sy: number, out: Vec3d) =>
    cubeFaceUvToDirection(
      t.face,
      (t.x * TILE_TEXELS + sx) / size,
      (t.y * TILE_TEXELS + sy) / size,
      out,
    );
  const origin = dirAt(x0 + span / 2, y0 + span / 2, new Vec3d()).scale(R);

  // The mesh's vertices over the chunk (the same samples and heights as tileMesh.ts).
  const ground = surfaceSampler(t, t.level, data, opts);
  const lake = lakeSampler(t, data);
  const q0 = Math.floor(x0 / step);
  const r0 = Math.floor(y0 / step);
  const nq = span / step + 1;
  const vh = new Float64Array(nq * nq);
  const vd = new Float64Array(nq * nq * 3);
  const d = new Vec3d();
  for (let b = 0; b < nq; b++) {
    for (let a = 0; a < nq; a++) {
      const sx = (q0 + a) * step;
      const sy = (r0 + b) * step;
      dirAt(sx, sy, d);
      const k = b * nq + a;
      // Displayed height before exaggeration: the sea flat at 0 (cover never stands in water).
      vh[k] = Math.max(0, ground(sx, sy, d));
      vd[k * 3] = d.x;
      vd[k * 3 + 1] = d.y;
      vd[k * 3 + 2] = d.z;
    }
  }
  /** Weights of the three vertices of the drawn triangle under (sx, sy), and their indices. */
  const tri = { k: [0, 0, 0], w: [0, 0, 0] };
  const triangleAt = (sx: number, sy: number) => {
    const fx = sx / step - q0;
    const fy = sy / step - r0;
    const a = Math.min(nq - 2, Math.max(0, Math.floor(fx)));
    const b = Math.min(nq - 2, Math.max(0, Math.floor(fy)));
    const u = fx - a;
    const v = fy - b;
    const k00 = b * nq + a;
    const k10 = k00 + 1;
    const k11 = k00 + nq + 1;
    const k01 = k00 + nq;
    // Split along (i, j)–(i+1, j+1), as buildTileIndex.
    if (u >= v) {
      tri.k = [k00, k10, k11];
      tri.w = [1 - u, u - v, v];
    } else {
      tri.k = [k00, k11, k01];
      tri.w = [1 - v, u, v - u];
    }
    return tri;
  };

  // Cliffs just above (decision 185): the mesh's quads over the chunk and MARGIN quads round
  // it, each with its steepness and mean height, so a cell below a cliff takes its talus.
  const M = TALUS_REACH;
  const nx = nq + 2 * M;
  const eh = new Float64Array(nx * nx);
  for (let b = 0; b < nx; b++) {
    for (let a = 0; a < nx; a++) {
      const sx = (q0 + a - M) * step;
      const sy = (r0 + b - M) * step;
      eh[b * nx + a] = Math.max(0, ground(sx, sy, dirAt(sx, sy, d)));
    }
  }
  const quadM = step * sampleM;
  const nqx = nx - 1;
  const qSteep = new Float64Array(nqx * nqx);
  const qMean = new Float64Array(nqx * nqx);
  for (let b = 0; b < nqx; b++) {
    for (let a = 0; a < nqx; a++) {
      const h00 = eh[b * nx + a]!;
      const h10 = eh[b * nx + a + 1]!;
      const h01 = eh[(b + 1) * nx + a]!;
      const h11 = eh[(b + 1) * nx + a + 1]!;
      qSteep[b * nqx + a] = Math.hypot(h10 - h00 + h11 - h01, h01 - h00 + h11 - h10) / (2 * quadM);
      qMean[b * nqx + a] = (h00 + h10 + h01 + h11) / 4;
    }
  }
  /** Talus 0..1 at (cx, cy) of height h: steep quads nearby that stand above it. */
  const talusAt = (cx: number, cy: number, h: number): number => {
    const qa = Math.floor(cx / step) - q0 + M;
    const qb = Math.floor(cy / step) - r0 + M;
    let best = 0;
    for (let db = -M; db <= M; db++) {
      for (let da = -M; da <= M; da++) {
        const dist = Math.hypot(da, db);
        if (dist > M + 0.5) continue;
        const a = qa + da;
        const b = qb + db;
        if (a < 0 || b < 0 || a >= nqx || b >= nqx) continue;
        const k = b * nqx + a;
        if (qMean[k]! < h + 2) continue;
        const cliff = smooth(0.7, 1.2, qSteep[k]!) * (1 - dist / (M + 1));
        if (cliff > best) best = cliff;
      }
    }
    return best;
  };

  const stretches = ctx.rivers?.(t) ?? [];
  /** Distance (m) from unit direction `p` to the nearest river's water, or Infinity. */
  const waterGap = (p: Vec3d): number => {
    let gap = Infinity;
    for (const o of stretches) {
      const ab = o.b.clone().sub(o.a);
      const k = Math.min(1, Math.max(0, p.clone().sub(o.a).dot(ab) / Math.max(ab.dot(ab), 1e-30)));
      gap = Math.min(gap, o.a.clone().addScaled(ab, k).distanceTo(p) * R - o.width / 2);
    }
    return gap;
  };
  const inWater = (p: Vec3d, margin: number): boolean => {
    for (const o of stretches) {
      const ab = o.b.clone().sub(o.a);
      const k = Math.min(1, Math.max(0, p.clone().sub(o.a).dot(ab) / Math.max(ab.dot(ab), 1e-30)));
      if (o.a.clone().addScaled(ab, k).distanceTo(p) * R < o.width / 2 + margin) return true;
    }
    return false;
  };

  const out = new Map<CoverKind, number[]>();
  const climate = new Float32Array(4);
  const items: CoverItem[] = [];
  const p = new Vec3d();
  const cellM = sampleM;
  for (let b = 0; b < span; b++) {
    for (let a = 0; a < span; a++) {
      const sx = x0 + a;
      const sy = y0 + b;
      const cx = sx + 0.5;
      const cy = sy + 0.5;
      dirAt(cx, cy, d);
      // The drawn surface's height here (the triangle's, as the items stand on it).
      const tc = triangleAt(cx, cy);
      const h = tc.w[0]! * vh[tc.k[0]!]! + tc.w[1]! * vh[tc.k[1]!]! + tc.w[2]! * vh[tc.k[2]!]!;
      if (h <= 0) continue;
      const level = lake(cx, cy);
      if (level > NO_LAKE / 2 && level > h) continue;
      const [fx, fy] = mapSample(t, data.key, cx, cy);
      const mat = materialAt(data, fx, fy);
      const cover = mat & 0xff;
      ctx.climate(d, climate);
      const meanT = climate[0]! - earthElevation(h, climate[3]!, opts.reliefScale) * LAPSE_RATE;
      // The drawn triangle's slope: k = [00, 10, 11] below the diagonal, [00, 11, 01] above.
      const tr = triangleAt(cx, cy);
      const [ka, kb, kc] = tr.k as [number, number, number];
      const below = kb === ka + 1;
      const hu = below ? vh[kb]! - vh[ka]! : vh[kb]! - vh[kc]!;
      const hv = below ? vh[kc]! - vh[kb]! : vh[kc]! - vh[ka]!;
      const steep = Math.hypot(hu, hv) / (step * sampleM);
      const hab = ctx.habitability?.(d) ?? 0;
      const farmland =
        smooth(0.25, 0.45, hab) * (FARMABLE_BIOMES.has(cover) ? 1 : 0) * smooth(0.16, 0.08, steep);
      // Verges: near a field's boundary (the hedgerows' fields, decision 162).
      const verge =
        farmland > 0 && ctx.fieldSeed !== undefined
          ? smooth(5, 1.5, fieldAt(d.x * R, d.y * R, d.z * R, ctx.fieldSeed).edge)
          : 0;
      // Banks: a few meters from a river's water or above a lake's shore.
      const gap = stretches.length > 0 ? waterGap(d) : Infinity;
      const riverBank = gap > 0 ? smooth(10, 1.5, gap) : 0;
      const lakeBank = level > NO_LAKE / 2 ? smooth(3, 0.3, h - level) : 0;
      const site: CoverSite = {
        cover,
        moisture: climate[2]!,
        meanT,
        steep,
        forest: (mat >>> 24) / 255,
        aridity: ((mat >>> 17) & 15) / 15,
        farmland,
        verge,
        bank: Math.max(riverBank, lakeBank),
        talus: steep < 0.6 ? talusAt(cx, cy, h) : 0,
      };
      items.length = 0;
      coverInCell(t.x * TILE_TEXELS + sx, t.y * TILE_TEXELS + sy, t.face, seed, site, items);
      if (items.length === 0) continue;
      // Near a clearing or water, test each item; elsewhere the cell is clear.
      const nearClear = ctx.clear?.(d, cellM) ?? false;
      const nearWater = stretches.length > 0 && inWater(d, cellM);
      // The open ground's color here, with the land shader's moisture tint (landShading.ts).
      const rgb = colorFor('biome', h, mat, t.level, false, opts.reliefScale);
      const m = Math.min(1, Math.max(0, climate[2]! * 1.6 - 0.2));
      const tint = [1.12 + (0.88 - 1.12) * m, 1.06 + (0.97 - 1.06) * m, 0.9];
      for (const it of items) {
        const isx = sx + it.u;
        const isy = sy + it.v;
        dirAt(isx, isy, p);
        if (nearClear && ctx.clear!(p, 1)) continue;
        if (nearWater && inWater(p, 1)) continue;
        const { k, w } = triangleAt(isx, isy);
        let bx = 0;
        let by = 0;
        let bz = 0;
        let dx = 0;
        let dy = 0;
        let dz = 0;
        for (let c = 0; c < 3; c++) {
          const kk = k[c]!;
          const wc = w[c]!;
          const ux = vd[kk * 3]!;
          const uy = vd[kk * 3 + 1]!;
          const uz = vd[kk * 3 + 2]!;
          bx += wc * ux * R;
          by += wc * uy * R;
          bz += wc * uz * R;
          dx += wc * ux * vh[kk]!;
          dy += wc * uy * vh[kk]!;
          dz += wc * uz * vh[kk]!;
        }
        let list = out.get(it.kind);
        if (!list) out.set(it.kind, (list = []));
        list.push(
          bx - origin.x,
          by - origin.y,
          bz - origin.z,
          dx,
          dy,
          dz,
          p.x,
          p.y,
          p.z,
          it.scale,
          it.angle,
          meanT,
          climate[1]!,
          srgbToLinear(rgb[0]) * tint[0]! * it.shade,
          srgbToLinear(rgb[1]) * tint[1]! * it.shade,
          srgbToLinear(rgb[2]) * tint[2]! * it.shade,
        );
      }
    }
    if (b % PLACER_ROWS === PLACER_ROWS - 1) yield;
  }
  const lists = new Map<CoverKind, Float32Array>();
  for (const [kind, list] of out) lists.set(kind, Float32Array.from(list));
  let lift = 0;
  for (const h of vh) lift += h;
  return { tile: t, part, origin, lift: lift / vh.length, lists };
}

/** A kit model's triangles with its occlusion baked into the color, and a tint weight per vertex. */
export function coverGeometry(model: BuiltModel, rock: boolean) {
  const n = model.triangles * 9;
  const color = new Float32Array(n);
  const tint = new Float32Array(model.triangles * 3);
  for (let t = 0; t < model.triangles; t++) {
    const tinted = !rock && TINTED_GROUPS.has(model.groupNames[model.group[t]!]!);
    for (let v = 0; v < 3; v++) {
      const ao = model.ao[t * 3 + v]!;
      for (let c = 0; c < 3; c++) color[t * 9 + v * 3 + c] = model.color[t * 9 + v * 3 + c]! * ao;
      tint[t * 3 + v] = tinted ? 1 : 0;
    }
  }
  return {
    position: model.position.slice(),
    normal: model.normal.slice(),
    color,
    tint,
    height: Math.max(1e-3, model.bounds.max[1]),
  };
}

interface Chunk extends CoverChunk {
  lastUsed: number;
}

/** The layer re-fills its meshes after the eye moves this far (m) or turns this far (cosine). */
const REFILL_STEP = 6;
const REFILL_TURN = Math.cos(0.2);

export class GroundCoverLayer {
  readonly group = new Group();
  /** Ground cover on (decision 174). */
  enabled = true;
  /** Scales every kind's range (quality tiers; 1 = laptop). */
  rangeScale = 1;
  /** Milliseconds per frame spent placing chunks (at least one chunk per frame). */
  buildBudgetMs = 3;
  readonly stats = { chunks: 0, instances: 0, triangles: 0, pending: 0, draws: 0 };

  private readonly chunks = new Map<string, Chunk>();
  /** Chunks being placed, a few rows per frame. */
  private readonly building = new Map<string, Generator<void, CoverChunk, void>>();
  private readonly meshes = new Map<CoverKind, Mesh>();
  private readonly geometries = new Map<CoverKind, ReturnType<typeof coverGeometry>>();
  private readonly material: MeshBasicNodeMaterial;
  private frame = 0;
  private lastWorld: unknown = null;
  private seed = 0;
  private dirty = true;
  private readonly anchor = new Vec3d();
  /** The air over the ring (relative to the anchor) and the rotor's wash, as uniforms. */
  private readonly air = {
    time: uniform(0),
    at: uniform(new Vector3()),
    dEast: uniform(new Vector3()),
    dNorth: uniform(new Vector3()),
    east: uniform(new Vector3(1, 0, 0)),
    north: uniform(new Vector3(0, 0, 1)),
    washCenter: uniform(new Vector3(0, -1e7, 0)),
    washSpeed: uniform(0),
    washRadius: uniform(1),
  };
  private downwash: GroundDownwash | null = null;
  /** The wind at the ground under the eye this frame (world, m/s): for the rotor's dust. */
  readonly groundWind = new Vec3d();
  private readonly wscratch = [new Vec3d(), new Vec3d(), new Vec3d(), new Vec3d(), new Vec3d()];
  private readonly center = new Vec3d();
  private filledAt: Vec3d | null = null;
  private readonly filledForward = new Vec3d();
  private clearings: ((d: Readonly<Vec3d>, extra?: number) => boolean) | undefined;
  private habitability: ((d: Readonly<Vec3d>) => number) | undefined;

  constructor(
    private readonly terrain: TerrainRenderer,
    lighting: PlanetLighting,
    private readonly climate: ClimateTexture,
    private readonly land: LandShading,
  ) {
    for (const kind of COVER_KINDS)
      this.geometries.set(
        kind,
        coverGeometry(buildModel(MODEL_SPECS[kind]!), ROCK_KINDS.has(kind)),
      );
    this.material = this.buildMaterial(lighting);
  }

  private buildMaterial(lighting: PlanetLighting): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ side: FrontSide });
    const land = this.land;
    const base = attribute('iBase', 'vec3');
    const disp = attribute('iDisp', 'vec3');
    const up = normalize(attribute('iUp', 'vec3'));
    const params = attribute('iParams', 'vec4'); // scale, angle, mean T, half-range
    const ground = attribute('iColor', 'vec3');
    const ex = this.terrain.exaggerationUniform;
    const perMesh = (key: string, fallback: number) =>
      uniform(fallback).onObjectUpdate(
        ({ object }) =>
          ((object as Mesh | undefined)?.userData[key] as number | undefined) ?? fallback,
      );
    const range = perMesh('range', 200);
    const plant = perMesh('plant', 1);
    const stiffness = perMesh('stiffness', 0);
    const height = perMesh('height', 0.5);
    const air = this.air;

    // The surface temperature today (as the trees' compaction and landShading.ts).
    const hemisphere = clamp(up.y.mul(20), -1, 1);
    const seasonal = cos(land.seasonPhase.sub(WARMEST_PHASE).mul(2 * Math.PI)).mul(hemisphere);
    const temperature = params.z.add(params.w.mul(seasonal)).add(land.temperatureOffset);
    // Plants and stones alike sink under lying snow (the ground's cold threshold, decision
    // 125): boulders on a snowfield looked out of place (the owner's review, decision 187).
    const buried = smoothstep(-1, -4, temperature);

    const t0 = normalize(cross(up, vec3(0.0001, 1, 0.0002)));
    const t1 = cross(up, t0);
    const ca = cos(params.y);
    const sa = sin(params.y);
    // A rotation (x × y = z, as the model frame), not a reflection: front faces stay front.
    const ax = t0.mul(ca).add(t1.mul(sa));
    const az = t0.mul(sa).sub(t1.mul(ca));
    const local = attribute('position', 'vec3');
    const foot = base.add(disp.mul(ex));
    const bend = varyingProperty('float', 'vCoverBend');
    const apInscatter = varyingProperty('vec3', 'vCoverInscatter');
    const apTransmittance = varyingProperty('vec3', 'vCoverTransmittance');
    m.positionNode = Fn(() => {
      const rel = modelWorldMatrix.mul(vec4(foot, 1)).xyz;
      const dist = rel.length();
      // Shrink into the ground over the last 30% of the range.
      const k = clamp(range.sub(dist).div(max(range.mul(0.3), 1)), 0, 1);
      const s = params.x.mul(k.mul(k).mul(k.mul(-2).add(3))).mul(float(1).sub(buried));
      // Wind (decision 176): the flight model's air at the ground, a linear field over the
      // ring, across the ground, plus the rotor's outwash in travelling rings.
      const wind = air.at
        .add(air.dEast.mul(dot(foot, air.east)))
        .add(air.dNorth.mul(dot(foot, air.north)));
      const offset = foot.sub(air.washCenter);
      const across = offset.sub(up.mul(dot(offset, up)));
      const r = length(across);
      const R = max(air.washRadius, 0.5);
      const outward = across.div(max(r, 0.01));
      const ring = max(R.mul(WASH_RING), 1.5);
      const pulse = sin(
        r
          .sub(air.time.mul(air.washSpeed.mul(0.5).add(2)))
          .div(ring)
          .mul(2 * Math.PI),
      )
        .mul(0.35)
        .add(0.65);
      const reach = smoothstep(0, R.mul(0.5), r)
        .mul(min(float(1), R.mul(1.6).div(max(r, 0.01))))
        // The wall jet spreads and slows; past about eight rotor radii it is gone.
        .mul(smoothstep(R.mul(10), R.mul(6), r));
      const wash = outward.mul(air.washSpeed.mul(reach).mul(pulse));
      const breeze = wind.sub(up.mul(dot(wind, up)));
      const breezeSpeed = length(breeze);
      // Gusts roll over a meadow as waves along the wind.
      const waves = sin(
        dot(foot, breeze.div(max(breezeSpeed, 1e-3)))
          .div(WIND_WAVE)
          .mul(2 * Math.PI)
          .sub(air.time.mul(breezeSpeed.mul(0.25).add(1.2))),
      )
        .mul(0.25)
        .add(0.75);
      // The rotor's wash lays the grass down harder than a wind of its speed: it blows down
      // onto the plants as well as across them.
      const flow = breeze.mul(waves).add(wash.mul(WASH_GAIN));
      const speed = length(flow);
      const along = flow.div(max(speed, 1e-3));
      const lean = min(speed.mul(LEAN_PER_SPEED), MAX_LEAN).mul(stiffness);
      // Each plant flutters at its own phase.
      const flutter = sin(air.time.mul(speed.mul(0.3).add(5)).add(params.y.mul(7)))
        .mul(min(speed, 15).mul(0.012).add(0.03))
        .mul(stiffness);
      bend.assign(lean);
      // Bent from the root: the tip moves most, and drops as it leans.
      const tall = height.mul(s);
      const kk = clamp(local.y.div(max(height, 1e-3)), 0, 1);
      const w = kk.mul(kk);
      const sway = along
        .mul(lean.add(flutter).mul(tall).mul(w))
        .sub(up.mul(lean.mul(lean).mul(0.5).mul(tall).mul(w)));
      const p = foot
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
    const model = attribute('color', 'vec3');
    const tint = attribute('tint', 'float');
    // Green parts take the ground's brightness and half its hue, under the model's own
    // shading: a tuft matches its meadow and pales on dry ground, but stays a plant on gray
    // alpine or desert ground instead of turning that gray.
    const reference = vec3(GRASS_REFERENCE.r, GRASS_REFERENCE.g, GRASS_REFERENCE.b);
    const luma = (c: V3) => dot(c, vec3(0.2126, 0.7152, 0.0722));
    const full = ground.div(reference);
    const brightness = luma(ground as V3).div(luma(reference as V3));
    const ratio = clamp(mix(vec3(brightness), full, 0.5), 0.5, 1.8);
    let albedo = mix(model, model.mul(ratio), tint) as V3;
    // Grass laid flat by a rotor shows its paler side.
    albedo = albedo.mul(smoothstep(0.35, 0.8, bend).mul(tint).mul(0.35).add(1)) as V3;
    // The season browns them as it browns the grass around them (landShading.ts): by how
    // green the ground is, so a tuft never turns where its meadow does not.
    const green = clamp(ground.y.sub(max(ground.x, ground.z)).mul(12), 0, 1);
    const autumn = smoothstep(12, 4, temperature).mul(green).mul(0.8).mul(tint);
    albedo = mix(albedo, land.autumnColor, autumn) as V3;
    albedo = land.wet(albedo);
    // Snow on rocks' upward faces where it lies.
    const snow = smoothstep(-1, -4, temperature)
      .mul(float(1).sub(plant))
      .mul(smoothstep(0.3, 0.7, dot(normal, up)));
    albedo = mix(albedo, land.snowColor, snow) as V3;
    // Light the ground throws back onto faces that lean away from the sky: without it the
    // shaded sides of rocks and blades went black (Part I: shadows deep, never black).
    const groundLight = lighting.shadeDiffuse(
      ground as unknown as V3,
      up as V3,
      positionWorld as V3,
    );
    const bounce = albedo.mul(groundLight).mul(float(1).sub(dot(normal, up)).mul(0.5));
    // Faces are lit through a normal bent halfway to the vertical: each face keeps its own
    // shade, but sides turned from the sun read as shaded rock or grass, not as holes.
    const bent = normalize(normal.add(up.mul(BEND))) as V3;
    m.colorNode = lighting.applyAerial(
      lighting.shadeDiffuse(albedo, bent, positionWorld as V3).add(bounce),
      apInscatter as V3,
      apTransmittance as V3,
    );
    return m;
  }

  /** The infrastructure the cover keeps off (towns, airfields, roads) and the fields. */
  setInfrastructure(scene: InfraScene | null): void {
    this.clearings = scene ? (d, extra = 0) => scene.isClear(d, false, extra) : undefined;
    this.habitability = scene
      ? (d) => habitabilityAt(scene.habitability, scene.habitabilityResolution, d)
      : undefined;
    this.clear();
  }

  /** Builds and draws the cover around `eye`. Call once per frame after the terrain. */
  /** A rotor's downwash this frame, or null (decision 176). */
  setDownwash(d: GroundDownwash | null): void {
    this.downwash = d;
  }

  /** The downwash set for this frame, or null. */
  get currentDownwash(): GroundDownwash | null {
    return this.downwash;
  }

  update(
    eye: Readonly<Vec3d>,
    heightAboveGround: number,
    view?: CullView,
    airNow?: CoverAir,
  ): void {
    this.frame++;
    const world = this.terrain.currentWorld;
    const opts = this.terrain.meshOptions();
    if (world !== this.lastWorld) {
      this.clear();
      this.lastWorld = world;
      this.seed = world ? coverSeed(world.seed) : 0;
    }
    const ranges = COVER_KINDS.map((k) => COVER_RANGE[k] * this.rangeScale);
    const reachAll = Math.max(...ranges.filter((r) => r > heightAboveGround), 0);
    const show =
      this.enabled && world !== null && opts !== null && opts.mode === 'biome' && reachAll > 0;
    this.group.visible = show;
    if (!show) return;

    // Chunks within reach of the eye's ground point.
    const R = opts.radius;
    const chunkM = ((Math.PI / 2) * R) / (1 << COVER_TILE_LEVEL) / COVER_SPLIT;
    const reach = Math.sqrt(Math.max(0, reachAll ** 2 - heightAboveGround ** 2)) + chunkM;
    const radial = eye.clone().normalize();
    const east = new Vec3d(0, 1, 0).cross(radial);
    if (east.length() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = radial.clone().cross(east);
    const wanted = new Map<string, { tile: TileKey; part: { i: number; j: number } }>();
    const sstep = chunkM / 2;
    const n = Math.ceil(reach / sstep);
    const d = new Vec3d();
    const size = 1 << COVER_TILE_LEVEL;
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        if ((i * i + j * j) * sstep * sstep > reach * reach) continue;
        d.copy(radial)
          .addScaled(east, (i * sstep) / R)
          .addScaled(north, (j * sstep) / R)
          .normalize();
        const k = tileForDirection(d, COVER_TILE_LEVEL);
        const uv = directionToCubeFace(d);
        const part = {
          i: Math.min(COVER_SPLIT - 1, Math.floor((uv.u * size - k.x) * COVER_SPLIT)),
          j: Math.min(COVER_SPLIT - 1, Math.floor((uv.v * size - k.y) * COVER_SPLIT)),
        };
        wanted.set(`${tileKeyString(k)}/${part.i}/${part.j}`, { tile: k, part });
      }
    }

    // Place missing chunks, nearest first, within the budget.
    const centerOf = (k: TileKey, part: { i: number; j: number }) =>
      cubeFaceUvToDirection(
        k.face,
        (k.x + (part.i + 0.5) / COVER_SPLIT) / size,
        (k.y + (part.j + 0.5) / COVER_SPLIT) / size,
      );
    const missing = [...wanted.entries()]
      .filter(([s]) => !this.chunks.has(s))
      .map(([s, w]) => ({ s, ...w, dist: centerOf(w.tile, w.part).distanceTo(radial) }))
      .sort((a, b) => a.dist - b.dist);
    const ctx: CoverContext = {
      climate: (dir, out) => this.climate.sampleAt(dir, out),
      clear: this.clearings,
      habitability: this.habitability,
      rivers: world.rivers ? (k) => riverStretches(world.rivers!, k, R) : undefined,
      fieldSeed: canopySeed(world.seed),
    };
    const t0 = performance.now();
    let pending = 0;
    let built = 0;
    for (const w of missing) {
      const data = this.terrain.dataTile(treeDataTile(w.tile));
      if (!data) this.terrain.requestDataTile(treeDataTile(w.tile), 1);
      if (!data || performance.now() - t0 > this.buildBudgetMs) {
        pending++;
        continue;
      }
      let it = this.building.get(w.s);
      if (!it)
        this.building.set(w.s, (it = coverPlacer(w.tile, w.part, data, opts, this.seed, ctx)));
      for (;;) {
        const r = it.next();
        if (r.done) {
          this.building.delete(w.s);
          this.chunks.set(w.s, { ...r.value, lastUsed: this.frame });
          built++;
          break;
        }
        if (performance.now() - t0 > this.buildBudgetMs) {
          pending++;
          break;
        }
      }
    }
    if (built > 0) this.dirty = true;
    // Chunks no longer wanted stop placing.
    for (const s of this.building.keys()) if (!wanted.has(s)) this.building.delete(s);
    this.stats.pending = pending;
    for (const [s, c] of this.chunks) {
      if (wanted.has(s)) c.lastUsed = this.frame;
      else if (this.frame - c.lastUsed > 120) this.chunks.delete(s);
    }

    // Re-fill the meshes when the eye has moved or turned far enough, or chunks arrived.
    const forward = view ? new Vec3d(view.forward.x, view.forward.y, view.forward.z) : null;
    const moved = !this.filledAt || this.filledAt.distanceTo(eye) > REFILL_STEP;
    const turned = forward !== null && forward.dot(this.filledForward) < REFILL_TURN;
    if (this.dirty || moved || turned) this.fill(eye, ranges, view, forward);
    this.updateAir(eye, heightAboveGround, R, airNow);
    let draws = 0;
    for (const mesh of this.meshes.values()) {
      if (!mesh.visible) continue;
      draws++;
      placeCameraRelative(mesh, this.anchor, eye);
    }
    this.stats.chunks = this.chunks.size;
    this.stats.draws = draws;
  }

  /**
   * The air's uniforms for this frame: the flight model's wind and gusts at the ground
   * under the eye and 50 m east, west, north and south of it (a linear field over the
   * ring), and the downwash, all relative to the anchor.
   */
  private updateAir(eye: Readonly<Vec3d>, aboveGround: number, R: number, a?: CoverAir): void {
    const u = this.air;
    u.time.value += a?.dt ?? 0;
    const up = this.wscratch[0]!.copy(eye).normalize();
    const east = this.wscratch[1]!.set(0, 1, 0).cross(up);
    if (east.length() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = this.wscratch[2]!.copy(up).cross(east);
    u.east.value.set(east.x, east.y, east.z);
    u.north.value.set(north.x, north.y, north.z);
    const groundR = eye.length() - Math.max(0, aboveGround);
    const at = (de: number, dn: number, out: Vec3d) => {
      const p = this.wscratch[3]!.copy(up)
        .addScaled(east, de / R)
        .addScaled(north, dn / R)
        .normalize()
        .scale(groundR);
      return airVelocity(a?.view ?? null, p, R, a?.gameTime ?? 0, 0.5, out);
    };
    const w0 = at(0, 0, this.wscratch[4]!);
    this.groundWind.copy(w0);
    u.at.value.set(w0.x, w0.y, w0.z);
    const STEP = 50;
    const e1 = at(STEP, 0, new Vec3d());
    const e0 = at(-STEP, 0, new Vec3d());
    const n1 = at(0, STEP, new Vec3d());
    const n0 = at(0, -STEP, new Vec3d());
    u.dEast.value.set(
      (e1.x - e0.x) / (2 * STEP),
      (e1.y - e0.y) / (2 * STEP),
      (e1.z - e0.z) / (2 * STEP),
    );
    u.dNorth.value.set(
      (n1.x - n0.x) / (2 * STEP),
      (n1.y - n0.y) / (2 * STEP),
      (n1.z - n0.z) / (2 * STEP),
    );
    // The field is linear about the eye's ground point; the shader measures from the anchor.
    const ox = this.anchor.x - eye.x;
    const oy = this.anchor.y - eye.y;
    const oz = this.anchor.z - eye.z;
    const de = ox * east.x + oy * east.y + oz * east.z;
    const dn = ox * north.x + oy * north.y + oz * north.z;
    u.at.value.addScaledVector(u.dEast.value, de).addScaledVector(u.dNorth.value, dn);
    const d = this.downwash;
    if (d && d.speed > 0) {
      u.washCenter.value.set(
        d.center.x - this.anchor.x,
        d.center.y - this.anchor.y,
        d.center.z - this.anchor.z,
      );
      u.washSpeed.value = d.speed;
      u.washRadius.value = d.radius;
    } else {
      u.washSpeed.value = 0;
    }
  }

  /** Copies the items within range and in view into the meshes, relative to an anchor at the eye. */
  private fill(
    eye: Readonly<Vec3d>,
    ranges: number[],
    view?: CullView,
    forward?: Vec3d | null,
  ): void {
    this.dirty = false;
    this.filledAt = (this.filledAt ?? new Vec3d()).copy(eye);
    if (forward) this.filledForward.copy(forward);
    this.anchor.copy(eye);
    const ex = this.terrain.exaggerationUniform.value;
    // The view cone, widened by a margin, for items more than a few meters away.
    const halfDiag = view
      ? Math.atan(Math.tan(view.fovY / 2) * Math.hypot(1, view.aspect)) + 0.15
      : Math.PI;
    const coneCos = Math.cos(Math.min(Math.PI, halfDiag));
    let instances = 0;
    let triangles = 0;
    COVER_KINDS.forEach((kind, ki) => {
      const range = ranges[ki]! + REFILL_STEP;
      const r2 = range * range;
      const lists: { chunk: Chunk; data: Float32Array }[] = [];
      let capacity = 0;
      for (const c of this.chunks.values()) {
        const data = c.lists.get(kind);
        if (!data) continue;
        // Chunks wholly out of range or out of view are skipped: a sphere round the chunk's
        // ground, wide enough for its relief.
        const center = this.center.copy(c.origin).scale(1 + (c.lift * ex) / c.origin.length());
        const chunkRadius = 160 + 60 * ex;
        if (center.distanceTo(eye) - chunkRadius > range) continue;
        if (view && sphereOutsideView(center, chunkRadius, view)) continue;
        lists.push({ chunk: c, data });
        capacity += data.length / COVER_FLOATS;
      }
      const mesh = this.meshFor(kind, capacity);
      if (!mesh) return;
      const g = mesh.geometry as InstancedBufferGeometry;
      const buffer = mesh.userData.buffer as InstancedInterleavedBuffer;
      const a = buffer.array as Float32Array;
      let count = 0;
      for (const { chunk, data } of lists) {
        const ox = chunk.origin.x - eye.x;
        const oy = chunk.origin.y - eye.y;
        const oz = chunk.origin.z - eye.z;
        const items = data.length / COVER_FLOATS;
        for (let i = 0; i < items; i++) {
          const o = i * COVER_FLOATS;
          const px = ox + data[o]! + data[o + 3]! * ex;
          const py = oy + data[o + 1]! + data[o + 4]! * ex;
          const pz = oz + data[o + 2]! + data[o + 5]! * ex;
          const dist2 = px * px + py * py + pz * pz;
          if (dist2 > r2) continue;
          if (forward && dist2 > 100) {
            const dist = Math.sqrt(dist2);
            if ((px * forward.x + py * forward.y + pz * forward.z) / dist < coneCos) continue;
          }
          // The same layout, the base relative to the anchor (the eye) instead of the chunk.
          const w = count * COVER_FLOATS;
          a.set(data.subarray(o, o + COVER_FLOATS), w);
          a[w] = ox + data[o]!;
          a[w + 1] = oy + data[o + 1]!;
          a[w + 2] = oz + data[o + 2]!;
          count++;
        }
      }
      g.instanceCount = count;
      buffer.clearUpdateRanges();
      if (count > 0) {
        buffer.addUpdateRange(0, count * COVER_FLOATS);
        buffer.needsUpdate = true;
      }
      mesh.userData.range = ranges[ki]!;
      mesh.visible = count > 0;
      instances += count;
      triangles += count * (mesh.userData.triangles as number);
    });
    this.stats.instances = instances;
    this.stats.triangles = triangles;
  }

  /** The kind's mesh, with room for at least `capacity` items (null for none). */
  private meshFor(kind: CoverKind, capacity: number): Mesh | null {
    let mesh = this.meshes.get(kind) ?? null;
    if (capacity === 0) {
      if (mesh) mesh.visible = false;
      return null;
    }
    const have = mesh ? (mesh.userData.capacity as number) : 0;
    if (mesh && have >= capacity) return mesh;
    // Grow by doubling: a new geometry (attributes cannot be resized in place).
    const cap = Math.max(256, 2 ** Math.ceil(Math.log2(capacity)));
    const geo = this.geometries.get(kind)!;
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(geo.position, 3));
    g.setAttribute('normal', new BufferAttribute(geo.normal, 3));
    g.setAttribute('color', new BufferAttribute(geo.color, 3));
    g.setAttribute('tint', new BufferAttribute(geo.tint, 1));
    // One interleaved buffer for the items (WebGPU allows only eight vertex buffers).
    const buffer = new InstancedInterleavedBuffer(
      new Float32Array(cap * COVER_FLOATS),
      COVER_FLOATS,
    );
    g.setAttribute('iBase', new InterleavedBufferAttribute(buffer, 3, 0));
    g.setAttribute('iDisp', new InterleavedBufferAttribute(buffer, 3, 3));
    g.setAttribute('iUp', new InterleavedBufferAttribute(buffer, 3, 6));
    g.setAttribute('iParams', new InterleavedBufferAttribute(buffer, 4, 9));
    g.setAttribute('iColor', new InterleavedBufferAttribute(buffer, 3, 13));
    g.instanceCount = 0;
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = g;
    } else {
      mesh = new Mesh(g, this.material);
      mesh.frustumCulled = false;
      mesh.userData.plant = ROCK_KINDS.has(kind) ? 0 : 1;
      mesh.userData.stiffness = STIFFNESS[kind] ?? 0;
      mesh.userData.height = geo.height;
      mesh.userData.triangles = geo.position.length / 9;
      this.group.add(mesh);
      this.meshes.set(kind, mesh);
    }
    mesh.userData.capacity = cap;
    mesh.userData.buffer = buffer;
    return mesh;
  }

  /** Drops every chunk (world or infrastructure change). */
  clear(): void {
    this.chunks.clear();
    this.building.clear();
    this.dirty = true;
    for (const m of this.meshes.values()) m.visible = false;
  }

  dispose(): void {
    for (const m of this.meshes.values()) m.geometry.dispose();
    this.meshes.clear();
    this.chunks.clear();
    this.material.dispose();
  }
}
