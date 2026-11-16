/**
 * The ground the alignment stage routes over (decision 184): level-6 tiles of
 * the terrain's own synthesizer (96 m samples on the 1,000 km planet), which
 * resolve the valleys and spurs switchbacks climb; the global grid's 1.5 km
 * cells do not (decision 181).
 *
 * `taskTiles` lists the tiles under every piece's search band; the sampler
 * reads heights bilinearly from a tile's height channel, its border included.
 */
import { directionToCubeFace } from '../../core/coords';
import {
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
  tileForDirection,
  tileKeyString,
} from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { Vec3d } from '../../core/vec3d';
import type { LinkTask } from './link';
import { bandFor } from './link';
import { gnomonic } from './pieces';

export const ALIGN_LEVEL = 6;

/** The level-ALIGN_LEVEL tiles under the search bands of `task`'s pieces. */
export function taskTiles(task: LinkTask, radius: number): TileKey[] {
  const keys = new Map<string, TileKey>();
  const a = new Vec3d();
  const b = new Vec3d();
  const at = new Vec3d();
  // Samples well under a tile's width (24 km) apart, so none is skipped.
  const STEP = 2000;
  for (let i = 0; i + 3 < task.anchors.length; i += 3) {
    a.set(task.anchors[i]!, task.anchors[i + 1]!, task.anchors[i + 2]!);
    b.set(task.anchors[i + 3]!, task.anchors[i + 4]!, task.anchors[i + 5]!);
    const chord = a.distanceTo(b) * radius;
    const band = bandFor(chord);
    const frame = gnomonic(new Vec3d(a.x + b.x, a.y + b.y, a.z + b.z).normalize(), radius);
    const pa = frame.toPlane(a);
    const pb = frame.toPlane(b);
    const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const ux = L > 0 ? (pb[0] - pa[0]) / L : 1;
    const uy = L > 0 ? (pb[1] - pa[1]) / L : 0;
    const nAlong = Math.ceil((L + 2 * band) / STEP);
    const nAcross = Math.ceil((2 * band) / STEP);
    for (let p = 0; p <= nAlong; p++) {
      const t = -band + ((L + 2 * band) * p) / nAlong;
      for (let q = 0; q <= nAcross; q++) {
        const c = -band + (2 * band * q) / nAcross;
        frame.toSphere(pa[0] + ux * t - uy * c, pa[1] + uy * t + ux * c, at);
        const k = tileForDirection(at, ALIGN_LEVEL);
        keys.set(tileKeyString(k), k);
      }
    }
  }
  return [...keys.values()];
}

/**
 * Ground height (m) at a unit direction from level-`level` tile heights by key
 * string; `missing` counts lookups outside the tiles given (they read 0).
 */
export function tileHeightSampler(
  tiles: ReadonlyMap<string, Float32Array>,
  level = ALIGN_LEVEL,
): { height: (d: Readonly<Vec3d>) => number; missing: () => number } {
  let missing = 0;
  const size = TILE_TEXELS * (1 << level);
  return {
    missing: () => missing,
    height(d) {
      const key = tileForDirection(d, level);
      const h = tiles.get(tileKeyString(key));
      if (!h) {
        missing++;
        return 0;
      }
      const uv = directionToCubeFace(d);
      const fx =
        Math.min(TILE_TEXELS + 1, Math.max(-1, uv.u * size - key.x * TILE_TEXELS)) + TILE_BORDER;
      const fy =
        Math.min(TILE_TEXELS + 1, Math.max(-1, uv.v * size - key.y * TILE_TEXELS)) + TILE_BORDER;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const i = y0 * TILE_STRIDE + x0;
      return (
        (h[i]! * (1 - tx) + h[i + 1]! * tx) * (1 - ty) +
        (h[i + TILE_STRIDE]! * (1 - tx) + h[i + TILE_STRIDE + 1]! * tx) * ty
      );
    },
  };
}
