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
 * frustum are dropped with their subtrees. A tile is beyond the horizon when
 * its nearest point to the camera's nadir lies farther than the camera's
 * horizon plus the distance at which the tile's tallest terrain still shows
 * above it (decision 116). The nearest point is exact: tile edges are
 * great-circle arcs (constant u or v on a cube face), so the distance to a
 * tile is the distance to the nearest of four arcs, or 0 inside it. A cheaper
 * bounding-cap test rejects most tiles first. (Testing a few sample points is
 * unsound: a whole cube face can have all its samples beyond a 2 km camera's
 * horizon while the camera stands on it. The cap alone is loose: the circle
 * around a square tile reaches past its sides, so it kept tiles whose nearest
 * point lay 30% beyond the horizon.)
 *
 * The horizon range, `horizonRange(view)`, bounds every drawn tile: √(2Rh)
 * for the camera plus √(2RH) for the tallest displayed terrain H, as ground
 * distance. At 20 km over flat land it is about 200 km. Tiles a split needs
 * ready reach a margin farther, `selectionRange(view)`.
 *
 * Geomorphing: a drawn tile's morph factor rises from 0 to 1 as its parent's
 * screen-space error goes from the threshold to `morphRange` × threshold. At
 * 0 the tile looks exactly like its parent, so splits never pop.
 */
import {
  childTiles,
  tileKey,
  tileSampleDirection,
  tileUvBounds,
  TILE_TEXELS,
} from '../../../core/tiles';
import { cubeFaceUvToDirection } from '../../../core/coords';
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
  /** The tile's spherical quadrilateral, for the exact distance test. */
  quad: TileQuad;
}

/**
 * A tile on the unit sphere: its corners counterclockwise seen from outside,
 * and the unit normals of the great circles through its edges, which point
 * into the tile.
 */
export interface TileQuad {
  corners: Vec3d[];
  normals: Vec3d[];
}

/** The spherical quadrilateral a tile covers. */
export function tileQuad(t: TileKey): TileQuad {
  const [u0, v0, u1, v1] = tileUvBounds(t);
  // uAxis × vAxis = face normal, so this order runs counterclockwise from outside.
  const corners = [
    cubeFaceUvToDirection(t.face, u0, v0),
    cubeFaceUvToDirection(t.face, u1, v0),
    cubeFaceUvToDirection(t.face, u1, v1),
    cubeFaceUvToDirection(t.face, u0, v1),
  ];
  const normals = corners.map((c, i) =>
    c
      .clone()
      .cross(corners[(i + 1) % 4]!)
      .normalize(),
  );
  return { corners, normals };
}

const arcScratch = new Vec3d();
const crossScratch = new Vec3d();

/** Angle between two unit vectors (radians), accurate near 0 and π. */
function angleBetween(a: Readonly<Vec3d>, b: Readonly<Vec3d>): number {
  return Math.atan2(crossScratch.copy(a).cross(b).length(), a.dot(b));
}

/**
 * Angular distance (radians) from a unit direction to the nearest point of a
 * tile: 0 inside it, else the distance to the nearest edge arc.
 */
export function tileAngularDistance(q: TileQuad, d: Readonly<Vec3d>): number {
  const { corners, normals } = q;
  let inside = true;
  for (const n of normals) {
    if (d.dot(n) < 0) {
      inside = false;
      break;
    }
  }
  if (inside) return 0;
  let best = Math.PI;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const n = normals[i]!;
    // The foot of d on the edge's great circle lies on the arc if it is past a
    // toward b and short of b: both sides measured about the normal.
    const s = d.dot(n);
    const foot = arcScratch.copy(d).addScaled(n, -s);
    const onArc =
      foot.lengthSq() > 1e-24 &&
      crossScratch.copy(a).cross(foot).dot(n) >= 0 &&
      crossScratch.copy(foot).cross(b).dot(n) >= 0;
    const dist = onArc
      ? Math.atan2(Math.abs(s), foot.length())
      : Math.min(angleBetween(d, a), angleBetween(d, b));
    best = Math.min(best, dist);
  }
  return best;
}

/** Angle from the camera's nadir to its horizon (0 at or below the sphere). */
function eyeHorizonAngle(eye: Readonly<Vec3d>, radius: number): number {
  const e = eye.length();
  return e > radius ? Math.acos(radius / e) : 0;
}

/** Angle past the horizon at which terrain `height` tall still shows above it. */
function peakHorizonAngle(height: number, radius: number): number {
  return Math.acos(radius / (radius + Math.max(0, height)));
}

/**
 * Ground distance (m) from the camera's nadir beyond which no terrain can be
 * seen: the camera's horizon plus that of the tallest displayed terrain. No
 * tile the selection draws lies wholly beyond it (decision 116).
 */
export function horizonRange(view: LodView): number {
  return (
    view.radius *
    (eyeHorizonAngle(view.eye, view.radius) + peakHorizonAngle(view.maxHeight, view.radius))
  );
}

/** Margin past the horizon range: a tenth of it, at least 1 km. */
export function horizonMargin(view: LodView): number {
  return Math.max(1000, 0.1 * horizonRange(view));
}

/**
 * Ground distance (m) from the camera's nadir that bounds every tile the
 * selection draws, keeps or asks for: the horizon range plus its margin. Tiles
 * in the margin are made ready but not drawn, so a moving camera finds them
 * built when they rise over the horizon. Caches and prefetch need nothing
 * farther (decision 116).
 */
export function selectionRange(view: LodView): number {
  return horizonRange(view) + horizonMargin(view);
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
  return { center, radius: r, capCenter, capAngle, top: hi, quad: tileQuad(t) };
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
  const eyeLength = view.eye.length();
  const nadir = view.eye.clone().scale(1 / Math.max(1, eyeLength));
  const eyeAngle = eyeHorizonAngle(view.eye, view.radius);
  const marginAngle = horizonMargin(view) / view.radius;
  // A tile wholly beyond the horizon of its own tallest terrain (capped at the
  // planet's tallest, so that nothing selected lies beyond horizonRange(view)),
  // plus `extra` radians.
  const beyondHorizon = (b: Bounds, extra: number) => {
    if (eyeLength <= view.radius) return false;
    const top = Math.min(b.top, view.maxHeight);
    const horizon = eyeAngle + peakHorizonAngle(top, view.radius) + extra;
    // The bounding cap is cheap and rejects most tiles; the exact distance settles the rest.
    if (capBeyondHorizon(view.eye, b.capCenter, b.capAngle - extra, view.radius, top)) return true;
    return tileAngularDistance(b.quad, nadir) > horizon;
  };
  const visible = (b: Bounds) =>
    !opts.cull || !(beyondHorizon(b, 0) || outsideFrustum(b, view, frustum));

  const visit = (t: TileKey, b: Bounds, parentSse: number) => {
    out.visited++;
    const e = sse(t, b);
    const morph =
      t.level === 0
        ? 1
        : Math.min(1, Math.max(0, (parentSse / opts.sseThreshold - 1) / (opts.morphRange - 1)));
    if (e > opts.sseThreshold && t.level < opts.maxLevel) {
      // A tile splits only when its children are ready, seen or not: a child
      // outside the view would otherwise have no mesh when a turn brings it in, and
      // its parent, perhaps a level-1 tile, would stand in for the whole subtree for
      // a frame (decision 113). Children past the horizon and its margin are left
      // out: no turn can show them, and the margin has them ready before the
      // camera moves close enough to see them (decision 116).
      const kids = childTiles(t)
        .map((c) => ({ c, b: tileBounds(c) }))
        .filter((x) => !opts.cull || !beyondHorizon(x.b, marginAngle));
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
