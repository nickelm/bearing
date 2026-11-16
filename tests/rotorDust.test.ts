/** What a rotor's downwash raises from the ground (decision 181). */
import { describe, expect, it } from 'vitest';
import { washSurface } from '../src/render/sim/ground/rotorDust';
import type { WashSite } from '../src/render/sim/ground/rotorDust';
import { Biome, TileCover } from '../src/worldgen/biomes';

const site = (o: Partial<WashSite>): WashSite => ({
  water: false,
  cover: Biome.TemperateGrassland,
  moisture: 0.5,
  temperature: 15,
  wetness: 0,
  paved: false,
  rock: false,
  ...o,
});

describe('rotor wash surfaces (decision 181)', () => {
  it('raises spray over water, whatever the ground around it', () => {
    expect(washSurface(site({ water: true, cover: Biome.HotDesert }))).toEqual({
      kind: 'spray',
      amount: 1,
    });
  });

  it('raises snow where snow lies, but not off pavement', () => {
    expect(washSurface(site({ temperature: -8 })).kind).toBe('snow');
    expect(washSurface(site({ temperature: -8, paved: true })).kind).toBe('grit');
    // Too dry for snow to lie.
    expect(
      washSurface(site({ temperature: -8, moisture: 0.01, cover: Biome.ColdDesert })).kind,
    ).toBe('dust');
  });

  it('raises dust from deserts, beaches and dry grass, nothing from green meadows', () => {
    expect(washSurface(site({ cover: Biome.HotDesert }))).toEqual({ kind: 'dust', amount: 1 });
    expect(washSurface(site({ cover: TileCover.Beach })).kind).toBe('dust');
    expect(washSurface(site({ cover: Biome.Savanna, moisture: 0.15 })).kind).toBe('dust');
    expect(washSurface(site({ cover: Biome.TemperateGrassland, moisture: 0.5 })).kind).toBe('none');
    expect(washSurface(site({ cover: Biome.TemperateForest })).kind).toBe('none');
  });

  it('raises grit from rock, gravel and pavement, and less of everything when wet', () => {
    expect(washSurface(site({ cover: TileCover.Gravel })).kind).toBe('grit');
    expect(washSurface(site({ cover: Biome.Alpine })).kind).toBe('grit');
    expect(washSurface(site({ paved: true })).kind).toBe('grit');
    const dry = washSurface(site({ cover: Biome.HotDesert }));
    const wet = washSurface(site({ cover: Biome.HotDesert, wetness: 0.4 }));
    expect(wet.amount).toBeLessThan(dry.amount);
    expect(washSurface(site({ cover: Biome.HotDesert, wetness: 1 })).amount).toBe(0);
  });
});
