/**
 * Per-cell debug colors for each view mode (sRGB). This module is pure, with
 * no Three.js imports, so the globe mesh and the offline map renderer
 * (tools/) color worlds identically.
 */
import type { World } from '../worldgen/pipeline';
import {
  BIOME_COLORS,
  BOUNDARY_COLORS,
  HEIGHT_RAMP,
  MOISTURE_RAMP,
  TEMPERATURE_RAMP,
  UPLIFT_RAMP,
  plateColor,
  ramp,
} from './palette';
import type { Rgb } from './palette';

export const VIEW_MODES = [
  'biome',
  'height',
  'plates',
  'boundaries',
  'crust',
  'uplift',
  'temperature',
  'moisture',
  'faces',
] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

const LAND_GRAY: Rgb = [0.55, 0.55, 0.52];
const OCEAN_GRAY: Rgb = [0.18, 0.22, 0.28];
const CONTINENTAL: Rgb = [0.72, 0.6, 0.42];
const OCEANIC: Rgb = [0.15, 0.3, 0.5];

/**
 * Color of cell `c` in `mode`. `faceColor` is used for the 'faces' mode and
 * whenever no world is available.
 */
export function cellColor(mode: ViewMode, world: World | null, c: number, faceColor: Rgb): Rgb {
  if (!world || mode === 'faces') return faceColor;
  const m = world.maps;
  const land = m.height[c] > 0;
  switch (mode) {
    case 'biome':
      return BIOME_COLORS[m.biome[c]]!;
    case 'height':
      return ramp(HEIGHT_RAMP, m.height[c] / world.info.reliefScale);
    case 'plates': {
      const p = plateColor(m.plate[c]);
      return land ? p : [p[0] * 0.55, p[1] * 0.55, p[2] * 0.65];
    }
    case 'boundaries': {
      const t = m.boundary[c];
      if (t !== 0) return BOUNDARY_COLORS[t]!;
      return land ? LAND_GRAY : OCEAN_GRAY;
    }
    case 'crust':
      return m.continentalness[c] > 0 ? CONTINENTAL : OCEANIC;
    case 'uplift':
      return ramp(UPLIFT_RAMP, m.uplift[c]);
    case 'temperature':
      return ramp(TEMPERATURE_RAMP, m.temperature[c]);
    case 'moisture':
      return land ? ramp(MOISTURE_RAMP, m.moisture[c]) : OCEAN_GRAY;
  }
}
