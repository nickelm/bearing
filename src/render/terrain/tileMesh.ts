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
 * - The sea is drawn flat at sea level; land is exaggerated.
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
import { MAX_BAKED_LEVEL } from '../../worldgen/gpu/tileSynth';
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

export interface TileMeshData {
  tile: TileKey;
  /** Tile center on the sphere (m, planet-centered, float64). */
  origin: Vec3d;
  position: Float32Array;
  positionParent: Float32Array;
  normal: Float32Array;
  /** Linear RGB. */
  color: Float32Array;
  /** Displayed height range (m, exaggerated). */
  minHeight: number;
  maxHeight: number;
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
  exaggeration: number;
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

function colorFor(
  mode: TileViewMode,
  h: number,
  material: number,
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
    const river = ((material >> 8) & 0xff) / 255;
    const lake = (material >> 16) & 1;
    if (h <= 0) {
      const depth = Math.min(1, -h / (4000 * reliefScale));
      c = [0.18 - 0.12 * depth, 0.42 - 0.25 * depth, 0.62 - 0.22 * depth];
    } else if (lake) {
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

/** Builds the vertex data of tile `t`. */
export function buildTileMesh(t: TileKey, sources: MeshSources, opts: MeshOptions): TileMeshData {
  const R = opts.radius;
  const ex = opts.exaggeration;
  const own = surfaceSampler(t, t.level, sources.data, opts);
  const parentKey = parentTile(t);
  const parentSurface =
    parentKey === null
      ? own
      : t.level - 1 <= MAX_BAKED_LEVEL && t.level <= MAX_BAKED_LEVEL
        ? surfaceSampler(t, t.level - 1, sources.parentData ?? sources.data, opts)
        : surfaceSampler(t, t.level - 1, sources.data, opts);

  const fu = (s: number) => (t.x * TILE_TEXELS + s) / (TILE_TEXELS * (1 << t.level));
  const fv = (s: number) => (t.y * TILE_TEXELS + s) / (TILE_TEXELS * (1 << t.level));
  const dirAt = (sx: number, sy: number, out: Vec3d) =>
    cubeFaceUvToDirection(t.face, fu(sx), fv(sy), out);
  const display = (h: number) => Math.max(0, h) * ex;

  const origin = dirAt(TILE_TEXELS / 2, TILE_TEXELS / 2, new Vec3d()).scale(R);
  const position = new Float32Array(TILE_VERTEX_COUNT * 3);
  const positionParent = new Float32Array(TILE_VERTEX_COUNT * 3);
  const normal = new Float32Array(TILE_VERTEX_COUNT * 3);
  const color = new Float32Array(TILE_VERTEX_COUNT * 3);

  // Grid: directions, own heights and parent heights (float64).
  const dirs = new Float64Array(GRID_VERTICES * 3);
  const hOwn = new Float64Array(GRID_VERTICES);
  const hPar = new Float64Array(GRID_VERTICES);
  const d = new Vec3d();
  const p = new Vec3d();
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const v = j * V + i;
      dirAt(i * STEP, j * STEP, d);
      dirs[v * 3] = d.x;
      dirs[v * 3 + 1] = d.y;
      dirs[v * 3 + 2] = d.z;
      hOwn[v] = own(i * STEP, j * STEP, d);
      if (i % 2 === 0 && j % 2 === 0) hPar[v] = parentSurface(i * STEP, j * STEP, d);
    }
  }
  // Odd vertices: midpoint of the parent's edge or diagonal (the shared triangle split).
  const pos = (v: number, h: number, out: Vec3d) =>
    out.set(dirs[v * 3]!, dirs[v * 3 + 1]!, dirs[v * 3 + 2]!).scale(R + display(h));
  const pa = new Vec3d();
  const pb = new Vec3d();
  let minH = Infinity;
  let maxH = -Infinity;
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const v = j * V + i;
      pos(v, hOwn[v]!, p).sub(origin);
      position.set([p.x, p.y, p.z], v * 3);
      const dh = display(hOwn[v]!);
      minH = Math.min(minH, dh);
      maxH = Math.max(maxH, dh);
      let a: number;
      let b: number;
      if (i % 2 === 0 && j % 2 === 0) a = b = v;
      else if (j % 2 === 0) [a, b] = [v - 1, v + 1];
      else if (i % 2 === 0) [a, b] = [v - V, v + V];
      else [a, b] = [v - V - 1, v + V + 1];
      // Parent heights exist at even vertices only; a and b are always even.
      pos(a, hPar[a]!, pa);
      pos(b, hPar[b]!, pb);
      pa.add(pb).scale(0.5).sub(origin);
      positionParent.set([pa.x, pa.y, pa.z], v * 3);
    }
  }

  // Normals: height slopes one sample apart (bilinear in the data tile, inside its
  // border) against tangents from the vertex grid's directions. Render detail is
  // left out of normals; it is a few meters at most.
  const [dox, doy] = mapSample(t, sources.data.key, 0, 0);
  const dscale = 2 ** (sources.data.key.level - t.level);
  const base = (sx: number, sy: number) =>
    display(bilinear(sources.data, dox + sx * dscale, doy + sy * dscale));
  // Physical length of one sample step, from the face-coordinate warp (nearly uniform).
  const tu = new Vec3d();
  const tv = new Vec3d();
  const up = new Vec3d();
  const nrm = new Vec3d();
  const dirOf = (v: number, out: Vec3d) =>
    out.set(dirs[v * 3]!, dirs[v * 3 + 1]!, dirs[v * 3 + 2]!);
  const tmp = new Vec3d();
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const v = j * V + i;
      const sx = i * STEP;
      const sy = j * STEP;
      dirOf(v, up);
      // Tangent along u and v from neighboring grid directions (one-sided at the edges).
      const iu0 = i > 0 ? v - 1 : v;
      const iu1 = i < TILE_SEGMENTS ? v + 1 : v;
      const jv0 = j > 0 ? v - V : v;
      const jv1 = j < TILE_SEGMENTS ? v + V : v;
      dirOf(iu1, tu).sub(dirOf(iu0, tmp));
      dirOf(jv1, tv).sub(dirOf(jv0, tmp));
      // Meters of surface per sample step along u and v.
      const du = (tu.length() * R) / (((iu1 - iu0) / 1) * STEP);
      const dv = (tv.length() * R) / (((jv1 - jv0) / V) * STEP);
      tu.normalize();
      tv.normalize();
      const sU = (base(sx + 1, sy) - base(sx - 1, sy)) / (2 * du);
      const sV = (base(sx, sy + 1) - base(sx, sy - 1)) / (2 * dv);
      nrm.copy(up).addScaled(tu, -sU).addScaled(tv, -sV).normalize();
      normal[v * 3] = nrm.x;
      normal[v * 3 + 1] = nrm.y;
      normal[v * 3 + 2] = nrm.z;
      const edge = i === 0 || j === 0 || i === TILE_SEGMENTS || j === TILE_SEGMENTS;
      const mat = materialAt(sources.data, dox + sx * dscale, doy + sy * dscale);
      const rgb = colorFor(opts.mode, hOwn[v]!, mat, t.level, edge, opts.reliefScale);
      color[v * 3] = srgbToLinear(rgb[0]);
      color[v * 3 + 1] = srgbToLinear(rgb[1]);
      color[v * 3 + 2] = srgbToLinear(rgb[2]);
    }
  }

  // Skirts: copies of the edge vertices, lowered.
  const skirt = Math.max(20, 4 * vertexSpacing(t.level, R) * 0.05 * ex) + (maxH - minH) * 0.02;
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < V; k++) {
      const src = edgeVertex(e, k);
      const dst = GRID_VERTICES + e * V + k;
      const ux = dirs[src * 3]!;
      const uy = dirs[src * 3 + 1]!;
      const uz = dirs[src * 3 + 2]!;
      for (const [arr, base] of [
        [position, position],
        [positionParent, positionParent],
      ] as const) {
        arr[dst * 3] = base[src * 3]! - ux * skirt;
        arr[dst * 3 + 1] = base[src * 3 + 1]! - uy * skirt;
        arr[dst * 3 + 2] = base[src * 3 + 2]! - uz * skirt;
      }
      normal.copyWithin(dst * 3, src * 3, src * 3 + 3);
      color.copyWithin(dst * 3, src * 3, src * 3 + 3);
    }
  }
  return {
    tile: t,
    origin,
    position,
    positionParent,
    normal,
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
