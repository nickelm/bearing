/**
 * Relief exaggeration (Proposal 0010, decision 297): the stage after climate and
 * biomes. Checks at 1.0, 1.3 and 1.5 on the CPU path the global pass runs
 * (finishWorld on a tectonic world): biomes and forest unchanged, heights scaled on
 * land only, lakes level, the treeline on the same ground, river surfaces that
 * never rise downstream, and a road profile that keeps its grade on the scaled
 * ground. The tile kernel's side (samples are the unexaggerated tile stretched) is
 * in tests/gpu/reliefExaggeration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { LAPSE_RATE } from '../src/worldgen/climate';
import { riverInvariants } from '../src/worldgen/channels/invariants';
import { finishWorld } from '../src/worldgen/finishWorld';
import type { FinishInput, FinishResult } from '../src/worldgen/finishWorld';
import { designProfile } from '../src/worldgen/networks/alignment';
import { ROUTE_CLASSES } from '../src/worldgen/networks/router';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import {
  clampExaggeration,
  exaggeratedHeight,
  exaggerateRelief,
  unexaggeratedHeight,
} from '../src/worldgen/reliefExaggeration';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { neighbors8 } from '../src/worldgen/drainage';

const N = 64;
const SCALES = [1, 1.3, 1.5];
const params = { ...DEFAULT_PLANET_PARAMS, seed: 7 };
const R = params.radius;

function finishInput(): FinishInput {
  const world = generateWorld(params, { resolution: N });
  const m = world.maps;
  const seaLevelTemperature = new Float32Array(m.temperature.length);
  for (let c = 0; c < seaLevelTemperature.length; c++) {
    seaLevelTemperature[c] =
      m.temperature[c]! + (LAPSE_RATE * Math.max(0, m.height[c]!)) / params.reliefScale;
  }
  return {
    n: N,
    seed: params.seed,
    height: m.height.slice(),
    runoff: m.runoff,
    precipitation: m.precipitation,
    seaLevelTemperature,
    temperatureRange: m.temperatureRange,
    reliefScale: params.reliefScale,
    radius: R,
    displayN: N / 2,
    tectonic:
      m.province && m.lithology
        ? { n: N, province: m.province, lithology: m.lithology }
        : undefined,
  };
}

interface Scaled {
  e: number;
  height: Float32Array;
  finish: FinishResult;
}

/** The same world at each exaggeration: finishWorld once per scale, then the stage. */
function worlds(): Scaled[] {
  return SCALES.map((e) => {
    const input = finishInput();
    const finish = finishWorld(input);
    const height = input.height;
    exaggerateRelief(height, finish, e);
    return { e, height, finish };
  });
}

describe('relief exaggeration', () => {
  const all = worlds();
  const [base] = all;

  it('clamps to the proposal’s range', () => {
    expect(clampExaggeration(undefined)).toBe(1);
    expect(clampExaggeration(Number.NaN)).toBe(1);
    expect(clampExaggeration(0.5)).toBe(1);
    expect(clampExaggeration(2)).toBe(1.5);
    expect(clampExaggeration(1.3)).toBe(1.3);
    expect(unexaggeratedHeight(exaggeratedHeight(812, 1.3), 1.3)).toBeCloseTo(812, 9);
    expect(exaggeratedHeight(-300, 1.5)).toBe(-300);
  });

  it('leaves biomes, forest and zones as they are at every scale', () => {
    for (const w of all) {
      expect(w.finish.biome).toEqual(base!.finish.biome);
      expect(w.finish.forest).toEqual(base!.finish.forest);
      expect(w.finish.zones?.zone).toEqual(base!.finish.zones?.zone);
    }
  });

  it('multiplies land and leaves the sea floor', () => {
    for (const w of all) {
      for (let c = 0; c < w.height.length; c++) {
        const h0 = base!.height[c]!;
        expect(w.height[c]).toBeCloseTo(h0 > 0 ? h0 * w.e : h0, 2);
      }
    }
  });

  it('keeps lakes level and the treeline on the same ground', () => {
    for (const w of all) {
      const { lakeDepth } = w.finish.drainage;
      let lakes = 0;
      const nb = new Int32Array(8);
      for (let c = 0; c < w.height.length; c++) {
        // The treeline is above or below the same cells.
        const above0 = base!.height[c]! > base!.finish.treeline[c]!;
        expect(w.height[c]! > w.finish.treeline[c]!).toBe(above0);
        if (lakeDepth[c]! <= 0) continue;
        lakes++;
        // Neighbors in the same lake share its level.
        const level = w.height[c]! + lakeDepth[c]!;
        const level0 = base!.height[c]! + base!.finish.drainage.lakeDepth[c]!;
        expect(level).toBeCloseTo(exaggeratedHeight(level0, w.e), 1);
        neighbors8(N, c, nb);
        for (const k of nb) {
          if (k < 0 || lakeDepth[k]! <= 0) continue;
          const l0 = base!.height[k]! + base!.finish.drainage.lakeDepth[k]!;
          if (Math.abs(l0 - level0) > 1e-3) continue;
          expect(w.height[k]! + lakeDepth[k]!).toBeCloseTo(level, 1);
        }
      }
      expect(lakes).toBeGreaterThan(0);
    }
  });

  it('keeps every river surface from rising downstream', () => {
    for (const w of all) {
      const index = new RiverIndex(w.finish.rivers, {
        height: w.height,
        radius: R,
        lakeDepth: w.finish.drainage.lakeDepth,
      });
      const r = riverInvariants(index, w.finish.rivers.downstream, {
        radius: R,
        cellSize: ((Math.PI / 2) * R) / N,
      });
      expect(r.segments).toBeGreaterThan(50);
      expect(r.surfaceRises).toBe(0);
      expect(r.junctionRises).toBe(0);
    }
  });

  it('designs road profiles within the grade on the scaled ground', () => {
    // The ground along the steepest land run of cells, scaled.
    for (const w of all) {
      let start = 0;
      let best = 0;
      for (let c = 0; c < N * N; c++) {
        const h = w.height[c]!;
        if (h > best && c % N > 8 && c % N < N - 8) {
          best = h;
          start = c;
        }
      }
      const row = Math.floor(start / N);
      const step = ((Math.PI / 2) * R) / N / 8;
      const s: number[] = [];
      const ground: number[] = [];
      for (let i = 0; i < 8 * 16; i++) {
        const x = (start % N) - 8 + i / 8;
        const i0 = Math.floor(x);
        const t = x - i0;
        const a = Math.max(0, w.height[row * N + i0]!);
        const b = Math.max(0, w.height[row * N + Math.min(N - 1, i0 + 1)]!);
        s.push(i * step);
        ground.push(a + (b - a) * t);
      }
      const g = ROUTE_CLASSES.trunk.maxGrade;
      const z = designProfile(ground, s, g);
      for (let i = 1; i < z.length; i++) {
        expect(Math.abs(z[i]! - z[i - 1]!) / (s[i]! - s[i - 1]!)).toBeLessThanOrEqual(g + 1e-9);
      }
    }
  });
});
