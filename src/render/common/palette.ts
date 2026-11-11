/**
 * Debug and biome color palettes. All colors are sRGB in [0, 1]; the globe
 * mesh converts them to linear when writing vertex colors.
 */
import { CUBE_FACE_COUNT } from '../../core/coords';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import { BIOME_COUNT, Biome } from '../../worldgen/biomes';
import { BOUNDARY_TYPE_COUNT, BoundaryType } from '../../worldgen/boundaries';

export type Rgb = [number, number, number];

function hex(h: number): Rgb {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
}

/** Stylized biome palette, indexed by Biome. */
export const BIOME_COLORS: readonly Rgb[] = (() => {
  const c: Rgb[] = new Array(BIOME_COUNT);
  c[Biome.DeepOcean] = hex(0x0d2a4f);
  c[Biome.Ocean] = hex(0x16477a);
  c[Biome.Shelf] = hex(0x2f7aa6);
  c[Biome.SeaIce] = hex(0xd8e6ee);
  c[Biome.IceSheet] = hex(0xf2f6fa);
  c[Biome.Tundra] = hex(0x8e9a82);
  c[Biome.Taiga] = hex(0x3f5f45);
  c[Biome.TemperateGrassland] = hex(0xa5b26a);
  c[Biome.TemperateForest] = hex(0x4f7d3a);
  c[Biome.TemperateRainforest] = hex(0x2f6a43);
  c[Biome.ColdDesert] = hex(0xb4a888);
  c[Biome.HotDesert] = hex(0xd9c18a);
  c[Biome.Shrubland] = hex(0xa89a5c);
  c[Biome.Savanna] = hex(0xb9ad55);
  c[Biome.TropicalSeasonalForest] = hex(0x5e8c32);
  c[Biome.TropicalRainforest] = hex(0x2c6b2a);
  c[Biome.Alpine] = hex(0x8a8580);
  return c;
})();

export const BOUNDARY_COLORS: readonly Rgb[] = (() => {
  const c: Rgb[] = new Array(BOUNDARY_TYPE_COUNT);
  c[BoundaryType.None] = [0, 0, 0];
  c[BoundaryType.Collision] = hex(0xe03a2f);
  c[BoundaryType.Cordillera] = hex(0xf08c22);
  c[BoundaryType.Trench] = hex(0x7a2fd0);
  c[BoundaryType.IslandArc] = hex(0xf0d020);
  c[BoundaryType.Ridge] = hex(0x30d0e0);
  c[BoundaryType.Rift] = hex(0x40e070);
  c[BoundaryType.Transform] = hex(0xd0d0d0);
  return c;
})();

/** Six well-separated hues, rotated and shuffled by the seed (debug view of the cube faces). */
export function faceColors(seed: WorldSeed): Rgb[] {
  const r = rng(seed, 'debug-face-colors');
  const offset = r.nextFloat();
  const hues = Array.from(
    { length: CUBE_FACE_COUNT },
    (_, i) => (offset + i / CUBE_FACE_COUNT) % 1,
  );
  for (let i = hues.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [hues[i], hues[j]] = [hues[j]!, hues[i]!];
  }
  return hues.map((h) => hsl(h, r.range(0.55, 0.75), r.range(0.45, 0.6)));
}

/** Distinct colors for plate ids via the golden angle. */
export function plateColor(id: number): Rgb {
  return hsl((id * 0.618034) % 1, 0.55, 0.55);
}

/** HSL (all in [0, 1]) to sRGB. */
export function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

function lerp3(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Piecewise-linear ramp over sorted stops. */
export function ramp(stops: readonly [number, Rgb][], x: number): Rgb {
  if (x <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [x1, c1] = stops[i]!;
    if (x <= x1) {
      const [x0, c0] = stops[i - 1]!;
      return lerp3(c0, c1, (x - x0) / (x1 - x0));
    }
  }
  return stops[stops.length - 1]![1];
}

/** Hypsometric tint on reference elevation (m). */
export const HEIGHT_RAMP: readonly [number, Rgb][] = [
  [-6000, hex(0x08183a)],
  [-3000, hex(0x123d72)],
  [-200, hex(0x2f7aa6)],
  [0, hex(0x7fb8c9)],
  [1, hex(0x4c7a3a)],
  [500, hex(0x8fa85a)],
  [1500, hex(0xc2a565)],
  [3000, hex(0x8a6a4a)],
  [4500, hex(0xf4f4f4)],
];

export const TEMPERATURE_RAMP: readonly [number, Rgb][] = [
  [-40, hex(0x2b2f8a)],
  [-15, hex(0x3d7fd8)],
  [0, hex(0xe8f0f4)],
  [15, hex(0xf2c94c)],
  [30, hex(0xc0392b)],
];

export const MOISTURE_RAMP: readonly [number, Rgb][] = [
  [0, hex(0xa0713a)],
  [0.35, hex(0xe0d090)],
  [0.6, hex(0x5aa050)],
  [1, hex(0x1f5fa0)],
];

/** Annual precipitation (mm/yr), log-like stops. */
export const PRECIPITATION_RAMP: readonly [number, Rgb][] = [
  [0, hex(0x8a5a2b)],
  [250, hex(0xd8c27a)],
  [600, hex(0xa8c86a)],
  [1200, hex(0x3f9a5a)],
  [2500, hex(0x1f6fa8)],
  [4000, hex(0x23307a)],
];

/** Seasonal half-range (K). */
export const SEASONS_RAMP: readonly [number, Rgb][] = [
  [0, hex(0x1f6f8b)],
  [5, hex(0x99d8c9)],
  [12, hex(0xf2e394)],
  [20, hex(0xe08a3c)],
  [30, hex(0x8b1e3f)],
];

/** Diverging ramp for uplift in reference meters. */
export const UPLIFT_RAMP: readonly [number, Rgb][] = [
  [-3500, hex(0x5b2a86)],
  [0, hex(0x707070)],
  [2000, hex(0xd9a441)],
  [5000, hex(0xc0392b)],
];

/** sRGB → linear, matching three's working color space for vertex colors. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
