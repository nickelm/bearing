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

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface RiverSegments {
  count: number;
  /** Per segment: a.xyz, b.xyz (unit directions), widthA, widthB (m). */
  data: Float64Array;
}

const FIELDS = 8;

/** Two Chaikin corner-cutting passes on a polyline of unit vectors with attributes. */
export function chaikin(pts: number[][], passes: number): number[][] {
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

/**
 * Meanders (decision 126): lowland rivers wind across their floodplains. A
 * polyline whose bed falls less than `maxGradient` (m/m, physical) and whose
 * width reaches `minWidth` m is displaced sideways by a meander train of
 * wavelength `wavelength` × width (varying ±`wavelengthJitter` per bend) and
 * amplitude `amplitude` × wavelength, with a third harmonic that skews and
 * fattens the bends. The displacement tapers to zero over a wavelength at both
 * ends, so confluences and mouths stay where they are.
 */
export const MEANDER_TUNING = {
  maxGradient: 0.0012,
  fullGradient: 0.0004,
  minWidth: 25,
  wavelength: 11,
  wavelengthJitter: 0.3,
  amplitude: 0.32,
  /** Point spacing along a meandering river, in wavelengths. */
  spacing: 1 / 14,
};

export interface MeanderOptions {
  /** Physical height per global cell (the rivers' `cells` index it). */
  height: Float32Array;
  radius: number;
  tuning?: Partial<typeof MEANDER_TUNING>;
}

/** Deterministic hash of two integers to [0, 1). */
function hash2(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** A polyline (unit vectors + width) with meanders added (see MEANDER_TUNING). */
export function meander(
  pts: number[][],
  id: number,
  radius: number,
  t: typeof MEANDER_TUNING,
  strength: number,
): number[][] {
  if (pts.length < 2 || strength <= 0) return pts;
  // Arclength (m) at each point.
  const s = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dot = Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!);
    s.push(s[i - 1]! + Math.acos(dot) * radius);
  }
  const L = s[s.length - 1]!;
  const meanWidth = pts.reduce((acc, p) => acc + p[3]!, 0) / pts.length;
  const lambda0 = t.wavelength * Math.max(meanWidth, t.minWidth);
  if (L < 1.5 * lambda0) return pts;
  // Resample evenly.
  const step = lambda0 * t.spacing;
  const count = Math.max(2, Math.ceil(L / step));
  const out: number[][] = [];
  let seg = 0;
  let phase = hash2(id, 7) * 2 * Math.PI;
  let bend = 0;
  let bendLambda = lambda0 * (1 + t.wavelengthJitter * (2 * hash2(id, bend) - 1));
  let prevS = 0;
  const p = new Vec3d();
  const q = new Vec3d();
  const tangent = new Vec3d();
  const side = new Vec3d();
  for (let k = 0; k <= count; k++) {
    const sk = (k / count) * L;
    while (seg < pts.length - 2 && s[seg + 1]! < sk) seg++;
    const a = pts[seg]!;
    const b = pts[seg + 1]!;
    const f = Math.min(1, Math.max(0, (sk - s[seg]!) / Math.max(s[seg + 1]! - s[seg]!, 1e-9)));
    p.set(
      a[0]! + (b[0]! - a[0]!) * f,
      a[1]! + (b[1]! - a[1]!) * f,
      a[2]! + (b[2]! - a[2]!) * f,
    ).normalize();
    const w = a[3]! + (b[3]! - a[3]!) * f;
    // Phase advances by 2π per bend wavelength; each half bend draws a new length.
    const before = Math.floor(phase / Math.PI);
    phase += ((sk - prevS) / bendLambda) * 2 * Math.PI;
    prevS = sk;
    if (Math.floor(phase / Math.PI) !== before) {
      bend++;
      bendLambda = lambda0 * (1 + t.wavelengthJitter * (2 * hash2(id, bend) - 1));
    }
    const taper =
      Math.min(1, sk / lambda0, (L - sk) / lambda0) ** 2 *
      (3 - 2 * Math.min(1, sk / lambda0, (L - sk) / lambda0));
    const amp = strength * taper * t.amplitude * bendLambda;
    const y = amp * (Math.sin(phase) - 0.18 * Math.sin(3 * phase + 0.6));
    q.set(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
    tangent.copy(q).addScaled(p, -q.dot(p)).normalize();
    side.copy(p).cross(tangent);
    const d = p
      .clone()
      .addScaled(side, y / radius)
      .normalize();
    out.push([d.x, d.y, d.z, w]);
  }
  return out;
}

/**
 * Deltas (decision 126): the mouths of rivers at least `minWidth` m wide build
 * a fan of radius `radiusWidths` × width (at most `maxRadius` m) into the sea.
 */
export const DELTA_TUNING = {
  minWidth: 140,
  radiusWidths: 45,
  maxRadius: 26_000,
};

/** Per delta: mouth.xyz, seaward direction.xyz (tangent, unit), width (m), fan radius (m). */
export const DELTA_FIELDS = 8;

export class RiverIndex {
  readonly segments: RiverSegments;
  /** River mouths that build deltas, DELTA_FIELDS per record. */
  readonly deltas: Float64Array;
  private readonly byTile = new Map<string, number[]>();

  /** With `meanders`, lowland rivers wind across their floodplains (decision 126). */
  constructor(rivers: Rivers, meanders?: MeanderOptions) {
    const mt = { ...MEANDER_TUNING, ...meanders?.tuning };
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
      let sm = chaikin(pts, 2);
      if (meanders && pts.length >= 2) {
        // Bed gradient over the polyline, from the global grid.
        const first = rivers.offsets[k]!;
        const last = rivers.offsets[k + 1]! - 1;
        const drop = meanders.height[rivers.cells[first]!]! - meanders.height[rivers.cells[last]!]!;
        let len = 0;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]!;
          const b = pts[i]!;
          len +=
            Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)) * meanders.radius;
        }
        const gradient = Math.max(0, drop) / Math.max(len, 1);
        const strength =
          (1 - smoothstep(mt.fullGradient, mt.maxGradient, gradient)) *
          smoothstep(mt.minWidth, 2 * mt.minWidth, Math.max(...pts.map((p) => p[3]!)));
        if (strength > 0) sm = meander(sm, k, meanders.radius, mt, strength);
      }
      for (let i = 0; i + 1 < sm.length; i++) {
        const a = sm[i]!;
        const b = sm[i + 1]!;
        segs.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, a[3]!, b[3]!);
      }
    }
    this.segments = { count: segs.length / FIELDS, data: Float64Array.from(segs) };
    // Deltas at mouths of wide rivers: the last land point and the sea point after it.
    const deltas: number[] = [];
    for (let k = 0; k < rivers.count; k++) {
      if (rivers.downstream[k] !== -1) continue;
      const end = rivers.offsets[k + 1]! - 1;
      if (end - rivers.offsets[k]! < 1) continue;
      const w = rivers.width[end - 1]!;
      if (w < DELTA_TUNING.minWidth) continue;
      const m = new Vec3d(
        rivers.points[(end - 1) * 3]!,
        rivers.points[(end - 1) * 3 + 1]!,
        rivers.points[(end - 1) * 3 + 2]!,
      );
      // Seaward: from a few points upstream to the sea point, in the tangent plane.
      const up = Math.max(rivers.offsets[k]!, end - 4);
      const dir = new Vec3d(
        rivers.points[end * 3]! - rivers.points[up * 3]!,
        rivers.points[end * 3 + 1]! - rivers.points[up * 3 + 1]!,
        rivers.points[end * 3 + 2]! - rivers.points[up * 3 + 2]!,
      );
      dir.addScaled(m, -dir.dot(m)).normalize();
      const r = Math.min(DELTA_TUNING.maxRadius, DELTA_TUNING.radiusWidths * w);
      deltas.push(m.x, m.y, m.z, dir.x, dir.y, dir.z, w, r);
    }
    this.deltas = Float64Array.from(deltas);
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

  /** Deltas whose fan may reach tile `k` (with its border), by record index. */
  deltasForTile(k: TileKey, radius: number): number[] {
    const c = tileSampleDirection(k, TILE_TEXELS / 2, TILE_TEXELS / 2);
    const corner = tileSampleDirection(k, -2, -2);
    const capAngle = Math.acos(Math.min(1, c.dot(corner)));
    const out: number[] = [];
    const n = this.deltas.length / DELTA_FIELDS;
    for (let i = 0; i < n; i++) {
      const o = i * DELTA_FIELDS;
      const dot = c.x * this.deltas[o]! + c.y * this.deltas[o + 1]! + c.z * this.deltas[o + 2]!;
      const reach = (1.6 * this.deltas[o + 7]!) / radius;
      if (Math.acos(Math.min(1, dot)) <= capAngle + reach) out.push(i);
    }
    return out;
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
