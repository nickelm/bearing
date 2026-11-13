/**
 * Terrain shadows (decision 139): mountains shade the ground, the water, trees,
 * buildings, aircraft and clouds behind them at low sun.
 *
 * - The field. Three nested grids around the camera hold, per texel, how far
 *   the sun shadow's upper surface stands above the ground there (0 on lit
 *   ground), the distance to the terrain that casts it, and the ground height
 *   the bake used. A lit surface reads it with one texture read (two in the
 *   band where two grids blend) and compares its own height:
 *   `visibility(p)`, which `PlanetLighting.sunlightAt` multiplies in.
 * - The lattice. Each grid is a window of SHADOW_SIZE² points of the terrain
 *   tiles' sample lattice (core/tiles.ts) on the cube face under the camera,
 *   continued past the face's edges by the same warp: levels 6, 4 and 2, so
 *   about 96 m, 380 m and 1.5 km between points and 49, 196 and 785 km across
 *   at R = 1,000 km. Lattice points are fixed on the planet and a window moves
 *   in steps of SHADOW_SNAP points, so a shadow does not swim when the window
 *   re-centers.
 * - Heights. The two finer grids take the terrain tiles' own heights from the
 *   tile cache (the surface the player sees: in high mountains the global
 *   grid is hundreds of meters off it), read on the CPU a few rows per frame.
 *   They ask the terrain for the tiles under their windows, levels 7 and 5,
 *   at a priority below anything the view needs. Where a tile has not loaded
 *   yet, and for the coarse grid, heights come from the world's global height
 *   grid in a cube-face atlas.
 * - The bake. By compute, coarse grid first. A texel's shadow height is the
 *   highest terrain along the great circle toward the sun, lowered by the
 *   sun's elevation and the planet's curvature: a ray that leaves radius r at
 *   elevation e has radius r·cos e / cos(e + φ) after the angle φ, so terrain
 *   of radius r' at φ shades everything below r'·cos(e + φ) / cos e. That
 *   chains exactly, since the sun stands φ higher at the far point. Each pass
 *   therefore doubles the reach: pass k takes the larger of a texel's own
 *   value and the lowered value 2^k steps toward the sun (one bilinear read),
 *   SHADOW_STEPS passes for 2^SHADOW_STEPS steps. The first pass also looks
 *   half a step ahead, so the chain visits every half step and no texel is
 *   skipped where the warp squeezes the lattice. A step past the window, and
 *   one last step from the end of the reach, read the next coarser grid, whose
 *   values are complete. The planet's limb needs nothing extra: sea level
 *   beyond the terminator shades whatever lies below R·(1/cos e − 1).
 *   Values are kept relative to the ground (half floats are exact enough near
 *   zero, not at 4 km), and lit ground is exactly 0.
 * - Scheduling. One compute pass per frame (more while the game clock runs
 *   fast), so a full bake takes about thirty frames and none stalls. A grid is
 *   baked again when its window has moved, when the sun has moved by an angle
 *   that shifts a 1 km ridge's shadow by about one near texel (`bakeAngle`),
 *   when tiles under it have loaded, or when the exaggeration changes; tile
 *   heights are read again only for a window that moved or gained tiles, so a
 *   bake for a new sun is compute passes alone. The sun is baked a little
 *   ahead of where it stands, by its measured speed. Nothing is baked while
 *   the sun is high or well below the horizon (`shadowStrength`), above the
 *   simulation view's altitudes, or while the game clock turns the sun by
 *   degrees per bake (`shadowFollow`): there the shadows fade out.
 * - Softness. The edge is a smoothstep over a height range that grows with the
 *   distance to the occluder (the sun's angular size, widened while the bake
 *   lags a fast clock) and never falls under one and a half texels.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  StorageTexture,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { ComputeNode, Node, Texture, UniformNode, WebGPURenderer } from 'three/webgpu';
import {
  abs,
  atan,
  clamp,
  dot,
  float,
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  length,
  max,
  min,
  mix,
  normalize,
  select,
  smoothstep,
  sqrt,
  step,
  tan,
  texture,
  textureStore,
  uniform,
  uvec2,
  vec2,
  vec4,
} from 'three/tsl';
import {
  CUBE_FACES,
  cubeFaceUvToDirection,
  directionToCubeFace,
  directionToFace,
  projectToCubeFace,
} from '../../../core/coords';
import type { CubeFace, CubeFaceUv } from '../../../core/coords';
import { TILE_BORDER, TILE_STRIDE, TILE_TEXELS } from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { DEG, PLANET_RADIUS } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import { cubeFaceUv } from '../../common/climateTexture';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** Texels per grid edge. */
export const SHADOW_SIZE = 512;
/** The tile level whose sample lattice each grid uses, finest first. */
export const SHADOW_TILE_LEVELS = [6, 4, 2] as const;
/** A window's origin moves in steps of this many texels. */
export const SHADOW_SNAP = 32;
/** Doubling passes per grid: the reach is 2^SHADOW_STEPS steps. */
export const SHADOW_STEPS = 7;
/**
 * A step toward the sun, in nominal texels. The warp squeezes texels to 0.7 of
 * nominal, so the first pass also samples half a step ahead.
 */
export const SHADOW_STEP_TEXELS = 1;
/** Faces of the height atlas hold at most this many cells per edge. */
export const ATLAS_LIMIT = 1024;
/** Height (m) that marks a source texel without tile data. */
const NO_TILE = -30_000;
/** Largest stored shadow height (m): half floats end at 65,504. */
const MAX_SHADOW = 30_000;
/** Fraction of a window, from its edge, over which a grid fades into the next coarser one. */
const WINDOW_FADE = 1 / 16;
/** The sun's angular diameter (rad) for the penumbra, a little over the real 0.53°. */
const SUN_DIAMETER = 0.012;
/** Seconds a grid takes to fade in after its first bake or a jump. */
const APPEAR_SECONDS = 0.6;
/** Frames the fields are kept after `enabled` goes off, so a brief toggle costs no bake. */
const OFF_FRAMES = 120;
/** Frames between checks for newly loaded tiles, and the least time between bakes they cause (ms). */
const SIGNATURE_FRAMES = 20;
const SIGNATURE_INTERVAL_MS = 750;
/** Most compute passes in one frame, while the game clock runs fast. */
const MAX_PASSES = 4;
/**
 * The sun's travel during one bake (rad) from which the shadows fade out, and
 * where they are gone: a clock so fast that the field cannot follow the sun.
 */
const LAG_FADE = [1.5 * DEG, 4 * DEG] as const;
/** Camera altitudes (m) over which the shadows fade out: from orbit they are smaller than a pixel. */
const ALTITUDE_FADE = [60_000, 150_000] as const;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Lattice points per face edge of a tile level. */
export function latticeSize(tileLevel: number): number {
  return TILE_TEXELS << tileLevel;
}

/**
 * The cube face whose lattice the grids use: the current one while the camera
 * is within about 49° of its center (65 km past the middle of an edge), so
 * flying along an edge does not flip it; otherwise the face under the camera.
 */
export function anchorFace(dir: Readonly<Vec3d>, current: CubeFace | null): CubeFace {
  if (current !== null && dir.dot(CUBE_FACES[current]!.normal) > 0.66 * dir.length()) {
    return current;
  }
  return directionToFace(dir);
}

/**
 * A window's origin (the lattice index of its texel 0) along one axis, for a
 * camera at lattice coordinate `coordinate`: centered, in steps of `snap`,
 * and kept while the camera stays within three quarters of a step of the
 * center the current origin gives, so hovering at a boundary does not re-bake.
 */
export function windowOrigin(
  coordinate: number,
  current: number | null = null,
  size = SHADOW_SIZE,
  snap = SHADOW_SNAP,
): number {
  if (current !== null && Math.abs(coordinate - (current + size / 2)) <= 0.75 * snap) {
    return current;
  }
  return Math.round(coordinate / snap) * snap - size / 2;
}

/**
 * The sun-angle change (rad) after which a field baked at sun elevation
 * `elevation` (rad) is stale: the tip of a 1 km ridge's shadow moves by
 * h·Δ / sin² e, so 0.1·sin² e keeps it to about one near texel (96 m).
 */
export function bakeAngle(elevation: number): number {
  const s = Math.sin(Math.max(elevation, 0));
  return Math.min(0.5 * DEG, Math.max(0.005 * DEG, 0.1 * s * s));
}

/**
 * How strongly shadows apply, 0..1, by the sun's elevation at the camera
 * (rad): off above about 48° (short shadows; facets facing away are dark
 * anyway) and from 9° below the horizon (no direct light is left).
 */
export function shadowStrength(elevation: number): number {
  return smooth(48 * DEG, 40 * DEG, elevation) * smooth(-9 * DEG, -7 * DEG, elevation);
}

/**
 * How well a bake keeps up with the sun, 1..0: `sunSpeed` is the sun's angular
 * speed (rad per real second), `bakeSeconds` what a full bake takes at the
 * most passes per frame. 1 up to about 3,000 times real time at 60 frames
 * per second, 0 from about 8,000 times: there a day lasts ten seconds, and
 * shadows that trail the sun by several degrees are worse than none.
 */
export function shadowFollow(sunSpeed: number, bakeSeconds: number): number {
  return 1 - smooth(LAG_FADE[0], LAG_FADE[1], sunSpeed * bakeSeconds);
}

/** A unit vector turned about `axis` (unit) by `angle` (rad), in place. */
function rotate(v: Vec3d, axis: Readonly<Vec3d>, angle: number): Vec3d {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = axis.dot(v) * (1 - c);
  const cx = axis.y * v.z - axis.z * v.y;
  const cy = axis.z * v.x - axis.x * v.z;
  const cz = axis.x * v.y - axis.y * v.x;
  return v.set(
    v.x * c + cx * s + axis.x * d,
    v.y * c + cy * s + axis.y * d,
    v.z * c + cz * s + axis.z * d,
  );
}

export interface HeightAtlas {
  /** Half floats, 3 × 2 faces of (n + 2)² texels (see coverageBake.ts for the layout). */
  data: Uint16Array;
  /** Interior texels per face edge. */
  n: number;
  width: number;
  height: number;
}

/**
 * The world's global height grid (CubeGrid layout, n² cells per face, m) as
 * a bordered cube-face atlas of displayed heights: the sea is 0, grids finer
 * than `limit` are averaged down, and each face's border holds the cells
 * across its seams, so bilinear filtering is continuous over them.
 */
export function buildHeightAtlas(
  height: Float32Array,
  n: number,
  limit = ATLAS_LIMIT,
): HeightAtlas {
  let f = 1;
  while (n / f > limit && (n / f) % 2 === 0) f *= 2;
  const nd = n / f;
  const faces = new Float32Array(6 * nd * nd);
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < nd; y++) {
      for (let x = 0; x < nd; x++) {
        let sum = 0;
        for (let dy = 0; dy < f; dy++) {
          const row = face * n * n + (y * f + dy) * n + x * f;
          for (let dx = 0; dx < f; dx++) sum += Math.max(0, height[row + dx]!);
        }
        faces[face * nd * nd + y * nd + x] = sum / (f * f);
      }
    }
  }
  const m = nd + 2;
  const width = 3 * m;
  const data = new Uint16Array(width * 2 * m);
  const dir = new Vec3d();
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  for (let face = 0; face < 6; face++) {
    const ox = (face % 3) * m;
    const oy = Math.floor(face / 3) * m;
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        let h: number;
        if (x > 0 && x <= nd && y > 0 && y <= nd) {
          h = faces[face * nd * nd + (y - 1) * nd + x - 1]!;
        } else {
          // A border texel: the cell under its own center, on the neighboring face.
          cubeFaceUvToDirection(face as CubeFace, (x - 0.5) / nd, (y - 0.5) / nd, dir);
          directionToCubeFace(dir, uv);
          const cx = Math.min(nd - 1, Math.max(0, Math.floor(uv.u * nd)));
          const cy = Math.min(nd - 1, Math.max(0, Math.floor(uv.v * nd)));
          h = faces[uv.face * nd * nd + cy * nd + cx]!;
        }
        data[(oy + y) * width + ox + x] = DataUtils.toHalfFloat(h);
      }
    }
  }
  return { data, n: nd, width, height: 2 * m };
}

/** The atlas's height (m) at a direction, bilinear between texels as the bake samples it. */
export function sampleHeightAtlas(atlas: HeightAtlas, dir: Readonly<Vec3d>): number {
  const uv = directionToCubeFace(dir);
  const m = atlas.n + 2;
  // Texel centers are at integers + 0.5; interior texel 1 holds cell 0.
  const tx = (uv.face % 3) * m + uv.u * atlas.n + 0.5;
  const ty = Math.floor(uv.face / 3) * m + uv.v * atlas.n + 0.5;
  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  const fx = tx - x0;
  const fy = ty - y0;
  const at = (x: number, y: number) => DataUtils.fromHalfFloat(atlas.data[y * atlas.width + x]!);
  return (
    (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
    (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  );
}

/** What the bake reads tile heights from: the terrain's tile cache. */
export interface TileHeights {
  /** Cached data of a tile (levels up to the finest baked), or undefined. */
  dataTile(key: TileKey): { height: Float32Array } | undefined;
  /** Asks for a tile's data to be generated; requests last one frame (TerrainRenderer.requestDataTile). */
  requestDataTile?(key: TileKey, priority: number): void;
}

/** Priority of the bake's tile requests, in the terrain's pixels of error: after everything in view. */
export const SHADOW_TILE_PRIORITY = 0.25;

// Local copies: the per-texel loop below reads them a dozen times.
const toHalf = DataUtils.toHalfFloat;
const TEXELS = TILE_TEXELS;
const STRIDE = TILE_STRIDE;
const BORDER = TILE_BORDER;

/**
 * Raw height (m) at face coordinates from the finest cached tile between
 * levels `finest` and `coarsest`, bilinear between its samples, or null.
 * `lookup` returns a tile's heights (TILE_STRIDE² samples) or null.
 */
export function tileHeightAt(
  lookup: (face: CubeFace, level: number, x: number, y: number) => Float32Array | null,
  face: CubeFace,
  u: number,
  v: number,
  finest: number,
  coarsest: number,
): number | null {
  for (let level = finest; level >= coarsest; level--) {
    const tiles = 1 << level;
    const cx = u * tiles * TEXELS;
    const cy = v * tiles * TEXELS;
    const x = Math.min(tiles - 1, Math.max(0, Math.floor(cx / TEXELS)));
    const y = Math.min(tiles - 1, Math.max(0, Math.floor(cy / TEXELS)));
    const h = lookup(face, level, x, y);
    if (!h) continue;
    const fx = cx - x * TEXELS;
    const fy = cy - y * TEXELS;
    const x0 = Math.min(TEXELS - 1, Math.max(0, Math.floor(fx)));
    const y0 = Math.min(TEXELS - 1, Math.max(0, Math.floor(fy)));
    const tx = fx - x0;
    const ty = fy - y0;
    const i = (y0 + BORDER) * STRIDE + x0 + BORDER;
    return (
      (h[i]! * (1 - tx) + h[i + 1]! * tx) * (1 - ty) +
      (h[i + STRIDE]! * (1 - tx) + h[i + STRIDE + 1]! * tx) * ty
    );
  }
  return null;
}

/** One sample of a shadow field: shadow height over the ground (m), occluder distance (km), ground (m). */
export interface ShadowSample {
  shadow: number;
  distance: number;
  ground: number;
}

export interface ReferenceBake {
  /** Texels per edge. */
  size: number;
  /** Lattice points per face edge. */
  lattice: number;
  face: CubeFace;
  /** Lattice index of texel (0, 0). */
  origin: readonly [number, number];
  /** Unit vector toward the sun. */
  sun: Readonly<Vec3d>;
  radius: number;
  /** Displayed ground height (m) at a unit direction. */
  ground: (dir: Readonly<Vec3d>) => number;
  /** The next coarser field at a unit direction, or null outside it. */
  coarse?: (dir: Readonly<Vec3d>) => ShadowSample | null;
  steps?: number;
  stepTexels?: number;
}

/**
 * The bake of one grid on the CPU, pass for pass as the compute kernels do
 * it: the reference the GPU test compares with, and what the unit tests check
 * against the geometry. Returns size² × 3 values (shadow, distance, ground).
 */
export function bakeReference(o: ReferenceBake): Float32Array {
  const n = o.size;
  // The fields are stored as half floats between passes.
  const half = (x: number) => DataUtils.fromHalfFloat(DataUtils.toHalfFloat(x));
  const steps = o.steps ?? SHADOW_STEPS;
  const phi0 = ((o.stepTexels ?? SHADOW_STEP_TEXELS) * (Math.PI / 2)) / o.lattice;
  const dirs: Vec3d[] = [];
  let a = new Float32Array(n * n * 3);
  let b = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = cubeFaceUvToDirection(
        o.face,
        (o.origin[0] + x) / o.lattice,
        (o.origin[1] + y) / o.lattice,
      );
      dirs.push(d);
      a[(y * n + x) * 3 + 2] = half(Math.max(0, o.ground(d)));
    }
  }
  const uv: CubeFaceUv = { face: o.face, u: 0, v: 0 };
  const ahead = new Vec3d();
  const sunH = new Vec3d();
  const sample: ShadowSample = { shadow: 0, distance: 0, ground: 0 };
  /** Bilinear read of the working field at texel coordinates, as the sampler does it. */
  const bilinear = (f: Float32Array, tx: number, ty: number): ShadowSample => {
    const x0 = Math.min(n - 2, Math.max(0, Math.floor(tx)));
    const y0 = Math.min(n - 2, Math.max(0, Math.floor(ty)));
    const fx = Math.min(1, Math.max(0, tx - x0));
    const fy = Math.min(1, Math.max(0, ty - y0));
    const at = (c: number) => {
      const i = (y0 * n + x0) * 3 + c;
      return (
        (f[i]! * (1 - fx) + f[i + 3]! * fx) * (1 - fy) +
        (f[i + n * 3]! * (1 - fx) + f[i + n * 3 + 3]! * fx) * fy
      );
    };
    sample.shadow = at(0);
    sample.distance = at(1);
    sample.ground = at(2);
    return sample;
  };
  for (let k = 0; k <= steps; k++) {
    const last = k === steps;
    if (last && !o.coarse) break;
    for (let i = 0; i < n * n; i++) {
      const d = dirs[i]!;
      const own = i * 3;
      let shadow = a[own]!;
      let distance = a[own + 1]!;
      const ground = a[own + 2]!;
      const s = d.dot(o.sun);
      const c = Math.sqrt(Math.max(1 - s * s, 1e-6));
      sunH
        .copy(o.sun)
        .addScaled(d, -s)
        .scale(1 / c);
      // The first pass looks half a step ahead as well.
      for (const phi of k === 0 ? [phi0 / 2, phi0] : [phi0 * 2 ** k]) {
        ahead.copy(d).scale(Math.cos(phi)).addScaled(sunH, Math.sin(phi)).normalize();
        let found: ShadowSample | null = null;
        if (!last && ahead.dot(CUBE_FACES[o.face]!.normal) > 0.05) {
          projectToCubeFace(ahead, o.face, uv);
          const tx = uv.u * o.lattice - o.origin[0];
          const ty = uv.v * o.lattice - o.origin[1];
          if (tx > 0 && ty > 0 && tx < n - 1 && ty < n - 1) found = bilinear(a, tx, ty);
        }
        found ??= o.coarse?.(ahead) ?? null;
        if (!found || s >= 0.95) continue;
        const drop =
          ((o.radius + found.shadow + found.ground) *
            2 *
            (s * Math.cos(phi / 2) + c * Math.sin(phi / 2)) *
            Math.sin(phi / 2)) /
          c;
        const candidate = found.shadow + found.ground - ground - drop;
        if (candidate > shadow) {
          shadow = Math.min(candidate, MAX_SHADOW);
          distance = found.distance + (phi * o.radius) / 1000;
        }
      }
      b[own] = half(shadow);
      b[own + 1] = half(distance);
      b[own + 2] = ground;
    }
    [a, b] = [b, a];
  }
  // Half floats round the ground by up to a part in 2,048: an occluder must clear that.
  for (let i = 0; i < n * n; i++) {
    a[i * 3] = half(Math.max(a[i * 3]! - (a[i * 3 + 2]! / 1024 + 0.25), 0));
  }
  return a;
}

/**
 * Sunlight left at height `h` (m) over a field sample, as `visibility` computes
 * it: `spacing` is the grid's nominal texel (m), `sinElevation` the sun's at
 * the point, `diameter` the angular size the penumbra uses (rad).
 */
export function shadowVisibility(
  s: ShadowSample,
  h: number,
  spacing: number,
  sinElevation: number,
  diameter = SUN_DIAMETER,
): number {
  const above = Math.max(h - s.ground, 0);
  const width = Math.max(
    1.5 * spacing * Math.max(sinElevation, 0),
    s.distance * 1000 * diameter,
    1,
  );
  return 1 - smooth(0, 1, (s.shadow - above) / width);
}

interface Kernels {
  init: ComputeNode;
  first: ComputeNode;
  ab: ComputeNode;
  ba: ComputeNode;
  final: ComputeNode;
}

interface Level {
  tileLevel: number;
  /** Lattice points per face edge. */
  size: number;
  /** Nominal texel (m). */
  spacing: number;
  /** The published field: shadow height over the ground (m), occluder distance (km), ground (m). */
  result: StorageTexture;
  /** Lattice index of the published field's texel (0, 0). */
  origin: UniformNode<'vec2', Vector2>;
  /** 0 until baked, then 1 (fading in over APPEAR_SECONDS). */
  valid: UniformNode<'float', number>;
  /** Tile heights under the window (half floats, NO_TILE where none is cached); null for the atlas alone. */
  source: DataTexture | null;
  kernels: Kernels | null;
  baked: {
    sun: Vec3d;
    origin: [number, number];
    exaggeration: number;
    signature: string;
    atMs: number;
  } | null;
  /** Which tile levels are cached under the wanted window, polled every SIGNATURE_FRAMES. */
  signature: string;
  /** The finest-level tiles under the wanted window, and the origin they were listed for. */
  wanted: TileKey[];
  wantedFor: [number, number] | null;
  /** The window and the tiles `source` was last read for: a bake for a new sun alone reads nothing. */
  filled: { origin: [number, number]; signature: string } | null;
  /** `source` holds no tile heights. */
  cleared: boolean;
}

interface Job {
  level: number;
  origin: [number, number];
  sun: Vec3d;
  signature: string;
  exaggeration: number;
  /** Next source row to fill; SHADOW_SIZE once the source is ready. */
  row: number;
  /** Next compute pass: 0 is the init, 1..SHADOW_STEPS the doublings, then the final. */
  pass: number;
}

export interface TerrainShadowStats {
  /** Grids published so far. */
  bakes: number;
  /** Compute passes run so far. */
  passes: number;
  /** Compute passes run by the last `update`. */
  framePasses: number;
  /** Milliseconds the last `update` spent reading tile heights. */
  sourceMs: number;
  /** Rows of tile heights read so far (SHADOW_SIZE per grid whose window moved or gained tiles). */
  sourceRows: number;
  /** Frames the last finished job took, all its grids together. */
  jobFrames: number;
}

/** Compute passes that bake one grid. */
export const PASSES_PER_GRID = SHADOW_STEPS + 2;

export class TerrainShadow {
  /** Bakes and applies shadows; off costs one uniform branch per lookup. */
  enabled = true;
  /** Height exaggeration of the drawn terrain. */
  exaggeration = 1;
  /** Tile heights for the two finer grids (the terrain renderer), or null for the global grid alone. */
  tiles: TileHeights | null = null;
  /** Milliseconds per frame for reading tile heights. */
  sourceBudgetMs = 1;
  /** Multiplies the penumbra's width. */
  readonly softness = uniform(1);
  /** How strongly the field applies now, 0..1: the uniform switch of every lookup. */
  readonly strength = uniform(0);
  readonly stats: TerrainShadowStats = {
    bakes: 0,
    passes: 0,
    framePasses: 0,
    sourceMs: 0,
    sourceRows: 0,
    jobFrames: 0,
  };

  private readonly levels: Level[];
  private readonly workA = fieldTexture();
  private readonly workB = fieldTexture();
  private atlas: DataTexture | null = null;
  private atlasN = 0;
  /** The anchor face's frame, for lookups and kernels. */
  private readonly faceNormal = uniform(new Vector3(1, 0, 0));
  private readonly faceU = uniform(new Vector3(0, 0, -1));
  private readonly faceV = uniform(new Vector3(0, 1, 0));
  private face: CubeFace | null = null;
  /** Penumbra angle (rad): the sun's size times the softness, plus the bake's lag. */
  private readonly penumbra = uniform(SUN_DIAMETER);
  /** The kernels' inputs for the pass being run. */
  private readonly wOrigin = uniform(new Vector2());
  private readonly wSun = uniform(new Vector3(1, 0, 0));
  private readonly wStep = stepUniforms();
  /** Half the first pass's step. */
  private readonly wHalfStep = stepUniforms();
  private readonly wExaggeration = uniform(1);

  /** Frames since `enabled` went off. */
  private offFrames = 0;
  private job: Job | null = null;
  private queue: number[] = [];
  private jobFrames = 0;
  private frame = 0;
  private readonly lastSun = new Vec3d();
  private readonly sunAxis = new Vec3d(0, 1, 0);
  /** The sun's angular speed (rad per real second), smoothed. */
  private sunSpeed = 0;
  private frameSeconds = 1 / 60;
  private readonly memo = new Map<number, Float32Array | null>();
  /** The last tile looked up at each level: neighboring texels mostly share it. */
  private readonly memoKey = new Int32Array(8).fill(-1);
  private readonly memoValue: (Float32Array | null)[] = new Array<Float32Array | null>(8).fill(
    null,
  );
  /** The camera's coordinates on the anchor face. */
  private cameraU = 0.5;
  private cameraV = 0.5;
  /** Compute passes per frame at the current pace. */
  private passesNow = 1;
  private readonly scratch = new Vec3d();
  private readonly scratchAxis = new Vec3d();
  private readonly scratchUv: CubeFaceUv = { face: 0, u: 0, v: 0 };

  constructor(
    private readonly sunDirection: UniformNode<'vec3', Vector3>,
    readonly radius = PLANET_RADIUS,
  ) {
    this.levels = SHADOW_TILE_LEVELS.map((tileLevel, l) => ({
      tileLevel,
      size: latticeSize(tileLevel),
      spacing: ((Math.PI / 2) * radius) / latticeSize(tileLevel),
      result: fieldTexture(),
      origin: uniform(new Vector2()),
      valid: uniform(0),
      source: l < SHADOW_TILE_LEVELS.length - 1 ? sourceTexture() : null,
      kernels: null,
      baked: null,
      signature: '',
      wanted: [],
      wantedFor: null,
      filled: null,
      cleared: true,
    }));
  }

  /**
   * The world's global height grid (CubeGrid layout, n² cells per face, m), or
   * null for no world: without it nothing is baked and everything is lit.
   */
  setHeights(height: Float32Array | null, n = 0): void {
    this.atlas?.dispose();
    this.atlas = null;
    this.dropKernels();
    this.reset();
    if (!height) return;
    const a = buildHeightAtlas(height, n);
    const t = new DataTexture(a.data, a.width, a.height, RedFormat, HalfFloatType);
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.atlas = t;
    this.atlasN = a.n;
  }

  /** Forgets every baked field (after a camera or clock jump the next bakes fade in). */
  reset(): void {
    this.job = null;
    this.queue = [];
    for (const level of this.levels) {
      level.baked = null;
      level.valid.value = 0;
      level.signature = '';
      level.filled = null;
    }
    this.strength.value = 0;
    this.sunSpeed = 0;
    this.lastSun.set(0, 0, 0);
    this.frame = 0;
  }

  /** Whether a bake is under way or waiting. */
  get busy(): boolean {
    return this.job !== null || this.queue.length > 0;
  }

  /**
   * Fraction of sunlight that reaches planet-centered point `p` past the
   * terrain, 0..1; usable in any shader stage. One texture read, two where
   * two grids blend, none while `strength` is 0.
   */
  visibility(p: V3): F {
    return Fn(() => {
      const visible = float(1).toVar();
      If(this.strength.greaterThan(0), () => {
        const r = length(p).toVar();
        const up = p.div(r).toVar();
        const h = r.sub(this.radius).toVar();
        const sinElevation = max(dot(up, this.sunDirection), 0).toVar();
        const f = this.faceUv(up as V3);
        const faceUvVar = f.uv.toVar();
        const facing = f.facing.toVar();
        const shade = (l: number, uv: V2): F => {
          const s = texture(this.levels[l]!.result, uv).level(int(0));
          const above = max(h.sub(s.z), 0);
          const width = max(
            max(sinElevation.mul(1.5 * this.levels[l]!.spacing), s.y.mul(this.penumbra.mul(1000))),
            1,
          );
          return smoothstep(0, 1, clamp(s.x.sub(above).div(width), 0, 1)) as F;
        };
        const window = (l: number) => {
          const w = this.window(this.levels[l]!, faceUvVar as V2, facing as F);
          return { uv: w.uv.toVar() as V2, weight: w.weight.toVar() as F };
        };
        const shadow = float(0).toVar();
        const w0 = window(0);
        If(w0.weight.greaterThanEqual(1), () => {
          shadow.assign(shade(0, w0.uv));
        }).Else(() => {
          const w1 = window(1);
          If(w0.weight.greaterThan(0), () => {
            shadow.assign(mix(shade(1, w1.uv).mul(w1.weight), shade(0, w0.uv), w0.weight));
          })
            .ElseIf(w1.weight.greaterThanEqual(1), () => {
              shadow.assign(shade(1, w1.uv));
            })
            .Else(() => {
              const w2 = window(2);
              shadow.assign(mix(shade(2, w2.uv).mul(w2.weight), shade(1, w1.uv), w1.weight));
            });
        });
        visible.assign(float(1).sub(shadow.mul(this.strength)));
      });
      return visible;
    })() as F;
  }

  /**
   * One grid's field at planet-centered `p`, for tests and debug views: shadow
   * height over the ground (m), occluder distance (km), ground (m), and the
   * window's weight (0 outside it).
   */
  field(l: number, p: V3): V4 {
    const level = this.levels[l]!;
    const f = this.faceUv(normalize(p) as V3);
    const w = this.window(level, f.uv, f.facing);
    return vec4(texture(level.result, w.uv).level(int(0)).xyz, w.weight) as V4;
  }

  /** The lattice origin of a grid's published window, or null before its first bake. */
  origin(l: number): readonly [number, number] | null {
    return this.levels[l]!.baked?.origin ?? null;
  }

  /** The cube face whose lattice the grids use (null before the first update). */
  get anchor(): CubeFace | null {
    return this.face;
  }

  /**
   * Once per frame, before drawing: follows the camera and the sun, decides
   * what is stale and runs this frame's share of the bake. `dt` is real
   * seconds since the last frame (0 applies fades at once).
   */
  update(
    renderer: WebGPURenderer,
    eye: Readonly<Vec3d>,
    sun: Readonly<Vec3d>,
    dt: number,
    nowMs = performance.now(),
  ): void {
    this.stats.framePasses = 0;
    this.stats.sourceMs = 0;
    const altitude = eye.length() - this.radius;
    const up = this.scratch.copy(eye).normalize();
    const elevation = Math.asin(Math.min(1, Math.max(-1, up.dot(sun))));
    this.trackSun(sun, dt);
    const wanted = this.atlas
      ? shadowStrength(elevation) *
        (1 - smooth(ALTITUDE_FADE[0], ALTITUDE_FADE[1], altitude)) *
        shadowFollow(this.sunSpeed, (this.frameSeconds * this.gridPasses()) / MAX_PASSES)
      : 0;
    if (wanted === 0 || (!this.enabled && ++this.offFrames > OFF_FRAMES)) {
      // Out of range, or switched off for a while: the fields would be stale on return.
      if (this.levels.some((level) => level.baked) || this.busy) {
        this.job = null;
        this.queue = [];
        for (const level of this.levels) {
          level.baked = null;
          level.valid.value = 0;
        }
      }
      this.strength.value = 0;
      return;
    }
    if (!this.enabled) {
      // Switched off just now: the fields are kept for a moment, nothing is baked.
      this.strength.value = 0;
      return;
    }
    this.offFrames = 0;
    this.strength.value = wanted;
    this.follow(up);
    this.requestTiles();
    this.schedule(sun, elevation, nowMs);
    this.run(renderer, this.passesPerFrame(elevation), this.sourceBudgetMs, nowMs);
    // The penumbra widens by what the sun moves while a bake is under way.
    const lag = Math.min(2 * DEG, this.sunSpeed * this.frameSeconds * this.bakeFrames());
    this.penumbra.value = SUN_DIAMETER * this.softness.value + lag;
    for (const level of this.levels) {
      if (level.baked && level.valid.value < 1) {
        level.valid.value = dt > 0 ? Math.min(1, level.valid.value + dt / APPEAR_SECONDS) : 1;
      }
    }
    this.frame++;
  }

  /** Bakes everything that is stale for this camera and sun now (tests and previews). */
  bake(renderer: WebGPURenderer, eye: Readonly<Vec3d>, sun: Readonly<Vec3d>): void {
    if (!this.atlas) return;
    const up = this.scratch.copy(eye).normalize();
    const elevation = Math.asin(Math.min(1, Math.max(-1, up.dot(sun))));
    this.strength.value = this.enabled ? shadowStrength(elevation) : 0;
    this.follow(up);
    this.sunSpeed = 0;
    this.lastSun.copy(sun);
    for (const level of this.levels) level.signature = this.signatureOf(level);
    this.schedule(sun, elevation, Infinity);
    while (this.busy) this.run(renderer, Infinity, Infinity, 0);
    for (const level of this.levels) if (level.baked) level.valid.value = 1;
    this.penumbra.value = SUN_DIAMETER * this.softness.value;
  }

  dispose(): void {
    this.dropKernels();
    this.atlas?.dispose();
    this.workA.dispose();
    this.workB.dispose();
    for (const level of this.levels) {
      level.result.dispose();
      level.source?.dispose();
    }
  }

  /** The sun's angular speed and axis, from frame to frame. */
  private trackSun(sun: Readonly<Vec3d>, dt: number): void {
    if (dt > 0 && this.lastSun.lengthSq() > 0) {
      const cross = this.scratchAxis.copy(this.lastSun).cross(sun);
      const sin = cross.length();
      const speed = Math.asin(Math.min(1, sin)) / dt;
      if (sin > 1e-12) this.sunAxis.copy(cross).scale(1 / sin);
      this.sunSpeed += (speed - this.sunSpeed) * Math.min(1, dt * 4);
      this.frameSeconds += (dt - this.frameSeconds) * 0.1;
    }
    this.lastSun.copy(sun);
  }

  /** Compute passes of a full bake, all grids. */
  private gridPasses(): number {
    return PASSES_PER_GRID * this.levels.length;
  }

  /** Frames a full bake takes at the current pace. */
  private bakeFrames(): number {
    return this.gridPasses() / this.passesNow;
  }

  /** Compute passes per frame: one, more while the sun outruns a bake by more than its threshold. */
  private passesPerFrame(elevation: number): number {
    const perBake = this.sunSpeed * this.frameSeconds * this.gridPasses();
    this.passesNow = Math.min(
      MAX_PASSES,
      Math.max(1, Math.ceil(perBake / (2 * bakeAngle(elevation)))),
    );
    return this.passesNow;
  }

  /** Moves the anchor face and the wanted windows with the camera. */
  private follow(up: Readonly<Vec3d>): void {
    const face = anchorFace(up, this.face);
    if (face !== this.face) {
      // Another lattice: every field starts over.
      this.face = face;
      const f = CUBE_FACES[face]!;
      this.faceNormal.value.set(f.normal.x, f.normal.y, f.normal.z);
      this.faceU.value.set(f.uAxis.x, f.uAxis.y, f.uAxis.z);
      this.faceV.value.set(f.vAxis.x, f.vAxis.y, f.vAxis.z);
      this.job = null;
      this.queue = [];
      for (const level of this.levels) {
        level.baked = null;
        level.valid.value = 0;
        level.filled = null;
      }
    }
    projectToCubeFace(up, face, this.scratchUv);
    this.cameraU = this.scratchUv.u;
    this.cameraV = this.scratchUv.v;
  }

  /** The window a level wants for the camera, keeping its baked one while the camera is near its center. */
  private wantedOrigin(level: Level): [number, number] {
    const b = level.baked?.origin ?? null;
    return [
      windowOrigin(this.cameraU * level.size, b ? b[0] : null),
      windowOrigin(this.cameraV * level.size, b ? b[1] : null),
    ];
  }

  /** Queues the stale grids, coarse first, unless a job is under way. */
  private schedule(sun: Readonly<Vec3d>, elevation: number, nowMs: number): void {
    if (this.frame % SIGNATURE_FRAMES === 0) {
      for (const level of this.levels) level.signature = this.signatureOf(level);
    }
    if (this.busy) return;
    const threshold = bakeAngle(elevation);
    for (let l = this.levels.length - 1; l >= 0; l--) {
      const level = this.levels[l]!;
      const b = level.baked;
      const origin = this.wantedOrigin(level);
      const stale =
        !b ||
        b.origin[0] !== origin[0] ||
        b.origin[1] !== origin[1] ||
        b.exaggeration !== this.exaggeration ||
        Math.acos(Math.min(1, b.sun.dot(sun))) > threshold ||
        (b.signature !== level.signature && nowMs - b.atMs > SIGNATURE_INTERVAL_MS);
      if (stale) this.queue.push(l);
    }
    this.jobFrames = 0;
  }

  /** The sun the next bake uses: ahead of now by the bake's duration and half the time to the one after. */
  private predictedSun(sun: Readonly<Vec3d>, elevation: number): Vec3d {
    const out = new Vec3d().copy(sun);
    if (this.sunSpeed <= 0) return out;
    const duration = this.bakeFrames() * this.frameSeconds;
    const interval = Math.max(duration, bakeAngle(elevation) / this.sunSpeed);
    const lead = Math.min(3 * DEG, this.sunSpeed * (duration + interval / 2));
    return rotate(out, this.sunAxis, lead);
  }

  /** Runs up to `passes` compute passes of the job, after filling its source within `budgetMs`. */
  private run(renderer: WebGPURenderer, passes: number, budgetMs: number, nowMs: number): void {
    if (!this.atlas || this.face === null) return;
    if (this.busy) this.jobFrames++;
    let left = passes;
    while (left > 0) {
      if (!this.job) {
        const l = this.queue.shift();
        if (l === undefined) return;
        const level = this.levels[l]!;
        const elevation = this.cameraElevation();
        // The tiles cached under the window this job reads, as of now.
        level.signature = this.signatureOf(level);
        const origin = this.wantedOrigin(level);
        // The source still holds this window's heights unless the window moved or tiles loaded.
        const filled =
          level.filled !== null &&
          level.filled.origin[0] === origin[0] &&
          level.filled.origin[1] === origin[1] &&
          level.filled.signature === level.signature;
        this.job = {
          level: l,
          origin,
          sun: this.predictedSun(this.lastSun, elevation),
          signature: level.signature,
          exaggeration: this.exaggeration,
          row: level.source && this.tiles && !filled ? 0 : SHADOW_SIZE,
          pass: 0,
        };
        if (level.source && !this.tiles) this.clearSource(level);
      }
      const job = this.job;
      const level = this.levels[job.level]!;
      if (job.row < SHADOW_SIZE) {
        // Rows of the old window are overwritten from here on.
        level.filled = null;
        level.cleared = false;
        const t0 = performance.now();
        while (job.row < SHADOW_SIZE) {
          this.fillRow(level, job, job.row++);
          this.stats.sourceRows++;
          if ((job.row & 7) === 0 && performance.now() - t0 > budgetMs) break;
        }
        this.stats.sourceMs += performance.now() - t0;
        if (job.row < SHADOW_SIZE) return;
        level.source!.needsUpdate = true;
        level.filled = { origin: job.origin, signature: job.signature };
      }
      const kernels = (level.kernels ??= this.buildKernels(job.level));
      this.wOrigin.value.set(job.origin[0], job.origin[1]);
      this.wSun.value.set(job.sun.x, job.sun.y, job.sun.z);
      this.wExaggeration.value = job.exaggeration;
      // The last pass steps from the end of the reach into the coarser grid.
      const k = Math.min(Math.max(job.pass - 1, 0), SHADOW_STEPS);
      const phi = (SHADOW_STEP_TEXELS * (Math.PI / 2) * 2 ** k) / level.size;
      setStep(this.wStep, phi, this.radius);
      setStep(this.wHalfStep, phi / 2, this.radius);
      const final = job.pass === SHADOW_STEPS + 1;
      void renderer.compute(
        job.pass === 0
          ? kernels.init
          : final
            ? kernels.final
            : job.pass === 1
              ? kernels.first
              : job.pass % 2 === 1
                ? kernels.ab
                : kernels.ba,
      );
      this.stats.passes++;
      this.stats.framePasses++;
      left--;
      job.pass++;
      if (final) {
        // Published: lookups switch to the new window in the frame that reads the new texels.
        const jumped =
          !level.baked ||
          Math.abs(level.baked.origin[0] - job.origin[0]) >= SHADOW_SIZE / 2 ||
          Math.abs(level.baked.origin[1] - job.origin[1]) >= SHADOW_SIZE / 2;
        level.origin.value.set(job.origin[0], job.origin[1]);
        level.baked = {
          sun: job.sun,
          origin: job.origin,
          exaggeration: job.exaggeration,
          signature: job.signature,
          atMs: nowMs,
        };
        if (jumped) level.valid.value = 1e-3;
        this.stats.bakes++;
        this.job = null;
        if (this.queue.length === 0) this.stats.jobFrames = this.jobFrames;
      }
    }
  }

  /** The sun's elevation at the camera (rad), from the last update's vectors. */
  private cameraElevation(): number {
    if (this.face === null) return 0;
    const up = cubeFaceUvToDirection(this.face, this.cameraU, this.cameraV, this.scratchAxis);
    return Math.asin(Math.min(1, Math.max(-1, up.dot(this.lastSun))));
  }

  /** Heights of a cached tile, remembered for the job. */
  private tileData = (face: CubeFace, level: number, x: number, y: number): Float32Array | null => {
    const key = (((face << 3) | level) << 14) | (x << 7) | y;
    if (key === this.memoKey[level]) return this.memoValue[level]!;
    let value = this.memo.get(key);
    if (value === undefined) {
      value = this.tiles?.dataTile({ face, level, x, y })?.height ?? null;
      this.memo.set(key, value);
    }
    this.memoKey[level] = key;
    this.memoValue[level] = value;
    return value;
  };

  private clearMemo(): void {
    this.memo.clear();
    this.memoKey.fill(-1);
  }

  /**
   * Asks the terrain for the finest tiles under the two tile-fed windows that
   * are not loaded (every frame: requests last one frame).
   */
  private requestTiles(): void {
    const request = this.tiles?.requestDataTile;
    if (!request || this.face === null) return;
    const uv = this.scratchUv;
    for (const level of this.levels) {
      if (!level.source) continue;
      const origin = this.wantedOrigin(level);
      if (
        !level.wantedFor ||
        level.wantedFor[0] !== origin[0] ||
        level.wantedFor[1] !== origin[1]
      ) {
        // Points every eighth of the window: closer than the tiles are wide.
        const [finest] = this.sourceLevels(level);
        const tiles = 1 << finest;
        const seen = new Set<number>();
        level.wanted = [];
        for (let y = 0; y <= 8; y++) {
          for (let x = 0; x <= 8; x++) {
            this.latticePoint(
              level,
              origin[0] + (x * SHADOW_SIZE) / 8,
              origin[1] + (y * SHADOW_SIZE) / 8,
              uv,
            );
            const tx = Math.min(tiles - 1, Math.max(0, Math.floor(uv.u * tiles)));
            const ty = Math.min(tiles - 1, Math.max(0, Math.floor(uv.v * tiles)));
            const id = (uv.face << 14) | (tx << 7) | ty;
            if (seen.has(id)) continue;
            seen.add(id);
            level.wanted.push({ face: uv.face, level: finest, x: tx, y: ty });
          }
        }
        level.wantedFor = origin;
      }
      // Reading a cached tile marks it used, so the terrain's cache keeps what the next bake
      // reads (evicted, it would be asked for again, and each arrival bakes the grid anew).
      for (const key of level.wanted) {
        if (!this.tiles!.dataTile(key)) request.call(this.tiles, key, SHADOW_TILE_PRIORITY);
      }
    }
  }

  /** The tile levels a source reads, finest first: one finer than its lattice down to two coarser. */
  private sourceLevels(level: Level): [number, number] {
    return [Math.min(level.tileLevel + 1, 7), Math.max(level.tileLevel - 2, 0)];
  }

  /** Face coordinates of a lattice point of the anchor face, on the face it lies on. */
  private latticePoint(level: Level, i: number, j: number, out: CubeFaceUv): CubeFaceUv {
    const size = level.size;
    if (i >= 0 && i <= size && j >= 0 && j <= size) {
      out.face = this.face!;
      out.u = i / size;
      out.v = j / size;
      return out;
    }
    return directionToCubeFace(
      cubeFaceUvToDirection(this.face!, i / size, j / size, this.scratchAxis),
      out,
    );
  }

  /** One row of a level's tile heights for the job's window. */
  private fillRow(level: Level, job: Job, row: number): void {
    const data = level.source!.image.data as Uint16Array;
    const [finest, coarsest] = this.sourceLevels(level);
    const uv = this.scratchUv;
    for (let x = 0; x < SHADOW_SIZE; x++) {
      this.latticePoint(level, job.origin[0] + x, job.origin[1] + row, uv);
      const h = tileHeightAt(this.tileData, uv.face, uv.u, uv.v, finest, coarsest);
      data[row * SHADOW_SIZE + x] = toHalf(h === null ? NO_TILE : Math.max(h, 0));
    }
  }

  private clearSource(level: Level): void {
    if (level.cleared) return;
    (level.source!.image.data as Uint16Array).fill(DataUtils.toHalfFloat(NO_TILE));
    level.source!.needsUpdate = true;
    level.filled = null;
    level.cleared = true;
  }

  /** Which tile level is cached at a 9 × 9 grid of points of the wanted window ('-' for none). */
  private signatureOf(level: Level): string {
    if (!level.source || !this.tiles || this.face === null) return '';
    this.clearMemo();
    const [finest, coarsest] = this.sourceLevels(level);
    const origin = this.wantedOrigin(level);
    const uv = this.scratchUv;
    let out = '';
    for (let y = 0; y <= 8; y++) {
      for (let x = 0; x <= 8; x++) {
        this.latticePoint(
          level,
          origin[0] + (x * SHADOW_SIZE) / 8,
          origin[1] + (y * SHADOW_SIZE) / 8,
          uv,
        );
        let found = '-';
        for (let l = finest; l >= coarsest && found === '-'; l--) {
          const tiles = 1 << l;
          const tx = Math.min(tiles - 1, Math.max(0, Math.floor(uv.u * tiles)));
          const ty = Math.min(tiles - 1, Math.max(0, Math.floor(uv.v * tiles)));
          if (this.tileData(uv.face, l, tx, ty)) found = String(l);
        }
        out += found;
      }
    }
    return out;
  }

  private dropKernels(): void {
    for (const level of this.levels) {
      if (!level.kernels) continue;
      for (const k of Object.values(level.kernels) as ComputeNode[]) k.dispose();
      level.kernels = null;
    }
  }

  /** Extended face coordinates of a direction on the anchor face, and how squarely it faces it. */
  private faceUv(d: V3): { uv: V2; facing: F } {
    const facing = dot(d, this.faceNormal);
    const safe = max(facing, 1e-3);
    const a = dot(d, this.faceU).div(safe);
    const b = dot(d, this.faceV).div(safe);
    return {
      uv: vec2(atan(a), atan(b))
        .div(Math.PI / 2)
        .add(0.5) as V2,
      facing: facing as F,
    };
  }

  /** Texture coordinates of a level's published window, and its weight: 0 outside, 1 past the fade. */
  private window(level: Level, faceUv: V2, facing: F): { uv: V2; weight: F } {
    const uv = faceUv.mul(level.size).sub(level.origin).add(0.5).div(SHADOW_SIZE);
    const edge = float(0.5).sub(max(abs(uv.x.sub(0.5)), abs(uv.y.sub(0.5))));
    const weight = clamp(edge.div(WINDOW_FADE), 0, 1).mul(level.valid).mul(step(0.05, facing));
    return { uv: uv as V2, weight: weight as F };
  }

  /** Unit direction of a lattice point of the anchor face. */
  private latticeDirection(lattice: V2, size: number): V3 {
    const angle = lattice
      .div(size)
      .mul(2)
      .sub(1)
      .mul(Math.PI / 4);
    return normalize(
      this.faceNormal.add(this.faceU.mul(tan(angle.x))).add(this.faceV.mul(tan(angle.y))),
    ) as V3;
  }

  /** Displayed height (m, sea 0) of the global grid at a direction. */
  private atlasHeight(dir: V3): F {
    const { face, uv } = cubeFaceUv(dir);
    const n = this.atlasN;
    const m = n + 2;
    const st = uv.mul(n).add(1).div(m);
    const cell = vec2(face.mod(3).toFloat(), face.div(3).toFloat());
    return texture(this.atlas!, cell.add(st).div(vec2(3, 2))).level(int(0)).x as F;
  }

  /**
   * The compute passes of one grid (see the module comment): `init` writes the
   * ground, `first` is the first step with its half step, `ab` and `ba` are a
   * doubling step between the two work textures, `final` steps into the
   * coarser grid and publishes.
   */
  private buildKernels(l: number): Kernels {
    const level = this.levels[l]!;
    const coarse = this.levels[l + 1] ?? null;
    const n = SHADOW_SIZE;
    const last = SHADOW_STEPS % 2 === 1 ? this.workB : this.workA;
    const load = (map: Texture, texel: Node<'ivec2'>): V4 =>
      texture(map, texel).setSampler(false) as unknown as V4;
    const texelOf = () => {
      const y = instanceIndex.div(n);
      const x = instanceIndex.sub(y.mul(n));
      return { x, y, texel: ivec2(int(x), int(y)) };
    };
    const init = Fn(() => {
      const { x, y, texel } = texelOf();
      const dir = this.latticeDirection(
        vec2(float(x), float(y)).add(this.wOrigin) as V2,
        level.size,
      );
      const ground = this.atlasHeight(dir).toVar();
      if (level.source) {
        const tile = load(level.source, texel).x;
        ground.assign(select(tile.greaterThan(NO_TILE / 2), tile, ground));
      }
      textureStore(
        this.workA,
        uvec2(x, y),
        vec4(0, 0, max(ground, 0).mul(this.wExaggeration), 0),
      ).toWriteOnly();
    })().compute(n * n);

    const stepKernel = (
      from: StorageTexture,
      to: StorageTexture,
      mode: 'first' | 'step' | 'final',
    ) =>
      Fn(() => {
        const final = mode === 'final';
        const { x, y, texel } = texelOf();
        const own = load(from, texel).toVar();
        const shadow = own.x.toVar();
        const distance = own.y.toVar();
        if (!final || coarse) {
          const dir = this.latticeDirection(
            vec2(float(x), float(y)).add(this.wOrigin) as V2,
            level.size,
          ).toVar();
          const s = dot(dir, this.wSun).toVar();
          const c = sqrt(max(float(1).sub(s.mul(s)), 1e-6)).toVar();
          const sunH = this.wSun.sub(dir.mul(s)).div(c).toVar();
          /** Takes what lies one step ahead if it shades this texel more. */
          const look = (u: StepUniforms) => {
            const ahead = normalize(dir.mul(u.cosPhi).add(sunH.mul(u.sinPhi))).toVar();
            const f = this.faceUv(ahead as V3);
            const faceUvVar = f.uv.toVar();
            const facing = f.facing.toVar();
            // What lies ahead: (shadow, distance, ground, found).
            const found = vec4(0).toVar();
            const fromCoarse = () => {
              if (!coarse) return;
              const w = this.window(coarse, faceUvVar as V2, facing as F);
              If(w.weight.greaterThan(0), () => {
                found.assign(vec4(texture(coarse.result, w.uv).level(int(0)).xyz, 1));
              });
            };
            if (final) {
              fromCoarse();
            } else {
              const uv = faceUvVar.mul(level.size).sub(this.wOrigin).add(0.5).div(n).toVar();
              const lo = 0.5 / n;
              const inside = uv.x
                .greaterThan(lo)
                .and(uv.y.greaterThan(lo))
                .and(uv.x.lessThan(1 - lo))
                .and(uv.y.lessThan(1 - lo))
                .and(facing.greaterThan(0.05));
              If(inside, () => {
                found.assign(vec4(texture(from, uv).level(int(0)).xyz, 1));
              }).Else(fromCoarse);
            }
            // The ray's fall over the step: (r + h)·(1 − cos(e + φ) / cos e), in small terms.
            const drop = float(this.radius)
              .add(found.x)
              .add(found.z)
              .mul(2)
              .mul(s.mul(u.cosHalf).add(c.mul(u.sinHalf)))
              .mul(u.sinHalf)
              .div(c);
            const candidate = found.x.add(found.z).sub(own.z).sub(drop);
            const take = found.w
              .greaterThan(0.5)
              .and(s.lessThan(0.95))
              .and(candidate.greaterThan(shadow));
            If(take, () => {
              shadow.assign(min(candidate, MAX_SHADOW));
              distance.assign(found.y.add(u.km));
            });
          };
          if (mode === 'first') look(this.wHalfStep);
          look(this.wStep);
        }
        if (final) {
          // Half floats round the ground by up to a part in 2,048: an occluder must clear that.
          const biased = max(shadow.sub(own.z.div(1024).add(0.25)), 0);
          textureStore(to, uvec2(x, y), vec4(biased, distance, own.z, 1)).toWriteOnly();
        } else {
          textureStore(to, uvec2(x, y), vec4(shadow, distance, own.z, 0)).toWriteOnly();
        }
      })().compute(n * n);

    return {
      init,
      first: stepKernel(this.workA, this.workB, 'first'),
      ab: stepKernel(this.workA, this.workB, 'step'),
      ba: stepKernel(this.workB, this.workA, 'step'),
      final: stepKernel(last, level.result, 'final'),
    };
  }
}

/** One step toward the sun by the angle φ, as the kernels need it. */
interface StepUniforms {
  sinPhi: UniformNode<'float', number>;
  cosPhi: UniformNode<'float', number>;
  /** Of φ / 2. */
  sinHalf: UniformNode<'float', number>;
  cosHalf: UniformNode<'float', number>;
  /** The step's length on the ground (km). */
  km: UniformNode<'float', number>;
}

function stepUniforms(): StepUniforms {
  return {
    sinPhi: uniform(0),
    cosPhi: uniform(1),
    sinHalf: uniform(0),
    cosHalf: uniform(1),
    km: uniform(0),
  };
}

function setStep(u: StepUniforms, phi: number, radius: number): void {
  u.sinPhi.value = Math.sin(phi);
  u.cosPhi.value = Math.cos(phi);
  u.sinHalf.value = Math.sin(phi / 2);
  u.cosHalf.value = Math.cos(phi / 2);
  u.km.value = (phi * radius) / 1000;
}

/** A half-float RGBA storage texture of one grid, bilinear and clamped. */
function fieldTexture(): StorageTexture {
  const t = new StorageTexture(SHADOW_SIZE, SHADOW_SIZE);
  t.type = HalfFloatType;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  return t;
}

/** A half-float texture of one grid's tile heights, read texel by texel. */
function sourceTexture(): DataTexture {
  const t = new DataTexture(
    new Uint16Array(SHADOW_SIZE * SHADOW_SIZE).fill(DataUtils.toHalfFloat(NO_TILE)),
    SHADOW_SIZE,
    SHADOW_SIZE,
    RedFormat,
    HalfFloatType,
  );
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
