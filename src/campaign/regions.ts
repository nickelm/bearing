/**
 * Tiles under the cast's regions (decision 64). Level-7 tiles (about 48 m
 * samples) synthesize on demand anywhere, so the design's regional bake
 * reduces to knowing which tiles cover ground-combat regions; milestone 8
 * prefetches them for line of sight inside the promotion bubble.
 */
import { tileForDirection, tileKeyString, texelSizeAtLevel, TILE_TEXELS } from '../core/tiles';
import { Vec3d } from '../core/vec3d';
import type { Region, RegionKind } from './cast';

/** Ground-combat regions' tile level (decision 64). */
export const GROUND_TILE_LEVEL = 7;

/**
 * Keys (tileKeyString) of the tiles at `level` that intersect any region of
 * the given kinds, sorted. Regions are sampled at a quarter tile, so no
 * covered tile is missed.
 */
export function regionTiles(
  regions: readonly Region[],
  radius: number,
  level = GROUND_TILE_LEVEL,
  kinds: readonly RegionKind[] = ['ground'],
): string[] {
  const keys = new Set<string>();
  const step = (texelSizeAtLevel(level, radius) * TILE_TEXELS) / 4;
  const n = new Vec3d();
  const e1 = new Vec3d();
  const e2 = new Vec3d();
  const d = new Vec3d();
  for (const r of regions) {
    if (!kinds.includes(r.kind)) continue;
    n.set(...r.point);
    e1.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0)
      .cross(n)
      .normalize();
    e2.copy(n).cross(e1);
    const k = Math.ceil(r.radius / step);
    for (let i = -k; i <= k; i++) {
      for (let j = -k; j <= k; j++) {
        const x = i * step;
        const y = j * step;
        if (x * x + y * y > (r.radius + step) ** 2) continue;
        d.copy(n)
          .addScaled(e1, x / radius)
          .addScaled(e2, y / radius)
          .normalize();
        keys.add(tileKeyString(tileForDirection(d, level)));
      }
    }
  }
  return [...keys].sort();
}
