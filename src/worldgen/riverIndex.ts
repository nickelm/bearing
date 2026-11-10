/**
 * River segments for detail-tile synthesis: polylines smoothed and indexed
 * by tile, so a tile can carve exactly the channels that can reach it.
 *
 * Global rivers run through global-grid cell centers, which zigzag at about
 * 1.5 km. Two Chaikin passes round them off before they are carved into
 * 50 m tiles. Smoothing is applied per polyline, keeping the endpoints, so
 * tributaries still meet their main river exactly.
 *
 * Segments are indexed by the level-INDEX_LEVEL tiles their endpoints fall
 * in. A query for any tile at or below that level takes its ancestor at
 * INDEX_LEVEL plus that ancestor's eight neighbors, then keeps the segments
 * within the tile's bounding cap plus a margin. The result depends only on
 * the tile key, so every tile sees the same segments however tiles are
 * generated.
 */
import {
  neighborTile,
  tileForDirection,
  tileKey,
  tileKeyString,
  tileSampleDirection,
  TILE_TEXELS,
} from '../core/tiles';
import type { TileKey } from '../core/tiles';
import { Vec3d } from '../core/vec3d';
import type { Rivers } from './rivers';

export const RIVER_INDEX_LEVEL = 4;

export interface RiverSegments {
  count: number;
  /** Per segment: a.xyz, b.xyz (unit directions), widthA, widthB (m). */
  data: Float64Array;
}

const FIELDS = 8;

/** Two Chaikin corner-cutting passes on a polyline of unit vectors with attributes. */
function chaikin(pts: number[][], passes: number): number[][] {
  let p = pts;
  for (let pass = 0; pass < passes; pass++) {
    if (p.length < 3) return p;
    const out: number[][] = [p[0]!];
    for (let i = 0; i + 1 < p.length; i++) {
      const a = p[i]!;
      const b = p[i + 1]!;
      out.push(a.map((x, k) => 0.75 * x + 0.25 * b[k]!));
      out.push(a.map((x, k) => 0.25 * x + 0.75 * b[k]!));
    }
    out.push(p[p.length - 1]!);
    // Renormalize the direction part.
    for (const q of out) {
      const l = Math.hypot(q[0]!, q[1]!, q[2]!);
      q[0]! /= l;
      q[1]! /= l;
      q[2]! /= l;
    }
    p = out;
  }
  return p;
}

export class RiverIndex {
  readonly segments: RiverSegments;
  private readonly byTile = new Map<string, number[]>();

  constructor(rivers: Rivers) {
    const segs: number[] = [];
    for (let k = 0; k < rivers.count; k++) {
      const pts: number[][] = [];
      for (let p = rivers.offsets[k]!; p < rivers.offsets[k + 1]!; p++) {
        pts.push([
          rivers.points[p * 3]!,
          rivers.points[p * 3 + 1]!,
          rivers.points[p * 3 + 2]!,
          rivers.width[p]!,
        ]);
      }
      const sm = chaikin(pts, 2);
      for (let i = 0; i + 1 < sm.length; i++) {
        const a = sm[i]!;
        const b = sm[i + 1]!;
        segs.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, a[3]!, b[3]!);
      }
    }
    this.segments = { count: segs.length / FIELDS, data: Float64Array.from(segs) };
    const d = new Vec3d();
    for (let s = 0; s < this.segments.count; s++) {
      const keys = new Set<string>();
      for (const e of [0, 3]) {
        d.set(segs[s * FIELDS + e]!, segs[s * FIELDS + e + 1]!, segs[s * FIELDS + e + 2]!);
        keys.add(tileKeyString(tileForDirection(d, RIVER_INDEX_LEVEL)));
      }
      for (const key of keys) {
        let list = this.byTile.get(key);
        if (!list) this.byTile.set(key, (list = []));
        list.push(s);
      }
    }
  }

  /**
   * Segments that may affect `k` (level ≥ RIVER_INDEX_LEVEL): within the
   * tile's bounding cap plus `marginM` meters on a planet of radius `radius`.
   * Sorted by segment id.
   */
  forTile(k: TileKey, marginM: number, radius: number): number[] {
    if (k.level < RIVER_INDEX_LEVEL) return [];
    const shift = k.level - RIVER_INDEX_LEVEL;
    const anc = tileKey(k.face, RIVER_INDEX_LEVEL, k.x >> shift, k.y >> shift);
    const cand = new Set<number>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = dx === 0 && dy === 0 ? anc : neighborTile(anc, dx, dy);
        for (const s of this.byTile.get(tileKeyString(t)) ?? []) cand.add(s);
      }
    }
    // Bounding cap of the tile (with its border samples).
    const c = tileSampleDirection(k, TILE_TEXELS / 2, TILE_TEXELS / 2);
    let capCos = 1;
    const corner = new Vec3d();
    for (const [sx, sy] of [
      [-2, -2],
      [TILE_TEXELS + 2, -2],
      [-2, TILE_TEXELS + 2],
      [TILE_TEXELS + 2, TILE_TEXELS + 2],
    ] as const) {
      tileSampleDirection(k, sx, sy, corner);
      capCos = Math.min(capCos, c.dot(corner));
    }
    const capAngle = Math.acos(Math.min(1, capCos)) + marginM / radius;
    const seg = this.segments.data;
    const out: number[] = [];
    const a = new Vec3d();
    const b = new Vec3d();
    for (const s of cand) {
      a.set(seg[s * FIELDS]!, seg[s * FIELDS + 1]!, seg[s * FIELDS + 2]!);
      b.set(seg[s * FIELDS + 3]!, seg[s * FIELDS + 4]!, seg[s * FIELDS + 5]!);
      // Segments are ~1 km long: the nearer endpoint is within a segment length of any point on it.
      const len = Math.acos(Math.min(1, a.dot(b)));
      const near = Math.min(Math.acos(Math.min(1, c.dot(a))), Math.acos(Math.min(1, c.dot(b))));
      if (near <= capAngle + len) out.push(s);
    }
    return out.sort((x, y) => x - y);
  }
}

export const RIVER_SEGMENT_FIELDS = FIELDS;
