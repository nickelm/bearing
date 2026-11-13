/**
 * Bounding spheres for tiles of instanced objects (trees, buildings), so a
 * layer can skip tiles outside the camera's frustum. The layers draw every
 * tile within their range, and a tree tile alone can hold 30,000 trees
 * (decision 131).
 */
import { Vec3d } from '../../core/vec3d';

/** Where a tile's instances lie, from instance data that starts with base xyz (relative to the tile origin). */
export interface InstanceExtent {
  /** Largest distance of a base point from the tile origin (m). */
  reach: number;
  /** Lowest and highest raw ground height of an instance (m). */
  lo: number;
  hi: number;
}

/**
 * Extends `out` by instances of `stride` floats whose ground height (m) is at
 * `heightIndex`.
 */
export function instanceExtent(
  arrays: readonly Float32Array[],
  stride: number,
  heightIndex = 6,
  out: InstanceExtent = { reach: 0, lo: Infinity, hi: -Infinity },
): InstanceExtent {
  for (const a of arrays) {
    for (let o = 0; o + stride <= a.length; o += stride) {
      out.reach = Math.max(out.reach, Math.hypot(a[o]!, a[o + 1]!, a[o + 2]!));
      out.lo = Math.min(out.lo, a[o + heightIndex]!);
      out.hi = Math.max(out.hi, a[o + heightIndex]!);
    }
  }
  return out;
}

/**
 * The bounding sphere of a tile's instances, drawn at height exaggeration
 * `exaggeration`, with `tall` meters for the objects' own size and placement
 * jitter. `origin` is the tile origin (planet-centered, m).
 */
export function instanceSphere(
  origin: Readonly<Vec3d>,
  e: InstanceExtent,
  exaggeration: number,
  tall: number,
  center = new Vec3d(),
): number {
  if (e.lo > e.hi) {
    center.copy(origin);
    return 0;
  }
  const mid = ((e.lo + e.hi) / 2) * exaggeration;
  center.copy(origin).addScaled(origin.clone().normalize(), mid);
  return e.reach + ((e.hi - e.lo) / 2) * exaggeration + tall;
}
