import { describe, expect, it } from 'vitest';
import { Biome } from '../src/worldgen/biomes';
import { LAYERED, Rock } from '../src/worldgen/lithology';
import { Province } from '../src/worldgen/provinces';
import { PROP_TUNING, propChance, propInCell, propSeed } from '../src/worldgen/props';
import type { PropSite } from '../src/worldgen/props';

const site = (o: Partial<PropSite>): PropSite => ({
  height: 120,
  slope: 0.02,
  lithology: Rock.Shale | LAYERED,
  province: Province.SedimentaryBasin,
  biome: Biome.TemperateGrassland,
  karstNear: false,
  karstWonder: Infinity,
  pillarWonder: Infinity,
  blocked: false,
  ...o,
});

describe('landform props (decision 225)', () => {
  it('gates kinds by rock and climate (rule 15)', () => {
    expect(propChance(site({}))).toBeNull();
    const karst = propChance(
      site({ lithology: Rock.Limestone | LAYERED, biome: Biome.TropicalRainforest }),
    );
    expect(karst).toEqual({ kind: 'prop-karst-tower', p: PROP_TUNING.karstWet });
    expect(propChance(site({ lithology: Rock.Limestone, biome: Biome.Taiga }))!.p).toBe(
      PROP_TUNING.karstDry,
    );
    expect(
      propChance(site({ lithology: Rock.Sandstone | LAYERED, biome: Biome.RedRockDesert }))!.kind,
    ).toBe('prop-pillar');
    // Unlayered sandstone in a dry climate, or layered sandstone in a wet one: no pillars.
    expect(propChance(site({ lithology: Rock.Sandstone, biome: Biome.HotDesert }))).toBeNull();
    expect(
      propChance(site({ lithology: Rock.Sandstone | LAYERED, biome: Biome.TemperateForest })),
    ).toBeNull();
    expect(
      propChance(
        site({ lithology: Rock.Granite, province: Province.Shield, biome: Biome.Savanna }),
      )!.kind,
    ).toBe('prop-inselberg');
  });

  it('drowns towers on a shallow karst shelf only, and keeps off blocked cells', () => {
    expect(propChance(site({ height: -15, karstNear: true }))!.kind).toBe('prop-karst-tower');
    expect(propChance(site({ height: -15 }))).toBeNull();
    expect(propChance(site({ height: -80, karstNear: true }))).toBeNull();
    expect(
      propChance(
        site({ lithology: Rock.Limestone, biome: Biome.TropicalRainforest, blocked: true }),
      ),
    ).toBeNull();
  });

  it('crowds props at karst-bay and pillar-forest wonders', () => {
    const near = propChance(site({ height: -10, karstWonder: 500 }))!;
    expect(near.kind).toBe('prop-karst-tower');
    expect(near.p).toBeGreaterThan(PROP_TUNING.karstDrowned);
    expect(propChance(site({ pillarWonder: 1000 }))!.kind).toBe('prop-pillar');
    expect(propChance(site({ pillarWonder: PROP_TUNING.wonderReach + 1 }))).toBeNull();
  });

  it('is deterministic per cell and places about the chance', () => {
    const seed = propSeed('7');
    const s = site({ lithology: Rock.Limestone, biome: Biome.TropicalRainforest });
    expect(propInCell(seed, 2, 10, 11, s)).toEqual(propInCell(seed, 2, 10, 11, s));
    let n = 0;
    for (let i = 0; i < 4000; i++) if (propInCell(seed, 1, i, 7, s)) n++;
    expect(n / 4000).toBeCloseTo(PROP_TUNING.karstWet, 1);
  });
});
