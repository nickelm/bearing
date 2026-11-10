/**
 * CPU construction of terrain tile meshes. Pure TypeScript, float64 until
 * the final write into float32 attributes.
 *
 * - Grid: (TILE_SEGMENTS + 1)² vertices, one every 4 samples, plus a skirt
 *   along each edge that hangs below the surface to hide cracks between
 *   tiles of different levels.
 * - Positions are relative to a float64 tile origin (the tile center on the
 *   sphere). The renderer places the mesh at origin − eye (rule 4).
 * - Heights: tiles up to the finest baked level read their own TileData.
 *   Deeper tiles read the level-MAX_BAKED_LEVEL ancestor (bilinear) and add
 *   render detail noise, a pure function of direction like the bake, so
 *   neighbors still agree.
 * - The sea is drawn flat at sea level; land is exaggerated. `height` holds
 *   the raw height (negative at sea) and the shader clamps it, so the
 *   fragment stage gets an interpolated water depth and a coastline finer
 *   than the vertex grid (decision 37).
 * - Geomorphing (CDLOD-style): `positionParent` holds the parent's surface
 *   under each vertex: the parent's own heights at even vertices, and the
 *   midpoint of the parent's edge or diagonal at odd ones. The shader blends
 *   from it to `position` with the tile's morph factor.
 * - Normals come from height differences one sample apart, using the tile's
 *   border, so they agree across tile edges.
 */
import { cubeFaceUvToDirection } from '../../core/coords';
import type { Noise3 } from '../../core/noise';
import { parentTile, tileKey, TILE_BORDER, TILE_STRIDE, TILE_TEXELS } from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { Vec3d } from '../../core/vec3d';
import { Biome } from '../../worldgen/biomes';
import type { TileData } from '../../worldgen/gpu/tileSynth';
import { MAX_BAKED_LEVEL, NO_LAKE } from '../../worldgen/gpu/tileSynth';
import { BIOME_COLORS, HEIGHT_RAMP, hsl, ramp, srgbToLinear } from '../palette';
import type { Rgb } from '../palette';
import { TILE_SEGMENTS, vertexSpacing } from './quadtree';

export const TILE_VIEW_MODES = ['biome', 'height', 'level', 'borders'] as const;
export type TileViewMode = (typeof TILE_VIEW_MODES)[number];

const V = TILE_SEGMENTS + 1;
const GRID_VERTICES = V * V;
const SKIRT_VERTICES = 4 * V;
export const TILE_VERTEX_COUNT = GRID_VERTICES + SKIRT_VERTICES;
const STEP = TILE_TEXELS / TILE_SEGMENTS;

/**
 * Vertex data of one tile. Exaggeration is applied in the vertex shader, so
 * changing it needs no rebuild; `displacedPosition` below is the same
 * formula on the CPU:
 *   own    = base + up · max(height + max(water, 0), 0) · exaggeration
 *   parent = parentBase + parentDisp · exaggeration
 *   position = mix(parent, own, morph)
 *   normal   = normalize(up − slope · exaggeration)
 */
export interface TileMeshData {
  tile: TileKey;
  /** Tile center on the sphere (m, planet-centered, float64). */
  origin: Vec3d;
  /** Point on the sphere (skirts: below it), relative to the origin. */
  base: Float32Array;
  /** Unit radial direction. */
  up: Float32Array;
  /** Raw surface height (m, negative under the sea); the displayed height is max(0, h). */
  height: Float32Array;
  /**
   * Signed lake depth (m): lake level − height, positive under a lake,
   * negative on dry ground near one, −LAKE_DRY far from any lake. Lakes are
   * displayed flat at their level; the shader's shoreline is the zero
   * crossing (decision 40).
   */
  water: Float32Array;
  /**
   * Signed distance to the coastline estimate (m): −h / |∇h|, positive at sea,
   * negative on land, clamped to ±SHORE_CLAMP. Interpolates smoothly, unlike
   * screen-derivative estimates (coastal foam, decision 39).
   */
  shore: Float32Array;
  /** Morph target: the parent's surface, as base + displacement (before exaggeration). */
  parentBase: Float32Array;
  parentDisp: Float32Array;
  /** Surface gradient of the displayed height (before exaggeration), a tangent vector. */
  slope: Float32Array;
  /** Linear RGB albedo: biome on land, seabed under the sea (or a debug-mode color). */
  color: Float32Array;
  /** Displayed height range before exaggeration (m). */
  minHeight: number;
  maxHeight: number;
}

/** Vertex `v`'s displaced position relative to the origin, as the shader computes it. */
export function displacedPosition(
  m: TileMeshData,
  v: number,
  exaggeration: number,
  morph = 1,
  out = new Vec3d(),
): Vec3d {
  const k = v * 3;
  const h = Math.max(0, m.height[v]! + Math.max(0, m.water[v]!)) * exaggeration;
  const ox = m.base[k]! + m.up[k]! * h;
  const oy = m.base[k + 1]! + m.up[k + 1]! * h;
  const oz = m.base[k + 2]! + m.up[k + 2]! * h;
  const px = m.parentBase[k]! + m.parentDisp[k]! * exaggeration;
  const py = m.parentBase[k + 1]! + m.parentDisp[k + 1]! * exaggeration;
  const pz = m.parentBase[k + 2]! + m.parentDisp[k + 2]! * exaggeration;
  return out.set(px + (ox - px) * morph, py + (oy - py) * morph, pz + (oz - pz) * morph);
}

export interface MeshSources {
  /** Data of the tile itself (levels ≤ MAX_BAKED_LEVEL) or of its ancestor at MAX_BAKED_LEVEL. */
  data: TileData;
  /** Data of the parent tile, for levels 1..MAX_BAKED_LEVEL (the morph target). */
  parentData: TileData | null;
}

export interface MeshOptions {
  radius: number;
  reliefScale: number;
  mode: TileViewMode;
  /** Render detail noise below the finest baked level (seeded per world). */
  detail: Noise3;
}

/** Shared index buffer: grid triangles split along (i, j)–(i+1, j+1), plus skirts. */
export function buildTileIndex(): Uint32Array {
  const idx: number[] = [];
  const g = (i: number, j: number) => j * V + i;
  for (let j = 0; j < TILE_SEGMENTS; j++) {
    for (let i = 0; i < TILE_SEGMENTS; i++) {
      const a = g(i, j);
      const b = g(i + 1, j);
      const c = g(i + 1, j + 1);
      const d = g(i, j + 1);
      idx.push(a, b, c, a, c, d);
    }
  }
  // Skirts: edge e runs along edgeVertex(e, k); skirt vertex = GRID_VERTICES + e·V + k.
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < TILE_SEGMENTS; k++) {
      const a = edgeVertex(e, k);
      const b = edgeVertex(e, k + 1);
      const sa = GRID_VERTICES + e * V + k;
      const sb = sa + 1;
      idx.push(a, sa, b, b, sa, sb);
    }
  }
  return Uint32Array.from(idx);
}

/** Grid vertex k (0..TILE_SEGMENTS) along edge e: 0 = bottom (j = 0), 1 = top, 2 = left, 3 = right. */
function edgeVertex(e: number, k: number): number {
  switch (e) {
    case 0:
      return k;
    case 1:
      return TILE_SEGMENTS * V + k;
    case 2:
      return k * V;
    default:
      return k * V + TILE_SEGMENTS;
  }
}

/** Bilinear height in a TileData at fractional sample coordinates (clamped into the border). */
function bilinear(data: TileData, fx: number, fy: number): number {
  const lo = -TILE_BORDER;
  const hi = TILE_TEXELS + TILE_BORDER;
  const x = Math.min(hi, Math.max(lo, fx));
  const y = Math.min(hi, Math.max(lo, fy));
  const x0 = Math.min(hi - 1, Math.floor(x));
  const y0 = Math.min(hi - 1, Math.floor(y));
  const tx = x - x0;
  const ty = y - y0;
  const h = data.height;
  const i00 = (y0 + TILE_BORDER) * TILE_STRIDE + x0 + TILE_BORDER;
  const a = h[i00]!;
  const b = h[i00 + 1]!;
  const c = h[i00 + TILE_STRIDE]!;
  const d = h[i00 + TILE_STRIDE + 1]!;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Signed lake depth stored for vertices with no lake nearby (m). */
export const LAKE_DRY = 50;

/**
 * Lake level at fractional sample coordinates: the highest level among the
 * four surrounding samples (levels are flat per lake), or NO_LAKE.
 */
function lakeLevel(data: TileData, fx: number, fy: number): number {
  const lo = -TILE_BORDER;
  const hi = TILE_TEXELS + TILE_BORDER;
  const x0 = Math.min(hi - 1, Math.max(lo, Math.floor(fx)));
  const y0 = Math.min(hi - 1, Math.max(lo, Math.floor(fy)));
  const i00 = (y0 + TILE_BORDER) * TILE_STRIDE + x0 + TILE_BORDER;
  const l = data.lake;
  return Math.max(l[i00]!, l[i00 + 1]!, l[i00 + TILE_STRIDE]!, l[i00 + TILE_STRIDE + 1]!);
}

/** Displayed height before exaggeration: the sea flat at 0, lakes flat at their level. */
const displayHeight = (h: number, level: number) => Math.max(0, h, level);

function materialAt(data: TileData, fx: number, fy: number): number {
  const x = Math.min(TILE_TEXELS, Math.max(0, Math.round(fx)));
  const y = Math.min(TILE_TEXELS, Math.max(0, Math.round(fy)));
  return data.material[(y + TILE_BORDER) * TILE_STRIDE + x + TILE_BORDER]!;
}

/** Map sample coordinates of tile `t` into the sample space of its ancestor/descendant `d`. */
function mapSample(t: TileKey, d: TileKey, sx: number, sy: number): [number, number] {
  // Global sample index at t's level, rescaled to d's level, relative to d.
  const scale = 2 ** (d.level - t.level);
  return [
    (t.x * TILE_TEXELS + sx) * scale - d.x * TILE_TEXELS,
    (t.y * TILE_TEXELS + sy) * scale - d.y * TILE_TEXELS,
  ];
}

/** Render-detail octaves for a level below the finest bake (wavelengths ≥ 2 vertex spacings). */
export function renderDetailOctaves(level: number, radius: number): number[] {
  const out: number[] = [];
  for (let lambda = 100; lambda >= 2 * vertexSpacing(level, radius); lambda /= 2) out.push(lambda);
  return level > MAX_BAKED_LEVEL ? out : [];
}

/** Lake level of `src` at tile `t`'s sample coordinates. */
function lakeSampler(t: TileKey, src: TileData): (sx: number, sy: number) => number {
  const [ox, oy] = mapSample(t, src.key, 0, 0);
  const scale = 2 ** (src.key.level - t.level);
  return (sx, sy) => lakeLevel(src, ox + sx * scale, oy + sy * scale);
}

/** Surface height (physical m) of `level`'s surface at tile `t`'s sample coordinates. */
function surfaceSampler(
  t: TileKey,
  level: number,
  src: TileData,
  opts: MeshOptions,
): (sx: number, sy: number, dir: Readonly<Vec3d>) => number {
  const [ox, oy] = mapSample(t, src.key, 0, 0);
  const scale = 2 ** (src.key.level - t.level);
  const lambdas = renderDetailOctaves(level, opts.radius);
  const R = opts.radius;
  return (sx, sy, dir) => {
    const h = bilinear(src, ox + sx * scale, oy + sy * scale);
    if (lambdas.length === 0 || h <= 0) return h;
    // Amplitude follows the local relief of the baked surface.
    const fx = ox + sx * scale;
    const fy = oy + sy * scale;
    const relief =
      Math.abs(bilinear(src, fx + 1, fy) - bilinear(src, fx - 1, fy)) +
      Math.abs(bilinear(src, fx, fy + 1) - bilinear(src, fx, fy - 1));
    let detail = 0;
    for (const lambda of lambdas) {
      const f = R / lambda;
      detail +=
        0.12 * (0.5 + relief) * (lambda / 100) * opts.detail.noise(dir.x * f, dir.y * f, dir.z * f);
    }
    return h + detail;
  };
}

/** Seabed albedo (sRGB): sand in the shallows, darker silt in deep water. */
function seabedColor(h: number, reliefScale: number): Rgb {
  const t = Math.min(1, -h / (200 * reliefScale));
  return [0.66 - 0.3 * t, 0.6 - 0.28 * t, 0.46 - 0.2 * t];
}

function colorFor(
  mode: TileViewMode,
  h: number,
  material: number,
  river: number,
  level: number,
  edge: boolean,
  reliefScale: number,
): Rgb {
  let c: Rgb;
  if (mode === 'height') {
    c = ramp(HEIGHT_RAMP, h / reliefScale);
  } else if (mode === 'level') {
    c = hsl((level * 0.13) % 1, 0.6, 0.5);
  } else {
    const biome = material & 0xff;
    if (h <= 0) {
      // The shader draws the water over it (decision 37).
      c = seabedColor(h, reliefScale);
    } else if (mode === 'borders' && (material >> 16) & 1) {
      c = BIOME_COLORS[Biome.Shelf]!;
    } else {
      const b = BIOME_COLORS[biome] ?? [1, 0, 1];
      c = [
        b[0] + (0.15 - b[0]) * river,
        b[1] + (0.35 - b[1]) * river,
        b[2] + (0.75 - b[2]) * river,
      ];
    }
    if (mode === 'borders') {
      const l = hsl((level * 0.13) % 1, 0.7, 0.5);
      c = [c[0] * 0.6 + l[0] * 0.4, c[1] * 0.6 + l[1] * 0.4, c[2] * 0.6 + l[2] * 0.4];
      if (edge) c = [0.05, 0.05, 0.05];
    }
  }
  return c;
}

/** River coverage 0..1 of a material sample. */
function riverOf(data: TileData, sx: number, sy: number): number {
  return ((data.material[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER]! >> 8) & 0xff) / 255;
}

/**
 * River coverage at a vertex. A vertex spanning several samples takes the
 * strongest coverage within one vertex spacing, so thin rivers stay
 * continuous lines instead of stippling where they run diagonally. A vertex
 * finer than the samples interpolates bilinearly.
 */
function riverAt(data: TileData, fx: number, fy: number, footprint: number): number {
  const lo = -TILE_BORDER;
  const hi = TILE_TEXELS + TILE_BORDER;
  if (footprint >= 1) {
    const r = Math.ceil(footprint);
    const cx = Math.round(fx);
    const cy = Math.round(fy);
    let best = 0;
    for (let y = Math.max(lo, cy - r); y <= Math.min(hi, cy + r); y++) {
      for (let x = Math.max(lo, cx - r); x <= Math.min(hi, cx + r); x++) {
        const d2 = (x - fx) ** 2 + (y - fy) ** 2;
        if (d2 > footprint * footprint) continue;
        best = Math.max(best, riverOf(data, x, y));
      }
    }
    return best;
  }
  const x = Math.min(hi - 1, Math.max(lo, Math.floor(fx)));
  const y = Math.min(hi - 1, Math.max(lo, Math.floor(fy)));
  const tx = Math.min(1, Math.max(0, fx - x));
  const ty = Math.min(1, Math.max(0, fy - y));
  return (
    (riverOf(data, x, y) * (1 - tx) + riverOf(data, x + 1, y) * tx) * (1 - ty) +
    (riverOf(data, x, y + 1) * (1 - tx) + riverOf(data, x + 1, y + 1) * tx) * ty
  );
}

/** Largest coast distance stored per vertex (m). */
export const SHORE_CLAMP = 5000;

/** Exaggeration assumed for skirt depth (the GUI allows up to 40). */
const SKIRT_EXAGGERATION = 40;

/** Builds the vertex data of tile `t`. */
export function buildTileMesh(t: TileKey, sources: MeshSources, opts: MeshOptions): TileMeshData {
  const R = opts.radius;
  const own = surfaceSampler(t, t.level, sources.data, opts);
  const ownLake = lakeSampler(t, sources.data);
  const parentKey = parentTile(t);
  const parentSource =
    parentKey !== null && t.level <= MAX_BAKED_LEVEL
      ? (sources.parentData ?? sources.data)
      : sources.data;
  const parentSurface =
    parentKey === null ? own : surfaceSampler(t, t.level - 1, parentSource, opts);
  const parentLake = parentKey === null ? ownLake : lakeSampler(t, parentSource);

  const fu = (s: number) => (t.x * TILE_TEXELS + s) / (TILE_TEXELS * (1 << t.level));
  const fv = (s: number) => (t.y * TILE_TEXELS + s) / (TILE_TEXELS * (1 << t.level));
  const dirAt = (sx: number, sy: number, out: Vec3d) =>
    cubeFaceUvToDirection(t.face, fu(sx), fv(sy), out);

  const origin = dirAt(TILE_TEXELS / 2, TILE_TEXELS / 2, new Vec3d()).scale(R);
  const o3 = [origin.x, origin.y, origin.z];
  const n3 = TILE_VERTEX_COUNT * 3;
  const base = new Float32Array(n3);
  const up = new Float32Array(n3);
  const height = new Float32Array(TILE_VERTEX_COUNT);
  const water = new Float32Array(TILE_VERTEX_COUNT);
  const shore = new Float32Array(TILE_VERTEX_COUNT);
  const parentBase = new Float32Array(n3);
  const parentDisp = new Float32Array(n3);
  const slope = new Float32Array(n3);
  const color = new Float32Array(n3);

  // Grid: directions, own heights and parent heights (float64).
  const dirs = new Float64Array(GRID_VERTICES * 3);
  const hOwn = new Float64Array(GRID_VERTICES);
  const lOwn = new Float64Array(GRID_VERTICES);
  const hPar = new Float64Array(GRID_VERTICES);
  const d = new Vec3d();
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const v = j * V + i;
      dirAt(i * STEP, j * STEP, d);
      dirs[v * 3] = d.x;
      dirs[v * 3 + 1] = d.y;
      dirs[v * 3 + 2] = d.z;
      hOwn[v] = own(i * STEP, j * STEP, d);
      lOwn[v] = ownLake(i * STEP, j * STEP);
      if (i % 2 === 0 && j % 2 === 0) {
        hPar[v] = displayHeight(
          parentSurface(i * STEP, j * STEP, d),
          parentLake(i * STEP, j * STEP),
        );
      }
    }
  }

  // Base, up, height; parent: midpoint of the parent's edge or diagonal (the shared split).
  let minH = Infinity;
  let maxH = -Infinity;
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const v = j * V + i;
      const k = v * 3;
      const ux = dirs[k]!;
      const uy = dirs[k + 1]!;
      const uz = dirs[k + 2]!;
      base[k] = ux * R - origin.x;
      base[k + 1] = uy * R - origin.y;
      base[k + 2] = uz * R - origin.z;
      up[k] = ux;
      up[k + 1] = uy;
      up[k + 2] = uz;
      const dh = displayHeight(hOwn[v]!, lOwn[v]!);
      height[v] = hOwn[v]!;
      water[v] = lOwn[v]! > NO_LAKE / 2 ? Math.max(-LAKE_DRY, lOwn[v]! - hOwn[v]!) : -LAKE_DRY;
      minH = Math.min(minH, dh);
      maxH = Math.max(maxH, dh);
      let a: number;
      let b: number;
      if (i % 2 === 0 && j % 2 === 0) a = b = v;
      else if (j % 2 === 0) [a, b] = [v - 1, v + 1];
      else if (i % 2 === 0) [a, b] = [v - V, v + V];
      else [a, b] = [v - V - 1, v + V + 1];
      // Parent heights (displayed) exist at even vertices only; a and b are always even.
      const ha = hPar[a]!;
      const hb = hPar[b]!;
      for (let c = 0; c < 3; c++) {
        parentBase[k + c] = (dirs[a * 3 + c]! + dirs[b * 3 + c]!) * 0.5 * R - o3[c]!;
        parentDisp[k + c] = (dirs[a * 3 + c]! * ha + dirs[b * 3 + c]! * hb) * 0.5;
      }
    }
  }

  // Slopes: height differences one sample apart (bilinear in the data tile, inside its
  // border) against tangents from the vertex grid's directions. Render detail is left
  // out; it is a few meters at most.
  const [dox, doy] = mapSample(t, sources.data.key, 0, 0);
  const dscale = 2 ** (sources.data.key.level - t.level);
  const raw = (sx: number, sy: number) =>
    bilinear(sources.data, dox + sx * dscale, doy + sy * dscale);
  const dataLake = lakeSampler(t, sources.data);
  const flat = (sx: number, sy: number) => displayHeight(raw(sx, sy), dataLake(sx, sy));
  const footprint = STEP * dscale;
  const tu = new Vec3d();
  const tv = new Vec3d();
  const tmp = new Vec3d();
  const dirOf = (v: number, out: Vec3d) =>
    out.set(dirs[v * 3]!, dirs[v * 3 + 1]!, dirs[v * 3 + 2]!);
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const v = j * V + i;
      const sx = i * STEP;
      const sy = j * STEP;
      const iu0 = i > 0 ? v - 1 : v;
      const iu1 = i < TILE_SEGMENTS ? v + 1 : v;
      const jv0 = j > 0 ? v - V : v;
      const jv1 = j < TILE_SEGMENTS ? v + V : v;
      dirOf(iu1, tu).sub(dirOf(iu0, tmp));
      dirOf(jv1, tv).sub(dirOf(jv0, tmp));
      // Meters of surface per sample step along u and v.
      const du = (tu.length() * R) / ((iu1 - iu0) * STEP);
      const dv = (tv.length() * R) / (((jv1 - jv0) / V) * STEP);
      tu.normalize();
      tv.normalize();
      const sU = (flat(sx + 1, sy) - flat(sx - 1, sy)) / (2 * du);
      const sV = (flat(sx, sy + 1) - flat(sx, sy - 1)) / (2 * dv);
      slope[v * 3] = tu.x * sU + tv.x * sV;
      slope[v * 3 + 1] = tu.y * sU + tv.y * sV;
      slope[v * 3 + 2] = tu.z * sU + tv.z * sV;
      // Coast distance from the raw height and its gradient (sample-scale differences).
      const rU = (raw(sx + 1, sy) - raw(sx - 1, sy)) / (2 * du);
      const rV = (raw(sx, sy + 1) - raw(sx, sy - 1)) / (2 * dv);
      const g = Math.hypot(rU, rV);
      shore[v] = Math.max(-SHORE_CLAMP, Math.min(SHORE_CLAMP, -raw(sx, sy) / Math.max(g, 1e-6)));
      const edge = i === 0 || j === 0 || i === TILE_SEGMENTS || j === TILE_SEGMENTS;
      const fx = dox + sx * dscale;
      const fy = doy + sy * dscale;
      const mat = materialAt(sources.data, fx, fy);
      const river = riverAt(sources.data, fx, fy, footprint);
      const rgb = colorFor(opts.mode, hOwn[v]!, mat, river, t.level, edge, opts.reliefScale);
      color[v * 3] = srgbToLinear(rgb[0]);
      color[v * 3 + 1] = srgbToLinear(rgb[1]);
      color[v * 3 + 2] = srgbToLinear(rgb[2]);
    }
  }

  // Skirts: copies of the edge vertices with the base lowered, deep enough for any
  // exaggeration the GUI allows.
  const skirt =
    Math.max(20, 4 * vertexSpacing(t.level, R) * 0.05 * SKIRT_EXAGGERATION) +
    (maxH - minH) * 0.02 * SKIRT_EXAGGERATION;
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < V; k++) {
      const src = edgeVertex(e, k);
      const dst = GRID_VERTICES + e * V + k;
      for (let c = 0; c < 3; c++) {
        const u = dirs[src * 3 + c]!;
        base[dst * 3 + c] = base[src * 3 + c]! - u * skirt;
        parentBase[dst * 3 + c] = parentBase[src * 3 + c]! - u * skirt;
      }
      for (const arr of [up, parentDisp, slope, color])
        arr.copyWithin(dst * 3, src * 3, src * 3 + 3);
      height[dst] = height[src]!;
      water[dst] = water[src]!;
      shore[dst] = shore[src]!;
    }
  }
  return {
    tile: t,
    origin,
    base,
    up,
    height,
    water,
    shore,
    parentBase,
    parentDisp,
    slope,
    color,
    minHeight: minH,
    maxHeight: maxH,
  };
}

/** The tile whose data a mesh of `t` reads: itself, or its ancestor at the finest baked level. */
export function dataTileFor(t: TileKey): TileKey {
  if (t.level <= MAX_BAKED_LEVEL) return t;
  const s = t.level - MAX_BAKED_LEVEL;
  return tileKey(t.face, MAX_BAKED_LEVEL, t.x >> s, t.y >> s);
}
