/**
 * Landmass labeling: connected land components on the tectonic grid.
 *
 * `labelLandmasses` gives area and a most-inland cell per landmass (decision
 * 46), enough to anchor the calendar. `landmassStats` adds what the strategic
 * graph needs: centroid, coastline length, latitude span and terrain mix.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Biome } from './biomes';

export interface Landmass {
  /** Label in `LandmassLabels.label`. */
  id: number;
  /** Area in m². */
  area: number;
  cellCount: number;
  /** The cell farthest from the coast (in 4-neighbor steps); ties go to the lowest index. */
  interiorCell: number;
}

export interface LandmassLabels {
  /** Landmass id per cell, −1 at sea. */
  label: Int32Array;
  /** Sorted by area, largest first; ids are positions in this array. */
  landmasses: Landmass[];
}

/** Labels the connected components of `height > 0` over 4-neighbors. */
export function labelLandmasses(
  grid: CubeGrid,
  height: Float32Array,
  radius: number,
): LandmassLabels {
  const n = grid.cellCount;
  const raw = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const found: Landmass[] = [];
  for (let start = 0; start < n; start++) {
    if (height[start] <= 0 || raw[start] >= 0) continue;
    const id = found.length;
    let sp = 0;
    let area = 0;
    let count = 0;
    raw[start] = id;
    stack[sp++] = start;
    while (sp > 0) {
      const c = stack[--sp]!;
      area += grid.areas[c];
      count++;
      for (let k = 0; k < 4; k++) {
        const nb = grid.neighbors4[c * 4 + k]!;
        if (height[nb] > 0 && raw[nb] < 0) {
          raw[nb] = id;
          stack[sp++] = nb;
        }
      }
    }
    found.push({ id, area: area * radius * radius, cellCount: count, interiorCell: start });
  }

  // Distance from the coast by multi-source BFS from land cells next to the sea.
  const depth = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let c = 0; c < n; c++) {
    if (raw[c] < 0) continue;
    for (let k = 0; k < 4; k++) {
      if (raw[grid.neighbors4[c * 4 + k]!]! < 0) {
        depth[c] = 0;
        queue[tail++] = c;
        break;
      }
    }
  }
  while (head < tail) {
    const c = queue[head++]!;
    for (let k = 0; k < 4; k++) {
      const nb = grid.neighbors4[c * 4 + k]!;
      if (raw[nb] >= 0 && depth[nb] < 0) {
        depth[nb] = depth[c] + 1;
        queue[tail++] = nb;
      }
    }
  }
  const best = new Int32Array(found.length).fill(-1);
  for (let c = 0; c < n; c++) {
    const id = raw[c];
    if (id < 0) continue;
    // A landmass with no coast covers the whole planet; any cell will do.
    if (best[id] < 0 || depth[c] > depth[best[id]!]!) best[id] = c;
  }
  for (const m of found) m.interiorCell = best[m.id]!;

  // Sort largest first (ties by first cell, which is deterministic) and relabel.
  const sorted = [...found].sort((a, b) => b.area - a.area || a.id - b.id);
  const remap = new Int32Array(found.length);
  sorted.forEach((m, i) => {
    remap[m.id] = i;
    m.id = i;
  });
  const label = new Int32Array(n);
  for (let c = 0; c < n; c++) label[c] = raw[c] < 0 ? -1 : remap[raw[c]]!;
  return { label, landmasses: sorted };
}

/** Area fractions of a landmass by terrain class (each 0..1). */
export interface TerrainMix {
  /** Flat lowland: reference slope under 3 % and reference height under 500 m. */
  plains: number;
  /** Neither plains nor mountains. */
  hills: number;
  /** Reference height above 1,500 m or reference slope above 10 %. */
  mountains: number;
  /** Forest biomes (temperate, boreal, tropical). */
  forest: number;
  /** Hot and cold deserts. */
  desert: number;
  /** Ice sheet, alpine and tundra. */
  ice: number;
}

export interface LandmassStats {
  id: number;
  area: number;
  /** Area-weighted mean direction, normalized: a unit vector. */
  centroid: [number, number, number];
  /** Coastline length on the grid (m): land–sea cell edges times the edge length. */
  coastlineLength: number;
  /** Southernmost and northernmost cell-center latitudes (rad). */
  latMin: number;
  latMax: number;
  terrain: TerrainMix;
}

/** Reference slope classes for TerrainMix (rise over run, after dividing out reliefScale). */
export const PLAINS_MAX_SLOPE = 0.03;
export const PLAINS_MAX_HEIGHT = 500;
export const MOUNTAIN_MIN_SLOPE = 0.1;
export const MOUNTAIN_MIN_HEIGHT = 1500;

/**
 * Reference slope per cell: the steepest rise or fall to a 4-neighbor, in
 * reference meters per meter (physical height ÷ reliefScale, decision 14).
 * Sea cells count as height 0, so coasts are not cliffs.
 */
export function referenceSlope(
  grid: CubeGrid,
  height: Float32Array,
  reliefScale: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    const h = Math.max(0, height[c]!);
    const run = Math.sqrt(grid.areas[c]!) * radius;
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const nb = grid.neighbors4[c * 4 + k]!;
      s = Math.max(s, Math.abs(Math.max(0, height[nb]!) - h));
    }
    out[c] = s / reliefScale / run;
  }
  return out;
}

const FOREST_BIOMES = new Set<number>([
  Biome.Taiga,
  Biome.TemperateForest,
  Biome.TemperateRainforest,
  Biome.TropicalSeasonalForest,
  Biome.TropicalRainforest,
]);
const DESERT_BIOMES = new Set<number>([Biome.ColdDesert, Biome.HotDesert]);
const ICE_BIOMES = new Set<number>([Biome.IceSheet, Biome.Tundra, Biome.Alpine]);

/**
 * Statistics per labeled landmass (milestone 4): centroid, coastline length,
 * latitude span and terrain mix. Biome ids follow `Biome` in biomes.ts.
 */
export function landmassStats(
  grid: CubeGrid,
  labels: LandmassLabels,
  height: Float32Array,
  biome: Uint8Array,
  slope: Float32Array,
  reliefScale: number,
  radius: number,
): LandmassStats[] {
  const k = labels.landmasses.length;
  const cx = new Float64Array(k);
  const cy = new Float64Array(k);
  const cz = new Float64Array(k);
  const coast = new Float64Array(k);
  const latMin = new Float64Array(k).fill(Infinity);
  const latMax = new Float64Array(k).fill(-Infinity);
  const mix = Array.from({ length: k }, () => new Float64Array(6));
  const c3 = grid.centers;
  for (let c = 0; c < grid.cellCount; c++) {
    const id = labels.label[c]!;
    if (id < 0) continue;
    const a = grid.areas[c]!;
    cx[id] += c3[c * 3]! * a;
    cy[id] += c3[c * 3 + 1]! * a;
    cz[id] += c3[c * 3 + 2]! * a;
    const lat = Math.asin(Math.max(-1, Math.min(1, c3[c * 3 + 1]!)));
    latMin[id] = Math.min(latMin[id]!, lat);
    latMax[id] = Math.max(latMax[id]!, lat);
    const edge = Math.sqrt(a) * radius;
    for (let j = 0; j < 4; j++) {
      if (labels.label[grid.neighbors4[c * 4 + j]!]! < 0) coast[id] += edge;
    }
    const ref = height[c]! / reliefScale;
    const s = slope[c]!;
    const m = mix[id]!;
    if (ref >= MOUNTAIN_MIN_HEIGHT || s >= MOUNTAIN_MIN_SLOPE) m[2] += a;
    else if (ref < PLAINS_MAX_HEIGHT && s < PLAINS_MAX_SLOPE) m[0] += a;
    else m[1] += a;
    const b = biome[c]!;
    if (FOREST_BIOMES.has(b)) m[3] += a;
    if (DESERT_BIOMES.has(b)) m[4] += a;
    if (ICE_BIOMES.has(b)) m[5] += a;
  }
  return labels.landmasses.map((lm) => {
    const id = lm.id;
    const len = Math.hypot(cx[id]!, cy[id]!, cz[id]!) || 1;
    const sr = lm.area / (radius * radius);
    const m = mix[id]!;
    return {
      id,
      area: lm.area,
      centroid: [cx[id]! / len, cy[id]! / len, cz[id]! / len],
      coastlineLength: coast[id]!,
      latMin: latMin[id]!,
      latMax: latMax[id]!,
      terrain: {
        plains: m[0]! / sr,
        hills: m[1]! / sr,
        mountains: m[2]! / sr,
        forest: m[3]! / sr,
        desert: m[4]! / sr,
        ice: m[5]! / sr,
      },
    };
  });
}
