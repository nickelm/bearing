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
/** Step (m) of the walk around a band's border, and its margin outside it. */
const EDGE_STEP = 150;

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
    const add = (t: number, c: number) => {
      frame.toSphere(pa[0] + ux * t - uy * c, pa[1] + uy * t + ux * c, at);
      const k = tileForDirection(at, ALIGN_LEVEL);
      keys.set(tileKeyString(k), k);
    };
    for (let p = 0; p <= nAlong; p++) {
      const t = -band + ((L + 2 * band) * p) / nAlong;
      for (let q = 0; q <= nAcross; q++) add(t, -band + (2 * band * q) / nAcross);
    }
    // A tile can cut a corner into the band between two samples: walk its border finely
    // (it did: 93 lookups off the tiles in 120 links of seed 1983, decision 190).
    const nEdge = Math.ceil((L + 2 * band) / EDGE_STEP);
    for (let p = 0; p <= nEdge; p++) {
      const t = -band + ((L + 2 * band) * p) / nEdge;
      add(t, -band - EDGE_STEP);
      add(t, band + EDGE_STEP);
    }
    const nSide = Math.ceil((2 * band) / EDGE_STEP);
    for (let q = 0; q <= nSide; q++) {
      const c = -band + (2 * band * q) / nSide;
      add(-band - EDGE_STEP, c);
      add(L + band + EDGE_STEP, c);
    }
  }
  return [...keys.values()];
}

/** One tile's ground for the router: heights and the cover byte per sample (`groundCover`). */
export interface TileGround {
  /** TILE_STRIDE² heights (m). */
  height: Float32Array;
  /** TILE_STRIDE² cover bytes; none reads as open, dry ground. */
  cover?: Uint8Array;
}

/** Cover bit: open water (a lake, or the sea's biomes). Rivers come as segments instead. */
export const COVER_WATER = 1;

/**
 * Cover bytes from a tile's packed materials (tileSynth.ts): bit 0 open water
 * (the lake bit, or biome DeepOcean, Ocean or Shelf), bits 1–7 forest density
 * (0..127) (decision 190).
 */
export function groundCover(material: Uint32Array): Uint8Array {
  const out = new Uint8Array(material.length);
  for (let i = 0; i < material.length; i++) {
    const m = material[i]!;
    const biome = m & 0xff;
    const water = (m >>> 16) & 1 || biome <= 2 ? COVER_WATER : 0;
    out[i] = water | ((m >>> 25) << 1);
  }
  return out;
}

/** Forest density 0..1 from a cover byte. */
export function coverForest(c: number): number {
  return (c >>> 1) / 127;
}

/**
 * Ground at a unit direction from level-`level` tiles by key string: height (m),
 * bilinear, and the cover byte of the nearest sample; `missing` counts lookups
 * outside the tiles given (they read 0).
 */
export function tileHeightSampler(
  tiles: ReadonlyMap<string, TileGround>,
  level = ALIGN_LEVEL,
): {
  height: (d: Readonly<Vec3d>) => number;
  cover: (d: Readonly<Vec3d>) => number;
  missing: () => number;
} {
  let missing = 0;
  const size = TILE_TEXELS * (1 << level);
  const locate = (d: Readonly<Vec3d>) => {
    const key = tileForDirection(d, level);
    const t = tiles.get(tileKeyString(key));
    if (!t) {
      missing++;
      return null;
    }
    const uv = directionToCubeFace(d);
    const fx =
      Math.min(TILE_TEXELS + 1, Math.max(-1, uv.u * size - key.x * TILE_TEXELS)) + TILE_BORDER;
    const fy =
      Math.min(TILE_TEXELS + 1, Math.max(-1, uv.v * size - key.y * TILE_TEXELS)) + TILE_BORDER;
    return { t, fx, fy };
  };
  return {
    missing: () => missing,
    height(d) {
      const l = locate(d);
      if (!l) return 0;
      const h = l.t.height;
      const x0 = Math.floor(l.fx);
      const y0 = Math.floor(l.fy);
      const tx = l.fx - x0;
      const ty = l.fy - y0;
      const i = y0 * TILE_STRIDE + x0;
      return (
        (h[i]! * (1 - tx) + h[i + 1]! * tx) * (1 - ty) +
        (h[i + TILE_STRIDE]! * (1 - tx) + h[i + TILE_STRIDE + 1]! * tx) * ty
      );
    },
    cover(d) {
      const l = locate(d);
      if (!l?.t.cover) return 0;
      return l.t.cover[Math.round(l.fy) * TILE_STRIDE + Math.round(l.fx)]!;
    },
  };
}
