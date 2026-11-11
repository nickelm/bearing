/**
 * Land-cover features (decision 95): deserts, major forests and wetlands as
 * components of biome classes above a size threshold.
 *
 * - **Deserts.** Hot and cold desert cells; `measure` is the hot (sand) share, so
 *   dune glyphs can skip cold deserts (decision 81).
 * - **Wetlands.** The world has no wetland biome, so wetlands are flat, low,
 *   well-watered land: reference slope under 0.012 and height under 250 m, not
 *   desert or ice, and next to a river of at least WETLAND_DISCHARGE, a lake, or
 *   (below 60 m) the coast.
 * - **Forests.** Forest biome cells outside wetlands.
 */
import { Biome } from '../biomes';
import { FeatureKind } from '../strategic/graph';
import type { FeatureBuilder } from './builder';
import type { GeographyInput } from './context';
import { cellArea, components, regionShape } from './shape';

export const DESERT_MIN_AREA = 15_000e6;
export const FOREST_MIN_AREA = 20_000e6;
export const WETLAND_MIN_AREA = 1_500e6;
export const WETLAND_DISCHARGE = 150;

const FOREST = new Set<number>([
  Biome.Taiga,
  Biome.TemperateForest,
  Biome.TemperateRainforest,
  Biome.TropicalSeasonalForest,
  Biome.TropicalRainforest,
]);
const DRY_OR_ICE = new Set<number>([
  Biome.ColdDesert,
  Biome.HotDesert,
  Biome.IceSheet,
  Biome.Alpine,
  Biome.SeaIce,
]);

export function wetlandMask(input: GeographyInput): Uint8Array {
  const { grid, height, biome, slope, reliefScale, discharge, lakeDepth } = input.ctx;
  const out = new Uint8Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    const h = height[c]! / reliefScale;
    if (height[c]! <= 0 || lakeDepth[c]! > 0 || h >= 250 || slope[c]! >= 0.012) continue;
    if (DRY_OR_ICE.has(biome[c]!)) continue;
    let wet = discharge[c]! >= WETLAND_DISCHARGE;
    for (let k = 0; k < 8 && !wet; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      if (nb < 0) continue;
      if (lakeDepth[nb]! > 0 && height[nb]! > 0) wet = true;
      else if (height[nb]! <= 0 && h < 60) wet = true;
      else if (discharge[nb]! >= WETLAND_DISCHARGE) wet = true;
    }
    if (wet) out[c] = 1;
  }
  return out;
}

export function extractCover(input: GeographyInput, fb: FeatureBuilder, region: Int32Array): void {
  const { grid, height, biome, radius } = input.ctx;
  const N = grid.cellCount;
  const wet = wetlandMask(input);
  const add = (kind: FeatureKind, mask: Uint8Array, minArea: number) => {
    for (const cells of components(grid, mask)) {
      const a = cellArea(grid, cells, radius);
      if (a < minArea) continue;
      const set = new Set(cells);
      const shape = regionShape(grid, cells, (c) => set.has(c), radius);
      let top = 0;
      let hot = 0;
      for (const c of cells) {
        top = Math.max(top, height[c]!);
        if (biome[c] === Biome.HotDesert) hot++;
      }
      fb.add({
        kind,
        anchor: shape.anchor,
        extent: shape.extent,
        size: a,
        height: top,
        measure: kind === FeatureKind.Desert ? hot / cells.length : 0,
        magnitude: a,
        region: region[shape.anchorCell]!,
        polyline: shape.axis,
        cells,
      });
    }
  };
  const desert = new Uint8Array(N);
  const forest = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (height[c]! <= 0) continue;
    const b = biome[c]!;
    if (b === Biome.HotDesert || b === Biome.ColdDesert) desert[c] = 1;
    if (FOREST.has(b) && !wet[c]) forest[c] = 1;
  }
  add(FeatureKind.Desert, desert, DESERT_MIN_AREA);
  add(FeatureKind.Forest, forest, FOREST_MIN_AREA);
  add(FeatureKind.Wetland, wet, WETLAND_MIN_AREA);
}
