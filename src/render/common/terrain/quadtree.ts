/**
 * Terrain LOD selection: a quadtree per cube face on the tile keys
 * (decision 13), refined by screen-space error. Pure TypeScript, float64.
 *
 * A tile splits when its geometric error, projected to the screen, exceeds
 * `sseThreshold` pixels and its visible children are ready to draw.
 * Otherwise it draws itself and requests the children, so the view never
 * has holes: a coarser ancestor stands in until detail arrives.
 *
 * Geometric error of a tile mesh (TILE_SEGMENTS segments per edge) is the
 * larger of the relief between vertices and the sagitta of the sphere
 * over one segment.
 *
 * Culling: tiles entirely beyond the horizon and tiles outside the view
 * frustum are dropped with their subtrees. The horizon test is conservative:
 * a tile's bounding cap (center direction, angular radius) must lie wholly
 * farther from the camera's nadir than the horizon of the tallest terrain.
 * (Testing a few sample points is unsound: a whole cube face can have all its
 * samples beyond a 2 km camera's horizon while the camera stands on it.)
 *
 * Geomorphing: a drawn tile's morph factor rises from 0 to 1 as its parent's
 * screen-space error goes from the threshold to `morphRange` × threshold. At
 * 0 the tile looks exactly like its parent, so splits never pop.
 */
import { childTiles, tileKey, tileSampleDirection, TILE_TEXELS } from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import type { CubeFace } from '../../../core/coords';
import { Vec3d } from '../../../core/vec3d';

/** Mesh segments per tile edge (vertices every 4 samples). */
export const TILE_SEGMENTS = 64;

export interface LodView {
  /** Camera position, planet-centered (m). */
  eye: Readonly<Vec3d>;
  /** Unit view direction and up vector. */
  forward: Readonly<Vec3d>;
  up: Readonly<Vec3d>;
  /** Vertical field of view (radians) and width / height. */
  fovY: number;
  aspect: number;
  viewportHeight: number;
  radius: number;
  /** Height exaggeration applied to the displayed terrain. */
  exaggeration: number;
  /** Highest displayed terrain above the sphere (m, exaggerated). */
  maxHeight: number;
}

export interface LodOptions {
  sseThreshold: number;
  maxLevel: number;
  /** Relief per meter of vertex spacing, before exaggeration (typical steep slope). */
  reliefPerSpacing: number;
  morphRange: number;
  /** Turn culling off (tests). */
  cull: boolean;
}

export const DEFAULT_LOD: LodOptions = {
  sseThreshold: 2,
  maxLevel: 10,
  reliefPerSpacing: 0.05,
  morphRange: 2,
  cull: true,
};

export interface DrawnTile {
  tile: TileKey;
  /** 0 = looks like its parent, 1 = full detail. */
  morph: number;
}

export interface LodSelection {
  draw: DrawnTile[];
  /** Tiles to make ready, with priorities (screen-space error, higher first). */
  wanted: { tile: TileKey; priority: number }[];
  /**
   * Ready tiles not drawn this frame whose meshes must stay cached: the split
   * tiles above the drawn ones, and their children outside the view, which
   * the next turn of the camera may bring in.
   */
  keep: TileKey[];
  /** Tiles visited, for diagnostics. */
  visited: number;
}

/** Vertex spacing of a tile mesh at a level (m). */
export function vertexSpacing(level: number, radius: number): number {
  return ((Math.PI / 2) * radius) / ((1 << level) * TILE_SEGMENTS);
}

/** Geometric error of a tile mesh at a level (m, display units). */
export function geometricError(level: number, view: LodView, opts: LodOptions): number {
  const s = vertexSpacing(level, view.radius);
  return Math.max(opts.reliefPerSpacing * s * view.exaggeration, (s * s) / (8 * view.radius));
}

interface Bounds {
  center: Vec3d;
  radius: number;
  /** Unit direction of the tile center and angular radius of its bounding cap. */
  capCenter: Vec3d;
  capAngle: number;
  /** Highest displayed point (m above the sphere): the horizon test's peak height. */
  top: number;
}

const BOUND_SAMPLES: readonly [number, number][] = [
  [0, 0],
  [TILE_TEXELS, 0],
  [0, TILE_TEXELS],
  [TILE_TEXELS, TILE_TEXELS],
  [TILE_TEXELS / 2, 0],
  [TILE_TEXELS / 2, TILE_TEXELS],
  [0, TILE_TEXELS / 2],
  [TILE_TEXELS, TILE_TEXELS / 2],
  [TILE_TEXELS / 2, TILE_TEXELS / 2],
];

/**
 * Displayed height range of a tile (m above the sphere, exaggerated), once
 * known from its mesh. Without it, a tile's bounds reach from the sphere to
 * the tallest terrain on the planet.
 */
export type HeightRange = (t: TileKey) => readonly [number, number] | null;

interface CachedBounds {
  bounds: Bounds;
  lo: number;
  hi: number;
}

/**
 * Bounds of every tile visited, kept across frames (decision 69): they
 * depend only on the tile, the planet radius and the height range, and
 * computing them (nine trigonometric samples and their allocations per tile)
 * was a large share of the selection's cost.
 */
class BoundsCache {
  private readonly map = new Map<number, CachedBounds>();
  private radius = Number.NaN;

  get(t: TileKey, radius: number, lo: number, hi: number): Bounds {
    if (radius !== this.radius) {
      this.map.clear();
      this.radius = radius;
    }
    // Unique for levels up to 20: (level·6 + face) · 2⁴⁰ + y · 2²⁰ + x < 2⁵³.
    const key = (t.level * 6 + t.face) * 2 ** 40 + t.y * 2 ** 20 + t.x;
    const c = this.map.get(key);
    if (c && c.lo === lo && c.hi === hi) return c.bounds;
    if (!c && this.map.size > 200_000) this.map.clear();
    const bounds = computeTileBounds(t, radius, lo, hi);
    this.map.set(key, { bounds, lo, hi });
    return bounds;
  }
}

const boundsCache = new BoundsCache();

function computeTileBounds(t: TileKey, radius: number, lo: number, hi: number): Bounds {
  const top = radius + hi;
  const bottom = radius + lo;
  const points: Vec3d[] = [];
  const center = new Vec3d();
  const d = new Vec3d();
  const capCenter = tileSampleDirection(t, TILE_TEXELS / 2, TILE_TEXELS / 2);
  let capCos = 1;
  for (const [sx, sy] of BOUND_SAMPLES) {
    tileSampleDirection(t, sx, sy, d);
    capCos = Math.min(capCos, d.dot(capCenter));
    points.push(d.clone().scale(top));
    points.push(d.clone().scale(bottom));
  }
  for (const p of points) center.add(p);
  center.scale(1 / points.length);
  let r = 0;
  for (const p of points) r = Math.max(r, p.distanceTo(center));
  // Points only sample the tile; the surface bulges between them by at most the sagitta.
  const side = vertexSpacing(t.level, radius) * TILE_SEGMENTS;
  r += (side * side) / (8 * radius);
  // Corners and edge midpoints bound the cap of a tile up to its curved edges; pad slightly.
  const capAngle = Math.acos(Math.min(1, capCos)) * 1.02;
  return { center, radius: r, capCenter, capAngle, top: hi };
}

/**
 * True if a bounding cap lies entirely beyond the horizon: no point of it,
 * up to `maxHeight` tall, can be seen from `eye` over a sphere of `radius`.
 */
export function capBeyondHorizon(
  eye: Readonly<Vec3d>,
  capCenter: Readonly<Vec3d>,
  capAngle: number,
  radius: number,
  maxHeight: number,
): boolean {
  const e = eye.length();
  if (e <= radius) return false;
  // Horizon of the camera plus the distance at which a peak of maxHeight still shows above it.
  const horizon = Math.acos(radius / e) + Math.acos(radius / (radius + Math.max(0, maxHeight)));
  const nadirCos = capCenter.dot(eye) / e;
  const angle = Math.acos(Math.min(1, Math.max(-1, nadirCos)));
  return angle - capAngle > horizon;
}

/** The camera's frustum planes, computed once per selection. */
interface Frustum {
  right: Vec3d;
  up: Vec3d;
  tanX: number;
  tanY: number;
  nx: number;
  ny: number;
}

function frustumOf(view: LodView): Frustum {
  const right = view.forward.clone().cross(view.up).normalize();
  const up = right.clone().cross(view.forward).normalize();
  const tanY = Math.tan(view.fovY / 2);
  const tanX = tanY * view.aspect;
  return {
    right,
    up,
    tanX,
    tanY,
    nx: 1 / Math.sqrt(1 + tanX * tanX),
    ny: 1 / Math.sqrt(1 + tanY * tanY),
  };
}

const relScratch = new Vec3d();

function outsideFrustum(b: Bounds, view: LodView, f: Frustum = frustumOf(view)): boolean {
  const { right, up, tanX, tanY, nx, ny } = f;
  const rel = relScratch.copy(b.center).sub(view.eye);
  const z = rel.dot(view.forward);
  if (z < -b.radius) return true; // behind the camera
  // Side planes through the eye; signed distance of the center, compared with the radius.
  const x = rel.dot(right);
  const y = rel.dot(up);
  if ((x - z * tanX) * nx > b.radius) return true;
  if ((-x - z * tanX) * nx > b.radius) return true;
  if ((y - z * tanY) * ny > b.radius) return true;
  if ((-y - z * tanY) * ny > b.radius) return true;
  return false;
}

/**
 * Selects tiles to draw. `ready(tile)` says whether a tile can be drawn now
 * (its mesh exists or can be built immediately).
 */
export function selectTiles(
  view: LodView,
  ready: (t: TileKey) => boolean,
  opts: LodOptions = DEFAULT_LOD,
  heightRange: HeightRange = () => null,
): LodSelection {
  // A tile's own height range when known (its mesh exists), else sphere to tallest peak.
  // With the planet-wide range, a camera below the tallest exaggerated peak sits inside
  // every nearby tile's bounds, and they all split to the finest level (decision 69).
  const tileBounds = (t: TileKey): Bounds => {
    const range = heightRange(t);
    return range
      ? boundsCache.get(t, view.radius, range[0], range[1])
      : boundsCache.get(t, view.radius, 0, view.maxHeight);
  };
  const k = view.viewportHeight / (2 * Math.tan(view.fovY / 2));
  const out: LodSelection = { draw: [], wanted: [], keep: [], visited: 0 };

  const sse = (t: TileKey, b: Bounds) => {
    const dist = Math.max(1, view.eye.distanceTo(b.center) - b.radius);
    return (geometricError(t.level, view, opts) * k) / dist;
  };
  const frustum = frustumOf(view);
  const visible = (b: Bounds) =>
    !opts.cull ||
    !(
      capBeyondHorizon(view.eye, b.capCenter, b.capAngle, view.radius, b.top) ||
      outsideFrustum(b, view, frustum)
    );

  const visit = (t: TileKey, b: Bounds, parentSse: number) => {
    out.visited++;
    const e = sse(t, b);
    const morph =
      t.level === 0
        ? 1
        : Math.min(1, Math.max(0, (parentSse / opts.sseThreshold - 1) / (opts.morphRange - 1)));
    if (e > opts.sseThreshold && t.level < opts.maxLevel) {
      // A tile splits only when all four children are ready, seen or not: a child
      // outside the view would otherwise have no mesh when a turn brings it in, and
      // its parent, perhaps a level-1 tile, would stand in for the whole subtree for
      // a frame (decision 113).
      const kids = childTiles(t).map((c) => ({ c, b: tileBounds(c) }));
      const missing = kids.filter((x) => !ready(x.c));
      if (missing.length === 0) {
        out.keep.push(t);
        for (const x of kids) {
          if (visible(x.b)) visit(x.c, x.b, e);
          else out.keep.push(x.c);
        }
        return;
      }
      for (const x of missing) out.wanted.push({ tile: x.c, priority: e });
    }
    out.draw.push({ tile: t, morph });
  };

  for (let f = 0; f < 6; f++) {
    const root = tileKey(f as CubeFace, 0, 0, 0);
    const b = tileBounds(root);
    if (!visible(b)) continue;
    if (!ready(root)) {
      out.wanted.push({ tile: root, priority: Infinity });
      continue;
    }
    visit(root, b, Infinity);
  }
  return out;
}
