/**
 * River segment tables for drawing rivers from vector data (decision 46).
 *
 * The fragment shader computes the exact distance to river centerlines, so
 * banks stay crisp at any zoom. Each mesh loops over a short list:
 *
 * - `segments`: every smoothed river segment of the world (RiverIndex), as
 *   two vec4 per segment: (a.xyz, half-width at a), (b.xyz, half-width at b).
 *   Points are unit directions.
 * - Fine lists, per level-7 tile (about 12 km): every segment that can
 *   reach into the tile (half-width plus FINE_MARGIN). Meshes at levels 7–10
 *   use their level-7 ancestor's list.
 * - Coarse lists, per level-4 tile (about 98 km): chords that merge up to
 *   COARSE_MERGE consecutive segments (about 3 km), only for rivers at least
 *   COARSE_MIN_WIDTH wide, widest first, capped at COARSE_CAP. Meshes at
 *   levels 4–6 use them. Where those levels are drawn a pixel spans hundreds
 *   of meters, so the chords' error does not show, and a long river needs
 *   about 30 chords per tile instead of 250 segments.
 * - Levels 0–3 draw no rivers.
 *
 * Lists are built by assigning each segment to the tiles of its endpoints
 * displaced by its reach in eight directions. Segments (about 0.4 km after
 * smoothing) are much shorter than the tiles, so that covers every tile the
 * segment's reach overlaps.
 */
import { tileForDirection, tileKey, tileKeyString } from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { Vec3d } from '../../core/vec3d';
import type { RiverIndex } from '../../worldgen/riverIndex';

export const FINE_LEVEL = 7;
export const COARSE_LEVEL = 4;
/** Extra reach of a segment beyond its half-width in fine lists (m): antialiasing. */
export const FINE_MARGIN = 150;
export const COARSE_MIN_WIDTH = 25;
export const COARSE_CAP = 160;
/** Fine segments merged into one coarse chord. */
export const COARSE_MERGE = 8;
/** Extra reach in coarse lists (m): pixels are large where coarse tiles are drawn. */
const COARSE_MARGIN = 2000;

export interface RiverRange {
  start: number;
  count: number;
}

export class RiverTables {
  /** Two vec4 per segment (see module doc). */
  readonly segments: Float32Array;
  /** Concatenated per-tile lists of segment indices. */
  readonly lists: Uint32Array;
  private readonly fine = new Map<string, RiverRange>();
  private readonly coarse = new Map<string, RiverRange>();

  constructor(index: RiverIndex, radius: number) {
    const n = index.segments.count;
    const fineSrc = index.segments.data;

    // Coarse chords: runs of up to COARSE_MERGE consecutive, connected segments.
    const chords: number[] = [];
    for (let s = 0; s < n;) {
      let e = s;
      let width = Math.max(fineSrc[s * 8 + 6]!, fineSrc[s * 8 + 7]!);
      while (e + 1 < n && e + 1 - s < COARSE_MERGE) {
        const o = e * 8;
        const q = (e + 1) * 8;
        const gap = Math.hypot(
          fineSrc[o + 3]! - fineSrc[q]!,
          fineSrc[o + 4]! - fineSrc[q + 1]!,
          fineSrc[o + 5]! - fineSrc[q + 2]!,
        );
        if (gap > 1e-9) break;
        e++;
        width = Math.max(width, fineSrc[e * 8 + 6]!, fineSrc[e * 8 + 7]!);
      }
      chords.push(
        fineSrc[s * 8]!,
        fineSrc[s * 8 + 1]!,
        fineSrc[s * 8 + 2]!,
        fineSrc[e * 8 + 3]!,
        fineSrc[e * 8 + 4]!,
        fineSrc[e * 8 + 5]!,
        width,
        width,
      );
      s = e + 1;
    }
    const chordCount = chords.length / 8;
    // Fine segments first, then chords, in one table (same 8-field layout as RiverIndex).
    const src = new Float64Array((n + chordCount) * 8);
    src.set(fineSrc.subarray(0, n * 8));
    src.set(chords, n * 8);
    const total = n + chordCount;
    this.segments = new Float32Array(Math.max(1, total) * 8);
    for (let s = 0; s < total; s++) {
      const o = s * 8;
      this.segments.set([src[o]!, src[o + 1]!, src[o + 2]!, src[o + 6]! / 2], o);
      this.segments.set([src[o + 3]!, src[o + 4]!, src[o + 5]!, src[o + 7]! / 2], o + 4);
    }

    const fine = new Map<string, number[]>();
    const coarse = new Map<string, { ids: number[]; widths: number[] }>();
    const p = new Vec3d();
    const east = new Vec3d();
    const north = new Vec3d();
    const q = new Vec3d();
    const keysAround = (level: number, reach: number, s: number, out: Set<string>) => {
      for (const end of [0, 3]) {
        p.set(src[s * 8 + end]!, src[s * 8 + end + 1]!, src[s * 8 + end + 2]!);
        east.set(0, 1, 0).cross(p);
        if (east.length() < 1e-9) east.set(1, 0, 0);
        east.normalize();
        north.copy(p).cross(east);
        const a = reach / radius;
        for (let k = -1; k < 8; k++) {
          q.copy(p);
          if (k >= 0) {
            const ang = (k / 8) * 2 * Math.PI;
            q.addScaled(east, a * Math.cos(ang))
              .addScaled(north, a * Math.sin(ang))
              .normalize();
          }
          out.add(tileKeyString(tileForDirection(q, level)));
        }
      }
    };
    const keys = new Set<string>();
    for (let s = 0; s < n; s++) {
      const w = Math.max(src[s * 8 + 6]!, src[s * 8 + 7]!);
      keys.clear();
      keysAround(FINE_LEVEL, w / 2 + FINE_MARGIN, s, keys);
      for (const key of keys) {
        let list = fine.get(key);
        if (!list) fine.set(key, (list = []));
        list.push(s);
      }
    }
    for (let s = n; s < total; s++) {
      const w = src[s * 8 + 6]!;
      if (w >= COARSE_MIN_WIDTH) {
        keys.clear();
        keysAround(COARSE_LEVEL, w / 2 + COARSE_MARGIN, s, keys);
        for (const key of keys) {
          let c = coarse.get(key);
          if (!c) coarse.set(key, (c = { ids: [], widths: [] }));
          c.ids.push(s);
          c.widths.push(w);
        }
      }
    }

    const all: number[] = [];
    for (const [key, ids] of fine) {
      this.fine.set(key, { start: all.length, count: ids.length });
      for (const id of ids) all.push(id);
    }
    for (const [key, c] of coarse) {
      const order = c.ids.map((_, i) => i).sort((x, y) => c.widths[y]! - c.widths[x]! || x - y);
      const ids = order.slice(0, COARSE_CAP).map((i) => c.ids[i]!);
      this.coarse.set(key, { start: all.length, count: ids.length });
      for (const id of ids) all.push(id);
    }
    this.lists = Uint32Array.from(all.length ? all : [0]);
  }

  /** The list of segments a mesh of tile `t` draws. */
  rangeFor(t: TileKey): RiverRange {
    if (t.level >= FINE_LEVEL) {
      const s = t.level - FINE_LEVEL;
      return this.fine.get(tileKeyString(tileKey(t.face, FINE_LEVEL, t.x >> s, t.y >> s))) ?? NONE;
    }
    if (t.level >= COARSE_LEVEL) {
      const s = t.level - COARSE_LEVEL;
      return (
        this.coarse.get(tileKeyString(tileKey(t.face, COARSE_LEVEL, t.x >> s, t.y >> s))) ?? NONE
      );
    }
    return NONE;
  }

  get segmentCount(): number {
    return this.segments.length / 8;
  }
}

const NONE: RiverRange = { start: 0, count: 0 };
