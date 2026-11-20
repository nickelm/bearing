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
import { STREET_HALF_WIDTH } from './types';
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
  return {
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
    bounds: [x0, y0, x1, y1],
  };
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

/**
 * The field of chunk (ci, cj): texels of CHUNK / FIELD_TEXELS m, the chunk's corner at
 * (ci × CHUNK, cj × CHUNK) in the plan's frame.
 */
export function chunkField(index: FieldIndex, ci: number, cj: number): Uint32Array {
  const T = FIELD_TEXELS;
  const step = CHUNK / T;
  const out = new Uint32Array(T * T);
  const info = index.plan.blockInfo;
  for (let j = 0; j < T; j++) {
    for (let i = 0; i < T; i++) {
      const x = ci * CHUNK + (i + 0.5) * step;
      const y = cj * CHUNK + (j + 0.5) * step;
      const s = index.street(x, y, 31);
      const b = index.blockAt(x, y);
      const dist = Math.max(0, Math.min(255, Math.round(s.d * 4) + 128));
      const ground = b >= 0 ? info[b * 4 + 1]! : NO_BLOCK;
      const district = b >= 0 ? info[b * 4]! : 255;
      out[j * T + i] = (dist | (ground << 8) | (s.kind << 16) | (district << 24)) >>> 0;
    }
  }
  return out;
}
