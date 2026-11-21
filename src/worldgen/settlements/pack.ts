/**
 * Packed plans and the urban ground's feature field (decision 266): what crosses from
 * the settlement worker to the renderer, as transferable typed arrays.
 *
 * - `packPlan` keeps what drawing needs: buildings (BUILDING_FIELDS floats each),
 *   blocks (polygons, district, ground, mean height), streets (points and class),
 *   landmarks, targets, plumes and pads. Parcels stay in the worker.
 * - `chunkField` rasterizes one CHUNK m square of a plan into FIELD_TEXELS² texels,
 *   each a u32: the signed distance to the nearest street's edge (byte 0, quarter
 *   meters biased by 128, negative inside the street), the ground class of the block
 *   under the texel (byte 1; NO_BLOCK outside any), the nearest street's class
 *   (byte 2) and the block's district (byte 3). The terrain shader reads it bilinearly
 *   for crisp street edges (proposal 0005's per-chunk feature distance field).
 */
import { pointInPoly, segDist, SpatialHash } from './geom';
import { Ground, STREET_HALF_WIDTH } from './types';
import type { CandidateTarget, Landmark, Pad, SettlementPlan, Style, Tier } from './types';

export const BUILDING_FIELDS = 16;
/** Edge (m) of a field and mesh chunk, and its texels per side. */
export const CHUNK = 1000;
export const FIELD_TEXELS = 128;
export const NO_BLOCK = 255;

export interface PackedPlan {
  key: string;
  name: string;
  tier: Tier;
  style: Style;
  center: [number, number, number];
  coreRadius: number;
  /** x, y, angle, half-length, half-width, height, roof rise, roof, wall, roof color, extras, kind, block, landmark, floors, 0. */
  buildings: Float32Array;
  blockPoints: Float32Array;
  blockOffsets: Uint32Array;
  /** district, ground, mean height, area per block. */
  blockInfo: Float32Array;
  streetPoints: Float32Array;
  streetOffsets: Uint32Array;
  streetKinds: Uint8Array;
  landmarks: Landmark[];
  targets: CandidateTarget[];
  plumes: number[];
  pads: Pad[];
  /** The plan's bounding box (m): x0, y0, x1, y1. */
  bounds: [number, number, number, number];
  /**
   * Where the plan builds (decision 278): one bit per MASK_CELL square, row-major from
   * (maskX0, maskY0) × MASK_CELL, set on blocks (but parks and cemeteries) and streets.
   * Off it lies the natural ground, where woods keep their trees and canopy.
   */
  mask: Uint32Array;
  maskX0: number;
  maskY0: number;
  maskNx: number;
  maskNy: number;
}

/** Edge of a built-mask cell (m). */
export const MASK_CELL = 40;
/** The most cells a mask may hold (the city ground's buffer reserves this many bits per plan). */
export const MASK_MAX_CELLS = 512 * 1024;

/** The built mask of a plan (decision 278): blocks rasterized at cell centers, streets stamped. */
export function builtMask(
  p: Pick<
    PackedPlan,
    | 'buildings'
    | 'blockPoints'
    | 'blockOffsets'
    | 'blockInfo'
    | 'streetPoints'
    | 'streetOffsets'
    | 'streetKinds'
    | 'bounds'
  >,
): {
  mask: Uint32Array;
  maskX0: number;
  maskY0: number;
  maskNx: number;
  maskNy: number;
} {
  const C = MASK_CELL;
  const [bx0, by0, bx1, by1] = p.bounds;
  let x0 = Math.floor(bx0 / C) - 1;
  let y0 = Math.floor(by0 / C) - 1;
  let nx = Math.floor(bx1 / C) + 2 - x0;
  let ny = Math.floor(by1 / C) + 2 - y0;
  // Clamp to the buffer's room, about the center.
  while (nx * ny > MASK_MAX_CELLS) {
    x0 += 1;
    y0 += 1;
    nx -= 2;
    ny -= 2;
  }
  const mask = new Uint32Array(Math.ceil((nx * ny) / 32));
  const set = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return;
    const k = j * nx + i;
    mask[k >> 5]! |= 1 << (k & 31);
  };
  const { blockPoints: bp, blockOffsets: bo, blockInfo: bi } = p;
  for (let b = 0; b + 1 < bo.length; b++) {
    const ground = bi[b * 4 + 1]!;
    if (ground === Ground.Park || ground === Ground.Cemetery) continue;
    const s = bo[b]!;
    const n = (bo[b + 1]! - s) / 2;
    let ylo = Infinity;
    let yhi = -Infinity;
    for (let k = 0; k < n; k++) {
      ylo = Math.min(ylo, bp[s + k * 2 + 1]!);
      yhi = Math.max(yhi, bp[s + k * 2 + 1]!);
    }
    for (let j = Math.ceil(ylo / C - 0.5); j <= Math.floor(yhi / C - 0.5); j++) {
      const y = (j + 0.5) * C;
      const xs: number[] = [];
      for (let a = 0, c = n - 1; a < n; c = a++) {
        const ya = bp[s + a * 2 + 1]!;
        const yc = bp[s + c * 2 + 1]!;
        if (ya > y !== yc > y) {
          const xa = bp[s + a * 2]!;
          xs.push(xa + ((y - ya) * (bp[s + c * 2]! - xa)) / (yc - ya));
        }
      }
      xs.sort((u, v) => u - v);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        for (let i = Math.ceil(xs[q]! / C - 0.5); i <= Math.floor(xs[q + 1]! / C - 0.5); i++)
          set(i - x0, j - y0);
      }
    }
  }
  // Every building's footprint too: slabs in a microdistrict's parkland, a stadium in a park.
  const bd = p.buildings;
  for (let b = 0; b + BUILDING_FIELDS <= bd.length; b += BUILDING_FIELDS) {
    const r = Math.hypot(bd[b + 3]!, bd[b + 4]!);
    for (let j = Math.floor((bd[b + 1]! - r) / C); j <= Math.floor((bd[b + 1]! + r) / C); j++)
      for (let i = Math.floor((bd[b]! - r) / C); i <= Math.floor((bd[b]! + r) / C); i++)
        set(i - x0, j - y0);
  }
  const { streetPoints: sp, streetOffsets: so, streetKinds: sk } = p;
  for (let s = 0; s < sk.length; s++) {
    const hw = (STREET_HALF_WIDTH[sk[s]!] ?? 4) + 2.5;
    for (let i = so[s]!; i + 3 < so[s + 1]!; i += 2) {
      const ax = sp[i]!;
      const ay = sp[i + 1]!;
      const ex = sp[i + 2]!;
      const ey = sp[i + 3]!;
      for (
        let j = Math.floor((Math.min(ay, ey) - hw) / C);
        j <= Math.floor((Math.max(ay, ey) + hw) / C);
        j++
      ) {
        for (
          let k = Math.floor((Math.min(ax, ex) - hw) / C);
          k <= Math.floor((Math.max(ax, ex) + hw) / C);
          k++
        ) {
          // A cell is street when its center lies within the street's half-width plus half a cell.
          if (segDist((k + 0.5) * C, (j + 0.5) * C, ax, ay, ex, ey).d < hw + C / 2)
            set(k - x0, j - y0);
        }
      }
    }
  }
  return { mask, maskX0: x0, maskY0: y0, maskNx: nx, maskNy: ny };
}

/** Whether local (x, y) lies on a plan's built ground by its mask (false off the mask). */
export function maskBuilt(
  p: Pick<PackedPlan, 'mask' | 'maskX0' | 'maskY0' | 'maskNx' | 'maskNy'>,
  x: number,
  y: number,
): boolean {
  const i = Math.floor(x / MASK_CELL) - p.maskX0;
  const j = Math.floor(y / MASK_CELL) - p.maskY0;
  if (i < 0 || j < 0 || i >= p.maskNx || j >= p.maskNy) return false;
  const k = j * p.maskNx + i;
  return ((p.mask[k >> 5]! >>> (k & 31)) & 1) === 1;
}

export function packPlan(p: SettlementPlan): PackedPlan {
  const buildings = new Float32Array(p.buildings.length * BUILDING_FIELDS);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  p.buildings.forEach((b, i) => {
    buildings.set(
      [
        b.x,
        b.y,
        b.angle,
        b.halfLength,
        b.halfWidth,
        b.height,
        b.roofHeight,
        b.roof,
        b.wall,
        b.roofColor,
        b.extras,
        b.kind,
        b.block,
        b.landmark,
        b.floors,
        0,
      ],
      i * BUILDING_FIELDS,
    );
    grow(b.x, b.y);
  });
  const blockOffsets = new Uint32Array(p.blocks.length + 1);
  let n = 0;
  p.blocks.forEach((b, i) => {
    blockOffsets[i] = n;
    n += b.polygon.length;
  });
  blockOffsets[p.blocks.length] = n;
  const blockPoints = new Float32Array(n);
  const blockInfo = new Float32Array(p.blocks.length * 4);
  p.blocks.forEach((b, i) => {
    blockPoints.set(b.polygon, blockOffsets[i]!);
    blockInfo.set([b.district, b.ground, b.height, b.area], i * 4);
    for (let k = 0; k < b.polygon.length; k += 2) grow(b.polygon[k]!, b.polygon[k + 1]!);
  });
  const streetOffsets = new Uint32Array(p.streets.length + 1);
  n = 0;
  p.streets.forEach((s, i) => {
    streetOffsets[i] = n;
    n += s.points.length;
  });
  streetOffsets[p.streets.length] = n;
  const streetPoints = new Float32Array(n);
  const streetKinds = new Uint8Array(p.streets.length);
  p.streets.forEach((s, i) => {
    streetPoints.set(s.points, streetOffsets[i]!);
    streetKinds[i] = s.kind;
  });
  if (!(x0 < x1)) [x0, y0, x1, y1] = [-1, -1, 1, 1];
  const packed = {
    key: p.key,
    name: p.name,
    tier: p.tier,
    style: p.style,
    center: p.center,
    coreRadius: p.coreRadius,
    buildings,
    blockPoints,
    blockOffsets,
    blockInfo,
    streetPoints,
    streetOffsets,
    streetKinds,
    landmarks: p.landmarks,
    targets: p.targets,
    plumes: p.plumes,
    pads: p.pads,
    bounds: [x0, y0, x1, y1] as [number, number, number, number],
  };
  return { ...packed, ...builtMask(packed) };
}

/** The transfer list of a packed plan. */
export function packedBuffers(p: PackedPlan): ArrayBuffer[] {
  return [
    p.buildings,
    p.blockPoints,
    p.blockOffsets,
    p.blockInfo,
    p.streetPoints,
    p.streetOffsets,
    p.streetKinds,
    p.mask,
  ].map((a) => a.buffer as ArrayBuffer);
}

/** Lookup structures for rasterizing a plan's fields, built once per plan. */
export class FieldIndex {
  private readonly segs = new SpatialHash<number>(100);
  private readonly blocks = new SpatialHash<number>(150);
  /** ax, ay, bx, by, half-width, kind per segment. */
  private readonly seg: number[] = [];

  constructor(readonly plan: PackedPlan) {
    const { streetPoints: sp, streetOffsets: so, streetKinds: sk } = plan;
    for (let s = 0; s < sk.length; s++) {
      const hw = STREET_HALF_WIDTH[sk[s]!] ?? 4;
      for (let i = so[s]!; i + 3 < so[s + 1]!; i += 2) {
        const k = this.seg.length / 6;
        this.seg.push(sp[i]!, sp[i + 1]!, sp[i + 2]!, sp[i + 3]!, hw, sk[s]!);
        this.segs.addBox(
          Math.min(sp[i]!, sp[i + 2]!),
          Math.min(sp[i + 1]!, sp[i + 3]!),
          Math.max(sp[i]!, sp[i + 2]!),
          Math.max(sp[i + 1]!, sp[i + 3]!),
          k,
        );
      }
    }
    const { blockPoints: bp, blockOffsets: bo } = plan;
    for (let b = 0; b + 1 < bo.length; b++) {
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (let i = bo[b]!; i < bo[b + 1]!; i += 2) {
        bx0 = Math.min(bx0, bp[i]!);
        by0 = Math.min(by0, bp[i + 1]!);
        bx1 = Math.max(bx1, bp[i]!);
        by1 = Math.max(by1, bp[i + 1]!);
      }
      this.blocks.addBox(bx0, by0, bx1, by1, b);
    }
  }

  /** The block under (x, y), or −1. */
  blockAt(x: number, y: number): number {
    const { blockPoints: bp, blockOffsets: bo } = this.plan;
    let found = -1;
    this.blocks.near(x, y, 0, (b) => {
      if (pointInPoly(x, y, bp.subarray(bo[b]!, bo[b + 1]!))) {
        found = b;
        return true;
      }
      return false;
    });
    return found;
  }

  /** The segment whose edge is nearest (x, y) within `reach` (its index), or −1. */
  nearestSegment(x: number, y: number, reach: number): number {
    let best = reach;
    let id = -1;
    const s = this.seg;
    this.segs.near(x, y, reach + 8, (k) => {
      const o = k * 6;
      const d = segDist(x, y, s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!).d - s[o + 4]!;
      if (d < best) {
        best = d;
        id = k;
      }
    });
    return id;
  }

  /** Segment k: ax, ay, bx, by, half-width, kind. */
  segment(k: number): number[] {
    return this.seg.slice(k * 6, k * 6 + 6);
  }

  /** Signed distance (m) to the nearest street's edge within `reach`, and its class. */
  street(x: number, y: number, reach: number): { d: number; kind: number } {
    let best = reach;
    let kind = 255;
    const s = this.seg;
    this.segs.near(x, y, reach + 8, (k) => {
      const o = k * 6;
      const d = segDist(x, y, s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!).d - s[o + 4]!;
      if (d < best) {
        best = d;
        kind = s[o + 5]!;
      }
    });
    return { d: best, kind };
  }
}

/** Segments a chunk's field can hold (each SEG_WORDS words after its texels). */
export const FIELD_SEGMENTS = 4096;
export const SEG_WORDS = 3;
/** Words per chunk field: texels, then its segment table. */
export const FIELD_WORDS = FIELD_TEXELS * FIELD_TEXELS + FIELD_SEGMENTS * SEG_WORDS;
/** Quantization of segment ends: chunk-local meters from −SEG_ORIGIN, SEG_SCALE steps per meter. */
export const SEG_ORIGIN = 512;
export const SEG_SCALE = 32;
/** Texels name the nearest street within this distance of its edge (m). */
const STREET_REACH = 40;
export const NO_SEGMENT = 0xffff;

/**
 * The field of chunk (ci, cj) (decisions 266, 290): FIELD_TEXELS² texels of CHUNK /
 * FIELD_TEXELS m, each a u32 with the nearest street segment's index in the chunk's
 * table (bits 0–15; NO_SEGMENT if none within STREET_REACH m), the ground class of the
 * block under it (bits 16–23; NO_BLOCK outside) and the block's district (bits 24–31).
 * Then the segment table: per segment its ends in chunk-local quantized meters (two
 * u16 each, x low) and its half-width in sixteenths of a meter with its class above.
 * The shader measures the exact distance to the segments of the four texels round a
 * pixel, so streets of any width keep crisp, continuous edges; the distance itself was
 * stored before and could not be interpolated across a street narrower than a texel.
 */
export function chunkField(index: FieldIndex, ci: number, cj: number): Uint32Array {
  const T = FIELD_TEXELS;
  const step = CHUNK / T;
  const out = new Uint32Array(FIELD_WORDS);
  const info = index.plan.blockInfo;
  const x0 = ci * CHUNK;
  const y0 = cj * CHUNK;
  const local = new Map<number, number>();
  const segBase = T * T;
  const q = (v: number) => Math.max(0, Math.min(65535, Math.round((v + SEG_ORIGIN) * SEG_SCALE)));
  /** Clips segment k to the chunk grown by a margin, so its ends fit the quantization. */
  const add = (k: number): number => {
    const known = local.get(k);
    if (known !== undefined) return known;
    if (local.size >= FIELD_SEGMENTS) return NO_SEGMENT;
    const seg = index.segment(k);
    const hw = seg[4]!;
    const kind = seg[5]!;
    let ax = seg[0]!;
    let ay = seg[1]!;
    let bx = seg[2]!;
    let by = seg[3]!;
    ax -= x0;
    ay -= y0;
    bx -= x0;
    by -= y0;
    // Liang–Barsky against [−400, CHUNK + 400]².
    const lo = -400;
    const hi = CHUNK + 400;
    let t0 = 0;
    let t1 = 1;
    const dx = bx - ax;
    const dy = by - ay;
    for (const [p, qq] of [
      [-dx, ax - lo],
      [dx, hi - ax],
      [-dy, ay - lo],
      [dy, hi - ay],
    ] as const) {
      if (p === 0) {
        if (qq < 0) t1 = -1;
      } else {
        const r = qq / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (t0 > t1) return NO_SEGMENT;
    const n = local.size;
    local.set(k, n);
    const o = segBase + n * SEG_WORDS;
    out[o] = (q(ax + dx * t0) | (q(ay + dy * t0) << 16)) >>> 0;
    out[o + 1] = (q(ax + dx * t1) | (q(ay + dy * t1) << 16)) >>> 0;
    out[o + 2] = (Math.min(255, Math.round(hw * 16)) | (kind << 8)) >>> 0;
    return n;
  };
  for (let j = 0; j < T; j++) {
    for (let i = 0; i < T; i++) {
      const x = x0 + (i + 0.5) * step;
      const y = y0 + (j + 0.5) * step;
      const k = index.nearestSegment(x, y, STREET_REACH);
      const seg = k >= 0 ? add(k) : NO_SEGMENT;
      const b = index.blockAt(x, y);
      const ground = b >= 0 ? info[b * 4 + 1]! : NO_BLOCK;
      const district = b >= 0 ? info[b * 4]! : 255;
      out[j * T + i] = (seg | (ground << 16) | (district << 24)) >>> 0;
    }
  }
  return out;
}
