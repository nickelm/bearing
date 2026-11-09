import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { hashString64 } from '../src/core/rng';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { BoundaryType } from '../src/worldgen/boundaries';
import { capRadius } from '../src/worldgen/continents';
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

  it('keeps stages independent: plate count does not move the continents', () => {
    const more = gen({ plateCount: 22 });
    expect(hashArray(more.maps.continentalness)).toBe(hashArray(base.maps.continentalness));
    expect(more.info.mainContinent).toEqual(base.info.mainContinent);
    expect(hashArray(more.maps.plate)).not.toBe(hashArray(base.maps.plate));
    expect(more.info.plateCount).toBe(22);
  });

  it('puts the sea level at the ocean fraction', () => {
    expect(base.info.landFraction).toBeCloseTo(1 - DEFAULT_PLANET_PARAMS.oceanFraction, 1);
    const dry = gen({ oceanFraction: 0.5 });
    expect(dry.info.landFraction).toBeCloseTo(0.5, 1);
  });

  it('places two temperate continents across an ocean gap', () => {
    for (const seed of [1983, 7, 42, 'Fulda']) {
      const w = seed === DEFAULT_PLANET_PARAMS.seed ? base : gen({ seed });
      const a = new Vec3d(...w.info.mainContinent);
      const b = new Vec3d(...w.info.secondContinent);
      const sep = Math.acos(a.dot(b));
      expect(sep).toBeCloseTo(w.info.continentSeparation, 9);
      expect(sep).toBeGreaterThanOrEqual(100 * DEG - 1e-9);
      expect(sep).toBeLessThanOrEqual(178 * DEG + 1e-9);
      // Ellipse-to-ellipse gap near the middle of the 1,200–1,800 km range.
      expect(w.info.nominalGap * DEFAULT_PLANET_PARAMS.radius).toBeGreaterThan(1200e3);
      expect(w.info.nominalGap * DEFAULT_PLANET_PARAMS.radius).toBeLessThan(1800e3);
      const latA = Math.abs(Math.asin(a.y) / DEG);
      const latB = Math.abs(Math.asin(b.y) / DEG);
      expect(latA).toBeGreaterThanOrEqual(32);
      expect(latA).toBeLessThanOrEqual(45);
      expect(latB).toBeGreaterThanOrEqual(22);
      expect(latB).toBeLessThanOrEqual(55);
      // Both centers are on continental crust.
      expect(w.maps.continentalness[grid.cellOfDirection(a)]).toBeGreaterThan(0);
      expect(w.maps.continentalness[grid.cellOfDirection(b)]).toBeGreaterThan(0);
    }
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
      'continents',
      'plates',
      'boundaries',
      'uplift',
      'elevation',
      'climate',
      'biomes',
    ]);
  });
});

describe('helpers', () => {
  it('computes cap radii from area fractions', () => {
    expect(capRadius(0.5)).toBeCloseTo(Math.PI / 2, 12);
    expect(capRadius(0)).toBe(0);
    expect(capRadius(1)).toBeCloseTo(Math.PI, 12);
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
