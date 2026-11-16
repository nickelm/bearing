/**
 * Terrain edits and the one height function (decision 161, rule 13).
 *
 * `TerrainEdits.apply(dir, h)` takes the unedited height `h` at unit
 * direction `dir` (the finest tile data with its render detail, or the global
 * grid where no tile is loaded) and returns the edited height, composed in a
 * fixed order:
 *
 * 1. Corridors (roads, railways, canals), blended where they overlap, the
 *    higher priority weighing four times as much per rank.
 * 2. Pads (airfields, later shelves, yards and lock chambers) over them: on a
 *    pad the surface is exactly the pad's elevation. Pads do not overlap in
 *    practice; if they do, the first one wins.
 * 3. Protected river channels last: where 1 and 2 raised the ground inside a
 *    carved channel or its inner banks, it is held at the carved height (the
 *    kernel's carve stays the minimum, so no embankment dams a river).
 *
 * Only land is edited: a height at or below sea level is returned unchanged,
 * so a coastal pad meets the sea at its own edge. Every function here is pure
 * in (dir, h), so every tile level, the geomorph target, trees, buildings, the
 * camera and the flight model's ground agree without exchanging data.
 * `forTile` keeps only the edits that reach a tile, so other tiles cost
 * nothing and build byte-identical meshes.
 */
import { cubeFaceUvToDirection } from '../../core/coords';
import {
  neighborTile,
  tileForDirection,
  tileKey,
  tileKeyString,
  tileSampleDirection,
  TILE_TEXELS,
} from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { Vec3d } from '../../core/vec3d';
import { channelHold, channelsForTile } from './channels';
import type { ChannelSource } from './channels';
import {
  corridorAt,
  corridorSegments,
  CORRIDOR_SEGMENT_FIELDS,
  validateCorridor,
} from './corridor';
import type { CorridorEdit } from './corridor';
import { padWeight, preparePad } from './pad';
import type { PadEdit, PreparedPad } from './pad';

/** A height function restricted to one tile's edits: (direction, unedited height) → height. */
export type EditFn = (dir: Readonly<Vec3d>, h: number) => number;

/** Corridor segments are listed per tile of this level by their endpoints. */
export const CORRIDOR_INDEX_LEVEL = 6;
/**
 * Coarsest mesh level that draws corridors: level-6 vertices are about 380 m
 * apart, wider than any formation. Coarser tiles and their morph targets
 * leave them out alike, so a tile and its own parent surface agree.
 */
export const CORRIDOR_MIN_LEVEL = CORRIDOR_INDEX_LEVEL;
/** Longest corridor segment (m): longer ones are split, so a chord sags at most L² / 8R (3 cm). */
export const CORRIDOR_MAX_SEGMENT = 500;
/** Tile level whose lists serve point queries (`apply`, `cover`). */
const POINT_LEVEL = 7;
const POINT_CACHE = 512;

export interface TerrainEditsOptions {
  radius: number;
  pads?: readonly PadEdit[];
  corridors?: readonly CorridorEdit[];
  /** The river index whose carved channels stay last; none protects nothing. */
  channels?: ChannelSource | null;
}

/** The corridor segments near a tile, grouped by corridor (each group sorted by id). */
interface NearCorridors {
  groups: { priority: number; ids: number[] }[];
}

interface Near {
  corridors: NearCorridors;
  /** Channel segments near the tile, listed on first need. */
  channels: () => readonly number[];
}

/** The bounding cap of tile `k` with its border: center and angular radius. */
function tileCap(k: TileKey): { c: Vec3d; angle: number } {
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
  return { c, angle: Math.acos(Math.min(1, capCos)) };
}

export class TerrainEdits {
  readonly radius: number;
  readonly pads: readonly PadEdit[];
  private readonly prepared: PreparedPad[];
  private readonly seg: Float64Array;
  private readonly segCount: number;
  private readonly priorities: number[];
  private readonly byTile = new Map<string, number[]>();
  private readonly channels: ChannelSource | null;
  private readonly pointCache = new Map<string, Near>();

  constructor(opts: TerrainEditsOptions) {
    this.radius = opts.radius;
    this.pads = opts.pads ?? [];
    this.prepared = this.pads.map((p) => preparePad(p, opts.radius));
    const corridors = (opts.corridors ?? []).map((c, i) => {
      validateCorridor(c, i);
      return splitCorridor(c, opts.radius);
    });
    this.priorities = corridors.map((c) => c.priority);
    this.seg = corridorSegments(corridors);
    this.segCount = this.seg.length / CORRIDOR_SEGMENT_FIELDS;
    this.channels = opts.channels ?? null;
    const d = new Vec3d();
    for (let s = 0; s < this.segCount; s++) {
      const keys = new Set<string>();
      for (const e of [0, 3]) {
        const o = s * CORRIDOR_SEGMENT_FIELDS + e;
        d.set(this.seg[o]!, this.seg[o + 1]!, this.seg[o + 2]!);
        keys.add(tileKeyString(tileForDirection(d, CORRIDOR_INDEX_LEVEL)));
      }
      for (const key of keys) {
        let list = this.byTile.get(key);
        if (!list) this.byTile.set(key, (list = []));
        list.push(s);
      }
    }
  }

  /** Number of edit records (pads and corridors). */
  get count(): number {
    return this.prepared.length + this.priorities.length;
  }

  get padCount(): number {
    return this.prepared.length;
  }

  get corridorCount(): number {
    return this.priorities.length;
  }

  /** The edited height at unit direction `dir`, given the unedited height `h` there. */
  apply(dir: Readonly<Vec3d>, h: number): number {
    if (h <= 0) return h;
    const near = this.near(dir);
    return this.applyTo(this.prepared, near.corridors, near.channels, dir, h);
  }

  /** How much of the ground at `dir` is bare formation: 1 on a pad or a corridor's formation. */
  cover(dir: Readonly<Vec3d>): number {
    let c = 0;
    for (const p of this.prepared) c = Math.max(c, 1 - padWeight(p, dir, this.radius));
    if (c >= 1 || this.segCount === 0) return c;
    for (const g of this.near(dir).corridors.groups) {
      const r = corridorAt(this.seg, g.ids, dir, 0, this.radius);
      if (r) c = Math.max(c, r.cover);
    }
    return c;
  }

  /**
   * The edits restricted to those that reach tile `t` (any level), or null
   * when none does, so unedited tiles pay nothing.
   */
  forTile(t: TileKey): EditFn | null {
    const n = 1 << t.level;
    const c = cubeFaceUvToDirection(t.face, (t.x + 0.5) / n, (t.y + 0.5) / n);
    const corner = cubeFaceUvToDirection(t.face, t.x / n, t.y / n);
    // Half-diagonal of the tile as an angle, with slack for the face warp.
    const half = 1.2 * Math.acos(Math.min(1, c.dot(corner)));
    const pads = this.prepared.filter((p) => {
      const dot = p.cx * c.x + p.cy * c.y + p.cz * c.z;
      return Math.acos(Math.min(1, dot)) <= half + p.reach;
    });
    const corridors = this.corridorsForTile(t);
    if (pads.length === 0 && corridors.groups.length === 0) return null;
    const channels = this.channelLister(t);
    return (dir, h) => (h <= 0 ? h : this.applyTo(pads, corridors, channels, dir, h));
  }

  private applyTo(
    pads: readonly PreparedPad[],
    corridors: NearCorridors,
    channels: () => readonly number[],
    dir: Readonly<Vec3d>,
    h: number,
  ): number {
    let e = h;
    if (corridors.groups.length > 0) {
      let num = 0;
      let den = 0;
      let top = 0;
      for (const g of corridors.groups) {
        const r = corridorAt(this.seg, g.ids, dir, h, this.radius);
        if (!r || r.weight <= 0) continue;
        const p = 4 ** g.priority;
        num += p * r.weight * (r.target - h);
        den += p * r.weight;
        top = Math.max(top, p);
      }
      if (den > 0) e = h + num / Math.max(den, top);
    }
    for (const p of pads) {
      const w = padWeight(p, dir, this.radius);
      if (w >= 1) continue;
      e = p.pad.elevation + (e - p.pad.elevation) * w;
      break;
    }
    if (e > h && this.channels) {
      const ids = channels();
      if (ids.length > 0) {
        const hold = channelHold(this.channels.segments, ids, dir, this.radius);
        if (hold > 0) e -= hold * (e - h);
      }
    }
    return e;
  }

  /** Corridor segments that can reach tile `t`, grouped by corridor. */
  private corridorsForTile(t: TileKey): NearCorridors {
    if (this.segCount === 0 || t.level < CORRIDOR_MIN_LEVEL) return { groups: [] };
    const shift = t.level - CORRIDOR_INDEX_LEVEL;
    const anc = tileKey(t.face, CORRIDOR_INDEX_LEVEL, t.x >> shift, t.y >> shift);
    const cand = new Set<number>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = dx === 0 && dy === 0 ? anc : neighborTile(anc, dx, dy);
        for (const s of this.byTile.get(tileKeyString(k)) ?? []) cand.add(s);
      }
    }
    const { c, angle } = tileCap(t);
    const seg = this.seg;
    const byCorridor = new Map<number, number[]>();
    for (const s of [...cand].sort((x, y) => x - y)) {
      const o = s * CORRIDOR_SEGMENT_FIELDS;
      const ax = seg[o]!;
      const ay = seg[o + 1]!;
      const az = seg[o + 2]!;
      const bx = seg[o + 3]!;
      const by = seg[o + 4]!;
      const bz = seg[o + 5]!;
      const len = Math.acos(Math.min(1, ax * bx + ay * by + az * bz));
      const nearer = Math.min(
        Math.acos(Math.min(1, c.x * ax + c.y * ay + c.z * az)),
        Math.acos(Math.min(1, c.x * bx + c.y * by + c.z * bz)),
      );
      if (nearer > angle + len + seg[o + 11]! / this.radius) continue;
      const ci = seg[o + 14]!;
      let list = byCorridor.get(ci);
      if (!list) byCorridor.set(ci, (list = []));
      list.push(s);
    }
    const groups = [...byCorridor.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ci, ids]) => ({ priority: this.priorities[ci]!, ids }));
    return { groups };
  }

  private channelLister(t: TileKey): () => readonly number[] {
    const src = this.channels;
    if (!src) return () => [];
    let ids: number[] | null = null;
    return () => (ids ??= channelsForTile(src, t, this.radius));
  }

  /** Edits near a point, by the level-POINT_LEVEL tile under it (cached). */
  private near(dir: Readonly<Vec3d>): Near {
    const t = tileForDirection(dir, POINT_LEVEL);
    const key = tileKeyString(t);
    let n = this.pointCache.get(key);
    if (!n) {
      if (this.pointCache.size >= POINT_CACHE) this.pointCache.clear();
      n = { corridors: this.corridorsForTile(t), channels: this.channelLister(t) };
      this.pointCache.set(key, n);
    }
    return n;
  }
}

/** A corridor with segments no longer than CORRIDOR_MAX_SEGMENT, points renormalized. */
function splitCorridor(c: CorridorEdit, radius: number): CorridorEdit {
  const n = c.elevation.length;
  const pts: number[] = [];
  const z: number[] = [];
  const a = new Vec3d();
  const b = new Vec3d();
  const p = new Vec3d();
  for (let i = 0; i < n; i++) {
    b.set(c.points[i * 3]!, c.points[i * 3 + 1]!, c.points[i * 3 + 2]!);
    if (i > 0) {
      const len = a.distanceTo(b) * radius;
      const parts = Math.ceil(len / CORRIDOR_MAX_SEGMENT);
      for (let k = 1; k < parts; k++) {
        const f = k / parts;
        p.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f).normalize();
        pts.push(p.x, p.y, p.z);
        z.push(c.elevation[i - 1]! + (c.elevation[i]! - c.elevation[i - 1]!) * f);
      }
    }
    pts.push(b.x, b.y, b.z);
    z.push(c.elevation[i]!);
    a.set(b.x, b.y, b.z);
  }
  return { ...c, points: Float64Array.from(pts), elevation: Float64Array.from(z) };
}
