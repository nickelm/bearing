/**
 * What the strategic graph builder reads: the coarse pass's maps (decision 52
 * lets the builder, and only the builder, read world data).
 */
import type { CubeGrid } from '../../core/cubeGrid';
import type { WorldSeed } from '../../core/rng';
import { Biome } from '../biomes';
import { FOREST_BASE } from '../forest';
import type { LandmassLabels, LandmassStats } from '../landmasses';

export interface StrategicInput {
  grid: CubeGrid;
  /** Physical height above sea level (m). */
  height: Float32Array;
  biome: Uint8Array;
  /** River discharge leaving each cell (m³/s), from drainage on the coarse grid. */
  discharge: Float32Array;
  /** Lake depth (m). */
  lakeDepth: Float32Array;
  reliefScale: number;
  radius: number;
  /**
   * Downstream cell per cell from drainage (−1 at sea). Without it, the
   * builder uses steepest descent.
   */
  receiver?: Int32Array;
  /** Boundary uplift (reference m), for mountain ranges; optional. */
  uplift?: Float32Array;
  /** World seed for the stages that draw random numbers (settlements). Default 0. */
  seed?: WorldSeed;
}

/** Derived per-cell fields shared by the builder's stages. */
export interface StrategicContext extends StrategicInput {
  labels: LandmassLabels;
  stats: LandmassStats[];
  /** Reference slope per cell (see landmasses.ts). */
  slope: Float32Array;
  /** Forest base density 0..1 per cell (decision 44). */
  forest: Float32Array;
  /** Cell edge length (m) of an average cell. */
  cellSize: number;
  /** Downstream cell per land cell (−1 at sea or where none is lower). */
  receiver: Int32Array;
}

/** Steepest-descent receivers over 8-neighbors, for inputs without drainage. */
export function steepestDescent(grid: CubeGrid, height: Float32Array): Int32Array {
  const out = new Int32Array(grid.cellCount).fill(-1);
  for (let c = 0; c < grid.cellCount; c++) {
    if (height[c]! <= 0) continue;
    let best = -1;
    let drop = 0;
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      if (nb < 0) continue;
      const d = (height[c]! - height[nb]!) / grid.angleBetween(c, nb);
      if (d > drop) {
        drop = d;
        best = nb;
      }
    }
    out[c] = best;
  }
  return out;
}

export function forestDensity(biome: Uint8Array): Float32Array {
  const out = new Float32Array(biome.length);
  for (let c = 0; c < biome.length; c++) out[c] = FOREST_BASE[biome[c] as Biome] ?? 0;
  return out;
}

/** Visits cells within an angular radius of a start cell, breadth first through 8-neighbors. */
export class CapWalker {
  private readonly stamp: Int32Array;
  private readonly queue: Int32Array;
  private round = 0;

  constructor(private readonly grid: CubeGrid) {
    this.stamp = new Int32Array(grid.cellCount);
    this.queue = new Int32Array(grid.cellCount);
  }

  /**
   * Calls `visit(cell)` for every cell whose center lies within `angle` (rad)
   * of `start`'s center and is connected to it through cells that pass
   * `through` (default: all). `start` is always visited.
   */
  walk(
    start: number,
    angle: number,
    visit: (cell: number) => void,
    through?: (cell: number) => boolean,
  ): void {
    const g = this.grid;
    const c3 = g.centers;
    const sx = c3[start * 3]!;
    const sy = c3[start * 3 + 1]!;
    const sz = c3[start * 3 + 2]!;
    const minDot = Math.cos(angle);
    const r = ++this.round;
    let head = 0;
    let tail = 0;
    this.stamp[start] = r;
    this.queue[tail++] = start;
    while (head < tail) {
      const c = this.queue[head++]!;
      visit(c);
      for (let k = 0; k < 8; k++) {
        const nb = g.neighbors8[c * 8 + k]!;
        if (nb < 0 || this.stamp[nb] === r) continue;
        this.stamp[nb] = r;
        if (sx * c3[nb * 3]! + sy * c3[nb * 3 + 1]! + sz * c3[nb * 3 + 2]! < minDot) continue;
        if (through && !through(nb)) continue;
        this.queue[tail++] = nb;
      }
    }
  }
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
