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
import { childTiles, tileKey, tileSampleDirection, TILE_TEXELS } from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import type { CubeFace } from '../../core/coords';
import { Vec3d } from '../../core/vec3d';

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

function tileBounds(t: TileKey, view: LodView): Bounds {
  const top = view.radius + view.maxHeight;
  const points: Vec3d[] = [];
  const center = new Vec3d();
  const d = new Vec3d();
  const capCenter = tileSampleDirection(t, TILE_TEXELS / 2, TILE_TEXELS / 2);
  let capCos = 1;
  for (const [sx, sy] of BOUND_SAMPLES) {
    tileSampleDirection(t, sx, sy, d);
    capCos = Math.min(capCos, d.dot(capCenter));
    points.push(d.clone().scale(top));
    points.push(d.clone().scale(view.radius));
  }
  for (const p of points) center.add(p);
  center.scale(1 / points.length);
  let r = 0;
  for (const p of points) r = Math.max(r, p.distanceTo(center));
  // Points only sample the tile; the surface bulges between them by at most the sagitta.
  const side = vertexSpacing(t.level, view.radius) * TILE_SEGMENTS;
  r += (side * side) / (8 * view.radius);
  // Corners and edge midpoints bound the cap of a tile up to its curved edges; pad slightly.
  const capAngle = Math.acos(Math.min(1, capCos)) * 1.02;
  return { center, radius: r, capCenter, capAngle };
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

function outsideFrustum(b: Bounds, view: LodView): boolean {
  const right = view.forward.clone().cross(view.up).normalize();
  const up = right.clone().cross(view.forward).normalize();
  const rel = b.center.clone().sub(view.eye);
  const z = rel.dot(view.forward);
  if (z < -b.radius) return true; // behind the camera
  const tanY = Math.tan(view.fovY / 2);
  const tanX = tanY * view.aspect;
  // Side planes through the eye; signed distance of the center, compared with the radius.
  const x = rel.dot(right);
  const y = rel.dot(up);
  const nx = 1 / Math.sqrt(1 + tanX * tanX);
  const ny = 1 / Math.sqrt(1 + tanY * tanY);
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
): LodSelection {
  const k = view.viewportHeight / (2 * Math.tan(view.fovY / 2));
  const out: LodSelection = { draw: [], wanted: [], visited: 0 };

  const sse = (t: TileKey, b: Bounds) => {
    const dist = Math.max(1, view.eye.distanceTo(b.center) - b.radius);
    return (geometricError(t.level, view, opts) * k) / dist;
  };
  const visible = (b: Bounds) =>
    !opts.cull ||
    !(
      capBeyondHorizon(view.eye, b.capCenter, b.capAngle, view.radius, view.maxHeight) ||
      outsideFrustum(b, view)
    );

  const visit = (t: TileKey, b: Bounds, parentSse: number) => {
    out.visited++;
    const e = sse(t, b);
    const morph =
      t.level === 0
        ? 1
        : Math.min(1, Math.max(0, (parentSse / opts.sseThreshold - 1) / (opts.morphRange - 1)));
    if (e > opts.sseThreshold && t.level < opts.maxLevel) {
      const kids = childTiles(t)
        .map((c) => ({ c, b: tileBounds(c, view) }))
        .filter((x) => visible(x.b));
      const missing = kids.filter((x) => !ready(x.c));
      if (missing.length === 0) {
        for (const x of kids) visit(x.c, x.b, e);
        return;
      }
      for (const x of missing) out.wanted.push({ tile: x.c, priority: e });
    }
    out.draw.push({ tile: t, morph });
  };

  for (let f = 0; f < 6; f++) {
    const root = tileKey(f as CubeFace, 0, 0, 0);
    const b = tileBounds(root, view);
    if (!visible(b)) continue;
    if (!ready(root)) {
      out.wanted.push({ tile: root, priority: Infinity });
      continue;
    }
    visit(root, b, Infinity);
  }
  return out;
}
