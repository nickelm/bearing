/**
 * Per-cell debug colors for each view mode (sRGB). This module is pure, with
 * no Three.js imports, so the globe mesh and the offline map renderer
 * (tools/) color worlds identically.
 */
import type { World } from '../../worldgen/pipeline';
import {
  BIOME_COLORS,
  BOUNDARY_COLORS,
  HEIGHT_RAMP,
  MOISTURE_RAMP,
  PRECIPITATION_RAMP,
  SEASONS_RAMP,
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
  'precipitation',
  'seasons',
  'rivers',
  'provinces',
  'lithology',
  'faces',
] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

const LAND_GRAY: Rgb = [0.55, 0.55, 0.52];

/** Debug colors per terrain province (decision 204), in `Province` order. */
export const PROVINCE_COLORS: readonly Rgb[] = [
  [0.18, 0.22, 0.28], // none (ocean floor)
  [0.85, 0.2, 0.25], // young collision range
  [0.85, 0.55, 0.75], // high plateau
  [0.55, 0.35, 0.25], // old mountains
  [0.45, 0.5, 0.6], // shield
  [0.95, 0.6, 0.2], // basin and range
  [0.6, 0.15, 0.5], // rift
  [0.25, 0.2, 0.2], // volcanic arc
  [0.95, 0.35, 0.05], // hotspot
  [0.85, 0.8, 0.55], // sedimentary basin
  [0.6, 0.85, 0.85], // karst platform
  [0.8, 0.7, 0.35], // soft sediment
  [0.55, 0.7, 0.9], // glaciated lowland
];

/** Debug colors per rock (decision 204), in `Rock` order; layered rock is drawn lighter. */
export const ROCK_COLORS: readonly Rgb[] = [
  [0.18, 0.22, 0.28], // none
  [0.78, 0.72, 0.72], // granite and gneiss
  [0.45, 0.55, 0.45], // schist
  [0.85, 0.5, 0.3], // sandstone
  [0.45, 0.4, 0.5], // shale
  [0.92, 0.9, 0.8], // limestone
  [0.2, 0.2, 0.22], // basalt
  [0.5, 0.35, 0.35], // ash
  [0.88, 0.75, 0.45], // loess
  [0.6, 0.65, 0.75], // till
];
const OCEAN_GRAY: Rgb = [0.18, 0.22, 0.28];
const CONTINENTAL: Rgb = [0.72, 0.6, 0.42];
const OCEANIC: Rgb = [0.15, 0.3, 0.5];
const RIVER: Rgb = [0.12, 0.32, 0.85];
const LAKE: Rgb = [0.2, 0.45, 0.75];
/** Discharge (m³/s) at which the rivers view starts drawing a river. */
const RIVER_MIN = 20;

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
    case 'precipitation': {
      const p = ramp(PRECIPITATION_RAMP, m.precipitation[c]);
      return land ? p : [p[0] * 0.5, p[1] * 0.5, p[2] * 0.55];
    }
    case 'seasons':
      return ramp(SEASONS_RAMP, m.temperatureRange[c]);
    case 'provinces': {
      if (!m.province) return land ? LAND_GRAY : OCEAN_GRAY;
      const p = PROVINCE_COLORS[m.province[c]!] ?? LAND_GRAY;
      return land ? p : [p[0] * 0.5, p[1] * 0.5, p[2] * 0.55];
    }
    case 'lithology': {
      if (!m.lithology) return land ? LAND_GRAY : OCEAN_GRAY;
      const l = m.lithology[c]!;
      const r = ROCK_COLORS[l & 0x7f] ?? LAND_GRAY;
      const k = l & 0x80 ? 1.12 : 1;
      return land
        ? [Math.min(1, r[0] * k), Math.min(1, r[1] * k), Math.min(1, r[2] * k)]
        : OCEAN_GRAY;
    }
    case 'rivers': {
      // Biome under a blue river overlay that thickens with discharge.
      const b = BIOME_COLORS[m.biome[c]]!;
      if (!land) return b;
      if (m.lakeDepth[c] > 0) return LAKE;
      const q = m.discharge[c];
      if (q < RIVER_MIN) return [b[0] * 0.85, b[1] * 0.85, b[2] * 0.85];
      const t = Math.min(1, Math.log10(q / RIVER_MIN) / 2 + 0.35);
      return [
        b[0] + (RIVER[0] - b[0]) * t,
        b[1] + (RIVER[1] - b[1]) * t,
        b[2] + (RIVER[2] - b[2]) * t,
      ];
    }
  }
}
