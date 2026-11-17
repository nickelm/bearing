/**
 * CPU stages that follow GPU erosion, run in the worldgen worker:
 * drainage (flow, discharge, lakes), river extraction and biomes on the
 * global grid, then a downsample to the display resolution, which the
 * milestone-1 globe renders until tiles exist.
 */
import { Biome, classifyBiome } from './biomes';
import { earthElevation, LAPSE_RATE, potentialEvapotranspiration } from './climate';
import { computeDrainage } from './drainage';
import type { Drainage } from './drainage';
import { forestMaps } from './forest';
import { computeChannels } from './channels/channels';
import type { Channels } from './channels/channels';
import { extractRivers } from './rivers';
import type { Rivers } from './rivers';

export interface FinishInput {
  /** Global grid cells per face edge. */
  n: number;
  /** Eroded physical height (m). */
  height: Float32Array;
  /** Upsampled climate maps on the global grid. */
  runoff: Float32Array;
  precipitation: Float32Array;
  /** Annual mean temperature reduced to sea level (°C). */
  seaLevelTemperature: Float32Array;
  temperatureRange: Float32Array;
  reliefScale: number;
  radius: number;
  /** Display grid cells per face edge; must divide n. */
  displayN: number;
  /**
   * Valley floor (physical m) for the Earth-like elevation (decision 122):
   * the floor at the planet's scale, the landform above it at Earth's. Without
   * it, elevation is height ÷ reliefScale.
   */
  valleyFloor?: Float32Array;
  /**
   * Terrain province and rock on the tectonic grid (decision 204), with its
   * cells per face edge (n must be a multiple); absent in worlds stored before them.
   */
  tectonic?: { n: number; province: Uint8Array; lithology: Uint8Array };
}

export interface DisplayMaps {
  height: Float32Array;
  biome: Uint8Array;
  /** Largest discharge in each display cell (m³/s). */
  discharge: Float32Array;
  /** Deepest lake in each display cell (m). */
  lakeDepth: Float32Array;
  /** Mean valley floor in each display cell (physical m, decision 122); absent without one. */
  valleyFloor?: Float32Array;
}

export interface FinishResult {
  drainage: Drainage;
  rivers: Rivers;
  /** Migrated large lowland rivers and their oxbows (decision 173); absent in worlds stored before it. */
  channels?: Channels;
  /** Biome per global cell. */
  biome: Uint8Array;
  /** Forest base density per global cell, 0..255 (decision 44). */
  forest: Uint8Array;
  /** Treeline height per global cell (physical m). */
  treeline: Float32Array;
  /** Terrain province and rock per global cell (decision 204); absent in worlds stored before them. */
  province?: Uint8Array;
  lithology?: Uint8Array;
  display: DisplayMaps;
  timings: { stage: string; ms: number }[];
}

export function globalBiomes(input: FinishInput, lakeDepth: Float32Array): Uint8Array {
  const { height, precipitation, seaLevelTemperature, temperatureRange, reliefScale } = input;
  const out = new Uint8Array(height.length);
  for (let c = 0; c < height.length; c++) {
    const h = height[c]!;
    // Sea depths in reference meters; land at its Earth-like elevation (decision 122).
    const ref =
      h > 0 ? earthElevation(h, input.valleyFloor?.[c] ?? h, reliefScale) : h / reliefScale;
    const t = seaLevelTemperature[c]! - LAPSE_RATE * Math.max(0, ref);
    const moisture = Math.min(
      1,
      Math.max(0, (0.5 * precipitation[c]!) / potentialEvapotranspiration(t)),
    );
    // Lakes take the shelf color: shallow fresh water.
    out[c] =
      lakeDepth[c]! > 0
        ? Biome.Shelf
        : classifyBiome(h, ref, t, moisture, t - temperatureRange[c]!);
  }
  return out;
}

/** Annual mean temperature at each global cell's Earth-like elevation (°C, decision 122). */
export function cellTemperature(input: FinishInput): Float32Array {
  const { height, seaLevelTemperature, reliefScale } = input;
  const out = new Float32Array(height.length);
  for (let c = 0; c < height.length; c++) {
    const h = height[c]!;
    const ref = h > 0 ? earthElevation(h, input.valleyFloor?.[c] ?? h, reliefScale) : 0;
    out[c] = seaLevelTemperature[c]! - LAPSE_RATE * ref;
  }
  return out;
}

/** Box-downsamples global maps to the display grid (biome: the block's center cell). */
export function downsampleForDisplay(
  n: number,
  displayN: number,
  height: Float32Array,
  biome: Uint8Array,
  discharge: Float32Array,
  lakeDepth: Float32Array,
  valleyFloor?: Float32Array,
): DisplayMaps {
  if (n % displayN !== 0) throw new RangeError(`Display grid ${displayN} does not divide ${n}`);
  const k = n / displayN;
  const m = 6 * displayN * displayN;
  const out: DisplayMaps = {
    height: new Float32Array(m),
    biome: new Uint8Array(m),
    discharge: new Float32Array(m),
    lakeDepth: new Float32Array(m),
    ...(valleyFloor ? { valleyFloor: new Float32Array(m) } : {}),
  };
  const w = 1 / (k * k);
  const mid = k >> 1;
  for (let face = 0; face < 6; face++) {
    for (let j = 0; j < n; j++) {
      const dj = Math.floor(j / k);
      for (let i = 0; i < n; i++) {
        const c = (face * n + j) * n + i;
        const di = Math.floor(i / k);
        const d = (face * displayN + dj) * displayN + di;
        out.height[d] += height[c]! * w;
        if (valleyFloor) out.valleyFloor![d] += valleyFloor[c]! * w;
        if (discharge[c]! > out.discharge[d]!) out.discharge[d] = discharge[c]!;
        if (lakeDepth[c]! > out.lakeDepth[d]!) out.lakeDepth[d] = lakeDepth[c]!;
        if (i % k === mid && j % k === mid) out.biome[d] = biome[c]!;
      }
    }
  }
  return out;
}

export function finishWorld(input: FinishInput): FinishResult {
  const timings: { stage: string; ms: number }[] = [];
  const time = <T>(stage: string, fn: () => T): T => {
    const t0 = performance.now();
    const r = fn();
    timings.push({ stage, ms: performance.now() - t0 });
    return r;
  };
  const drainage = time('drainage', () =>
    computeDrainage(input.n, input.height, input.runoff, input.radius, {
      temperature: cellTemperature(input),
      precipitation: input.precipitation,
    }),
  );
  const rivers = time('rivers', () =>
    extractRivers(input.n, input.height, drainage.receiver, drainage.discharge),
  );
  const channels = time('channels', () =>
    computeChannels(rivers, {
      height: input.height,
      lakeDepth: drainage.lakeDepth,
      radius: input.radius,
    }),
  );
  const biome = time('global biomes', () => globalBiomes(input, drainage.lakeDepth));
  const display = time('display downsample', () =>
    downsampleForDisplay(
      input.n,
      input.displayN,
      input.height,
      biome,
      drainage.discharge,
      drainage.lakeDepth,
      input.valleyFloor,
    ),
  );
  const { forest, treeline } = time('forest', () => forestMaps(input, biome));
  const tect = input.tectonic;
  const province = tect ? upsampleNearest(tect.province, tect.n, input.n) : undefined;
  const lithology = tect ? upsampleNearest(tect.lithology, tect.n, input.n) : undefined;
  return {
    drainage,
    rivers,
    channels,
    biome,
    forest,
    treeline,
    province,
    lithology,
    display,
    timings,
  };
}

/**
 * A tectonic-grid byte map on the global grid: each global cell takes the
 * tectonic cell it lies in (both grids share the faces' warp, and n is a
 * multiple of the tectonic n).
 */
export function upsampleNearest(src: Uint8Array, from: number, to: number): Uint8Array {
  const out = new Uint8Array(6 * to * to);
  const k = to / from;
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < to; j++) {
      const sj = Math.min(from - 1, Math.floor(j / k));
      for (let i = 0; i < to; i++) {
        const si = Math.min(from - 1, Math.floor(i / k));
        out[(f * to + j) * to + i] = src[(f * from + sj) * from + si]!;
      }
    }
  }
  return out;
}
