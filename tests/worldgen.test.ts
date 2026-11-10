import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { hashString64 } from '../src/core/rng';
import { Vec3d } from '../src/core/vec3d';
import { BoundaryType } from '../src/worldgen/boundaries';
import { labelLandmasses } from '../src/worldgen/landmasses';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import type { PlanetParams } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { classifyBiome, Biome } from '../src/worldgen/biomes';

const RES = 24;
const grid = new CubeGrid(RES);

function gen(overrides: Partial<PlanetParams> = {}) {
  return generateWorld({ ...DEFAULT_PLANET_PARAMS, ...overrides }, { resolution: RES, grid });
}

function hashArray(a: ArrayBufferView): bigint {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  // Hash via a latin1 string of the bytes; fine for test-sized arrays.
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return hashString64(s);
}

describe('generateWorld', () => {
  const base = gen();

  it('is deterministic for a given seed', () => {
    const again = gen();
    for (const key of Object.keys(base.maps) as (keyof typeof base.maps)[]) {
      expect(hashArray(again.maps[key])).toBe(hashArray(base.maps[key]));
    }
  });

  it('differs between seeds', () => {
    expect(hashArray(gen({ seed: 7 }).maps.height)).not.toBe(hashArray(base.maps.height));
  });

  it('keeps stages independent: moisture does not change terrain', () => {
    const wet = gen({ moistureScale: 1.7 });
    expect(hashArray(wet.maps.height)).toBe(hashArray(base.maps.height));
    expect(hashArray(wet.maps.plate)).toBe(hashArray(base.maps.plate));
    expect(hashArray(wet.maps.moisture)).not.toBe(hashArray(base.maps.moisture));
  });

  it('derives the crust from the plates: plate count moves the continents', () => {
    const more = gen({ plateCount: 22 });
    expect(hashArray(more.maps.plate)).not.toBe(hashArray(base.maps.plate));
    expect(hashArray(more.maps.continentalness)).not.toBe(hashArray(base.maps.continentalness));
    expect(more.info.plateCount).toBe(22);
  });

  it('keeps stages independent: climate does not change plates or crust', () => {
    const warm = gen({ temperatureOffset: 6 });
    expect(hashArray(warm.maps.plate)).toBe(hashArray(base.maps.plate));
    expect(hashArray(warm.maps.continentalness)).toBe(hashArray(base.maps.continentalness));
  });

  it('puts the sea level at the ocean fraction', () => {
    expect(base.info.landFraction).toBeCloseTo(1 - DEFAULT_PLANET_PARAMS.oceanFraction, 1);
    const dry = gen({ oceanFraction: 0.5 });
    expect(dry.info.landFraction).toBeCloseTo(0.5, 1);
  });

  it('draws both plate types, with continental plates covering more than the land', () => {
    for (const seed of [1983, 7, 42, 'Fulda']) {
      const w = seed === DEFAULT_PLANET_PARAMS.seed ? base : gen({ seed });
      expect(w.info.continentalPlateCount).toBeGreaterThanOrEqual(1);
      expect(w.info.continentalPlateCount).toBeLessThan(w.info.plateCount);
      // Land lies mostly on continental plates (passive margins inside them).
      let onContinental = 0;
      let land = 0;
      const contPlates = new Set<number>();
      for (let c = 0; c < grid.cellCount; c++) {
        if (w.maps.continentalness[c] > 0) contPlates.add(w.maps.plate[c]);
      }
      for (let c = 0; c < grid.cellCount; c++) {
        if (w.maps.height[c] <= 0) continue;
        land += grid.areas[c];
        if (contPlates.has(w.maps.plate[c])) onContinental += grid.areas[c];
      }
      expect(onContinental / land).toBeGreaterThan(0.9);
    }
  });

  it('anchors mainContinent inland on the largest landmass', () => {
    for (const seed of [1983, 7, 42, 'Fulda']) {
      const w = seed === DEFAULT_PLANET_PARAMS.seed ? base : gen({ seed });
      const cell = grid.cellOfDirection(new Vec3d(...w.info.mainContinent));
      expect(w.maps.height[cell]).toBeGreaterThan(0);
      const { label, landmasses } = labelLandmasses(
        grid,
        w.maps.height,
        DEFAULT_PLANET_PARAMS.radius,
      );
      expect(label[cell]).toBe(0);
      expect(landmasses[0]!.area).toBeCloseTo(w.info.largestLandmassArea, 0);
      expect(w.info.landmassCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('is unsteered: geography varies between seeds', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const worlds = seeds.map((seed) => gen({ seed }));
    const largest = worlds.map((w) => w.info.largestLandmassArea / (4 * Math.PI * 1e12));
    const lats = worlds.map((w) => Math.asin(w.info.mainContinent[1]));
    // The largest landmass ranges from a fragment to most of the land.
    expect(Math.max(...largest) - Math.min(...largest)).toBeGreaterThan(0.05);
    // The main landmass is not pinned to one latitude band or hemisphere.
    expect(lats.some((l) => l > 0)).toBe(true);
    expect(lats.some((l) => l < 0)).toBe(true);
  });

  it('scales relief to the planet', () => {
    const full = gen({ reliefScale: 1 });
    const ratio = base.info.maxHeight / full.info.maxHeight;
    expect(ratio).toBeCloseTo(DEFAULT_PLANET_PARAMS.reliefScale, 5);
    // Earth-like reference relief lands at a few kilometers here.
    expect(base.info.maxHeight).toBeGreaterThan(300);
    expect(base.info.maxHeight).toBeLessThan(2500);
  });

  it('produces convergent and divergent boundaries', () => {
    const types = new Set(base.maps.boundary);
    expect(types.has(BoundaryType.None)).toBe(true);
    const convergent = [BoundaryType.Collision, BoundaryType.Cordillera, BoundaryType.Trench];
    expect(convergent.some((t) => types.has(t))).toBe(true);
    expect(types.has(BoundaryType.Ridge) || types.has(BoundaryType.Rift)).toBe(true);
  });

  it('reports a timing per stage', () => {
    expect(base.info.timings.map((t) => t.stage)).toEqual([
      'grid',
      'plates',
      'crust',
      'boundaries',
      'uplift',
      'elevation',
      'climate',
      'biomes',
    ]);
  });
});

describe('helpers', () => {
  it('labels landmasses largest first, with an inland anchor', () => {
    const g = new CubeGrid(8);
    const h = new Float32Array(g.cellCount).fill(-1);
    // Two islands on face 4 (+Z): a 3 × 3 block and a single cell.
    for (let j = 2; j < 5; j++) for (let i = 2; i < 5; i++) h[g.index(4, i, j)] = 10;
    h[g.index(4, 7, 7)] = 10;
    const { label, landmasses } = labelLandmasses(g, h, 1);
    expect(landmasses.map((m) => m.cellCount)).toEqual([9, 1]);
    expect(landmasses[0]!.interiorCell).toBe(g.index(4, 3, 3));
    expect(label[g.index(4, 7, 7)]).toBe(1);
    expect(label[g.index(4, 0, 0)]).toBe(-1);
  });

  it('classifies biomes along the Whittaker axes', () => {
    expect(classifyBiome(-500, -3000, 10, 0.5)).toBe(Biome.DeepOcean);
    expect(classifyBiome(-10, -60, 10, 0.5)).toBe(Biome.Shelf);
    expect(classifyBiome(-10, -60, -20, 0.5)).toBe(Biome.SeaIce);
    expect(classifyBiome(100, 600, 25, 0.9)).toBe(Biome.TropicalRainforest);
    expect(classifyBiome(100, 600, 25, 0.05)).toBe(Biome.HotDesert);
    expect(classifyBiome(100, 600, 10, 0.5)).toBe(Biome.TemperateForest);
    expect(classifyBiome(100, 600, 0, 0.5)).toBe(Biome.Taiga);
    expect(classifyBiome(500, 3200, 0, 0.5)).toBe(Biome.Alpine);
    expect(classifyBiome(100, 600, -25, 0.5)).toBe(Biome.IceSheet);
    expect(classifyBiome(100, 600, -12, 0.5)).toBe(Biome.Tundra);
  });
});
