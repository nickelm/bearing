import { describe, expect, it } from 'vitest';
import { Biome } from '../src/worldgen/biomes';
import { LAPSE_RATE } from '../src/worldgen/climate';
import { forestMaps, TREELINE_WARMEST_MONTH } from '../src/worldgen/forest';
import type { FinishInput } from '../src/worldgen/finishWorld';
import { toHalf } from '../src/worldgen/gpu/tileSynth';

describe('forest maps', () => {
  const n = 2;
  const cells = 6 * n * n;
  const input = {
    n,
    height: new Float32Array(cells),
    runoff: new Float32Array(cells),
    precipitation: new Float32Array(cells),
    seaLevelTemperature: new Float32Array(cells).fill(14),
    temperatureRange: new Float32Array(cells).fill(8),
    reliefScale: 0.157,
    radius: 1e6,
    displayN: 1,
  } satisfies FinishInput;

  it('gives forest biomes dense cover and deserts and oceans none', () => {
    const biome = new Uint8Array(cells).fill(Biome.HotDesert);
    biome[0] = Biome.TemperateForest;
    biome[1] = Biome.Ocean;
    biome[2] = Biome.Savanna;
    const { forest } = forestMaps(input, biome);
    expect(forest[0]).toBeGreaterThan(200);
    expect(forest[1]).toBe(0);
    expect(forest[2]).toBeGreaterThan(0);
    expect(forest[2]).toBeLessThan(100);
    expect(forest[3]).toBe(0);
  });

  it('puts the treeline where the warmest month cools to 10 °C', () => {
    const { treeline } = forestMaps(input, new Uint8Array(cells));
    // Warmest month at sea level 22 °C: 12 K above the limit, at 6.5 K per reference km.
    const expected = ((14 + 8 - TREELINE_WARMEST_MONTH) / LAPSE_RATE) * 0.157;
    expect(treeline[0]).toBeCloseTo(expected, 3);
    expect(treeline[0]).toBeGreaterThan(250);
  });
});

describe('half floats', () => {
  it('encodes like IEEE binary16', () => {
    expect(toHalf(0)).toBe(0);
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7c00);
    expect(toHalf(0.5)).toBe(0x3800);
    // 600.25 rounds to the nearest representable value, 600.
    expect(toHalf(600.25)).toBe(toHalf(600));
  });
});
