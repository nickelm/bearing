/**
 * Protected river channels (decision 161, rule 13): the tile kernel carves
 * every river to its water surface last (decision 146), and no edit may raise
 * the ground inside a channel afterwards. Inside a channel and its inner banks
 * the edited height is held at or below the carved height the edit started
 * from, so an embankment can never dam a river; over a short fade beyond the
 * banks the hold lets go.
 *
 * The CPU never re-runs the carve, which is not idempotent in its fade band:
 * the minimum against the already-carved height needs only the distance to
 * the river's segments.
 */
import type { TileKey } from '../../core/tiles';
import type { Vec3d } from '../../core/vec3d';
import { NO_SURFACE, RIVER_INDEX_LEVEL, RIVER_SEGMENT_FIELDS } from '../riverIndex';
import type { RiverSegments } from '../riverIndex';

export const CHANNEL_PROTECTION = {
  /** Inner bank protected beyond the water's edge: this share of the width, at least `minBank` m. */
  bankShare: 0.25,
  minBank: 10,
  /** Fade beyond the protected bank (m). */
  fade: 10,
  /** Margin for listing segments per tile (m): at least the widest half-width plus bank and fade. */
  listMargin: 600,
};

/** What protection needs of the river index (RiverIndex implements it). */
export interface ChannelSource {
  readonly segments: RiverSegments;
  forTile(k: TileKey, marginM: number, radius: number): number[];
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * How strongly the ground at `dir` is held to its carved height: 1 inside a
 * carved channel and its inner banks, 0 beyond the fade. `ids` are segments
 * of `segs` near `dir`.
 */
export function channelHold(
  segs: RiverSegments,
  ids: readonly number[],
  dir: Readonly<Vec3d>,
  radius: number,
): number {
  const F = segs.fields ?? RIVER_SEGMENT_FIELDS;
  const data = segs.data;
  const p = CHANNEL_PROTECTION;
  let hold = 0;
  for (const s of ids) {
    const o = s * F;
    // Rivers without a water surface are not carved, so there is nothing to protect.
    if (F > 8 && data[o + 8]! > NO_SURFACE * 0.5) continue;
    const ax = data[o]!;
    const ay = data[o + 1]!;
    const az = data[o + 2]!;
    const bx = data[o + 3]! - ax;
    const by = data[o + 4]! - ay;
    const bz = data[o + 5]! - az;
    const px = dir.x - ax;
    const py = dir.y - ay;
    const pz = dir.z - az;
    const len2 = bx * bx + by * by + bz * bz;
    const t = len2 > 1e-30 ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / len2)) : 0;
    const d = Math.hypot(px - t * bx, py - t * by, pz - t * bz) * radius;
    const w = data[o + 6]! + (data[o + 7]! - data[o + 6]!) * t;
    const zone = 0.5 * w + Math.max(p.minBank, p.bankShare * w);
    if (d >= zone + p.fade) continue;
    hold = Math.max(hold, 1 - smoothstep(zone, zone + p.fade, d));
    if (hold >= 1) break;
  }
  return hold;
}

/** Segments that can hold ground in tile `k`: none for tiles coarser than the river index. */
export function channelsForTile(src: ChannelSource, k: TileKey, radius: number): number[] {
  if (k.level < RIVER_INDEX_LEVEL) return [];
  return src.forTile(k, CHANNEL_PROTECTION.listMargin, radius);
}
