/**
 * Ground movement over the coarse grid (milestone 5): a cost multiplier per
 * cell from slope, terrain and water, and the river geometry roads need to
 * find their bridges.
 *
 * The cost is a multiplier on distance (1 on flat open ground), Infinity at
 * sea and on lakes. Rivers do not raise a cell's cost: crossing one costs a
 * bridge, which the road search charges per crossing step (see roads.ts).
 */
import { Biome } from '../biomes';
import { riverWidth } from '../rivers';
import type { StrategicContext } from './input';

/** Rivers at least this wide (m) need a bridge; narrower ones are culverts and fords. */
export const BRIDGE_MIN_WIDTH = 25;
/** Discharge (m³/s) of a river BRIDGE_MIN_WIDTH wide (w = 4·√Q). */
export const BRIDGE_MIN_DISCHARGE = (BRIDGE_MIN_WIDTH / 4) ** 2;

/** Extra cost per biome, added to the base of 1. */
const BIOME_COST: Partial<Record<number, number>> = {
  [Biome.IceSheet]: 6,
  [Biome.Alpine]: 2.5,
  [Biome.Tundra]: 0.5,
  [Biome.Taiga]: 0.4,
  [Biome.TemperateRainforest]: 0.6,
  [Biome.TropicalRainforest]: 1,
  [Biome.TropicalSeasonalForest]: 0.4,
  [Biome.HotDesert]: 0.3,
  [Biome.ColdDesert]: 0.3,
};

/**
 * Movement cost multiplier per cell: 1 + 10 × reference slope + biome cost +
 * 0.5 × forest density; Infinity at sea and on lakes.
 */
export function movementCost(ctx: StrategicContext): Float32Array {
  const { grid, biome, lakeDepth, slope, forest } = ctx;
  const label = ctx.labels.label;
  const out = new Float32Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    if (label[c]! < 0 || lakeDepth[c]! > 0) {
      out[c] = Infinity;
      continue;
    }
    out[c] = 1 + 10 * slope[c]! + (BIOME_COST[biome[c]!] ?? 0) + 0.5 * forest[c]!;
  }
  return out;
}

/** River geometry on the coarse grid: which cells need a bridge, and the river's local direction. */
export class RiverGeometry {
  /** Main upstream cell (largest discharge among donors), −1 at sources. */
  readonly upstream: Int32Array;

  constructor(private readonly ctx: StrategicContext) {
    const { grid, discharge, receiver } = ctx;
    this.upstream = new Int32Array(grid.cellCount).fill(-1);
    for (let c = 0; c < grid.cellCount; c++) {
      const r = receiver[c]!;
      if (r < 0 || !this.isBridged(c)) continue;
      const u = this.upstream[r]!;
      if (u < 0 || discharge[c]! > discharge[u]! || (discharge[c] === discharge[u] && c < u)) {
        this.upstream[r] = c;
      }
    }
  }

  /** True for land cells whose river needs a bridge to cross. */
  isBridged(c: number): boolean {
    return (
      this.ctx.labels.label[c]! >= 0 &&
      this.ctx.lakeDepth[c]! <= 0 &&
      this.ctx.discharge[c]! >= BRIDGE_MIN_DISCHARGE
    );
  }

  width(c: number): number {
    return riverWidth(this.ctx.discharge[c]!);
  }

  /** True if cells a and b are consecutive along a bridged river (either direction). */
  flowsBetween(a: number, b: number): boolean {
    const r = this.ctx.receiver;
    return (r[a] === b && this.isBridged(a)) || (r[b] === a && this.isBridged(b));
  }

  /**
   * Which side of the river through cell `c` cell `x` lies on: +1 or −1, or 0
   * if `x` lies along the river (its upstream or downstream cell).
   */
  side(c: number, x: number): number {
    const { grid, receiver } = this.ctx;
    const g = grid.centers;
    const d = receiver[c]!;
    const u = this.upstream[c]!;
    if (x === d || x === u) return 0;
    const cx = g[c * 3]!;
    const cy = g[c * 3 + 1]!;
    const cz = g[c * 3 + 2]!;
    // Flow tangent: toward the downstream cell, from the upstream cell when there is one.
    const from = u >= 0 ? u : c;
    const to = d >= 0 ? d : c;
    const tx = g[to * 3]! - g[from * 3]!;
    const ty = g[to * 3 + 1]! - g[from * 3 + 1]!;
    const tz = g[to * 3 + 2]! - g[from * 3 + 2]!;
    const vx = g[x * 3]! - cx;
    const vy = g[x * 3 + 1]! - cy;
    const vz = g[x * 3 + 2]! - cz;
    // (t × v) · up
    const s = (ty * vz - tz * vy) * cx + (tz * vx - tx * vz) * cy + (tx * vy - ty * vx) * cz;
    return s > 0 ? 1 : s < 0 ? -1 : 0;
  }
}
