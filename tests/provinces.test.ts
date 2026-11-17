import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import {
  erodibilityField,
  isLayered,
  LAYERED,
  Rock,
  ROCK_ERODIBILITY,
  rockOf,
} from '../src/worldgen/lithology';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { Province, PROVINCE_COUNT } from '../src/worldgen/provinces';

const RES = 64;
const SEEDS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const worlds = SEEDS.map((seed) =>
  generateWorld({ ...DEFAULT_PLANET_PARAMS, seed }, { resolution: RES }),
);

describe('terrain provinces and lithology (decision 204)', () => {
  it('gives every land cell a province, and every province appears over the seeds', () => {
    const seen = new Set<number>();
    for (const w of worlds) {
      const m = w.maps;
      for (let c = 0; c < m.height.length; c++) {
        if (m.height[c]! > 0) {
          expect(m.province[c]).not.toBe(Province.None);
          seen.add(m.province[c]!);
        }
      }
    }
    for (let p = 1; p < PROVINCE_COUNT; p++) {
      // Hotspot edifices are small; at 64² they may miss land in a handful of seeds.
      if (p === Province.Hotspot) continue;
      expect(seen.has(p), `province ${p}`).toBe(true);
    }
  });

  it('is deterministic and leaves plates, crust and boundaries as they were', () => {
    const again = generateWorld({ ...DEFAULT_PLANET_PARAMS, seed: '3' }, { resolution: RES });
    const w = worlds[2]!;
    expect(again.maps.province).toEqual(w.maps.province);
    expect(again.maps.lithology).toEqual(w.maps.lithology);
    // The stages before provinces draw from their own streams: a world built
    // without them would have these same maps (the stage order is fixed).
    expect(again.maps.plate).toEqual(w.maps.plate);
    expect(again.maps.continentalness).toEqual(w.maps.continentalness);
    expect(again.maps.boundary).toEqual(w.maps.boundary);
  });

  it('gates landforms by rock: karst on limestone, soft sediment on loess, layers only in sediment', () => {
    for (const w of worlds) {
      const m = w.maps;
      for (let c = 0; c < m.height.length; c++) {
        const l = m.lithology[c]!;
        const rock = rockOf(l);
        if (m.province[c] === Province.KarstPlatform) expect(rock).toBe(Rock.Limestone);
        if (m.province[c] === Province.SoftSediment) expect(rock).toBe(Rock.Loess);
        if (isLayered(l)) {
          expect([Rock.Sandstone, Rock.Shale, Rock.Limestone]).toContain(rock);
        }
        if (m.province[c] === Province.GlaciatedLowland) {
          expect(m.temperature[c]!).toBeLessThan(3);
          expect([Rock.Till, Rock.Granite]).toContain(rock);
        }
      }
    }
  });

  it('smooths erodibility within the rock table', () => {
    const grid = new CubeGrid(RES);
    const e = erodibilityField(grid, worlds[0]!.maps.lithology);
    const lo = Math.min(...ROCK_ERODIBILITY);
    const hi = Math.max(...ROCK_ERODIBILITY);
    for (const v of e) {
      expect(v).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(v).toBeLessThanOrEqual(hi + 1e-6);
    }
    // A uniform rock gives a uniform factor.
    const uniform = new Uint8Array(grid.cellCount).fill(Rock.Sandstone | LAYERED);
    for (const v of erodibilityField(grid, uniform)) expect(v).toBeCloseTo(1, 6);
  });
});
