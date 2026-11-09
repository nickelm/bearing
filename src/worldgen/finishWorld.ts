/**
 * CPU stages that follow GPU erosion, run in the worldgen worker:
 * drainage (flow, discharge, lakes), river extraction and biomes on the
 * global grid, then a downsample to the display resolution, which the
 * milestone-1 globe renders until tiles exist.
 */
import { Biome, classifyBiome } from './biomes';
import { LAPSE_RATE, potentialEvapotranspiration } from './climate';
import { computeDrainage } from './drainage';
import type { Drainage } from './drainage';
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
}

export interface DisplayMaps {
  height: Float32Array;
  biome: Uint8Array;
  /** Largest discharge in each display cell (m³/s). */
  discharge: Float32Array;
  /** Deepest lake in each display cell (m). */
  lakeDepth: Float32Array;
}

export interface FinishResult {
  drainage: Drainage;
  rivers: Rivers;
  /** Biome per global cell. */
  biome: Uint8Array;
  display: DisplayMaps;
  timings: { stage: string; ms: number }[];
}

export function globalBiomes(input: FinishInput, lakeDepth: Float32Array): Uint8Array {
  const { height, precipitation, seaLevelTemperature, temperatureRange, reliefScale } = input;
  const out = new Uint8Array(height.length);
  for (let c = 0; c < height.length; c++) {
    const h = height[c]!;
    const ref = h / reliefScale;
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

/** Box-downsamples global maps to the display grid (biome: the block's center cell). */
export function downsampleForDisplay(
  n: number,
  displayN: number,
  height: Float32Array,
  biome: Uint8Array,
  discharge: Float32Array,
  lakeDepth: Float32Array,
): DisplayMaps {
  if (n % displayN !== 0) throw new RangeError(`Display grid ${displayN} does not divide ${n}`);
  const k = n / displayN;
  const m = 6 * displayN * displayN;
  const out: DisplayMaps = {
    height: new Float32Array(m),
    biome: new Uint8Array(m),
    discharge: new Float32Array(m),
    lakeDepth: new Float32Array(m),
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
    computeDrainage(input.n, input.height, input.runoff, input.radius),
  );
  const rivers = time('rivers', () =>
    extractRivers(input.n, input.height, drainage.receiver, drainage.discharge),
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
    ),
  );
  return { drainage, rivers, biome, display, timings };
}
