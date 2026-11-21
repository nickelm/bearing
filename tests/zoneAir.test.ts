/**
 * The zones' air (Proposal 0010, decision 300): how much valley mist there is by the
 * sun and the wet, which zones mist, and the ambient particles each zone draws.
 */
import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/units';
import { ambientFor, mistAmount, recipeMist } from '../src/render/sim/atmosphere/zoneAir';
import { Biome } from '../src/worldgen/biomes';

describe('valley mist', () => {
  it('is thick at dawn, burns off through the morning, and grows on wet ground', () => {
    const dawn = mistAmount(0, true, 0);
    const midMorning = mistAmount(20 * DEG, true, 0);
    const noon = mistAmount(50 * DEG, true, 0);
    const afternoon = mistAmount(30 * DEG, false, 0);
    expect(dawn).toBeGreaterThan(0.9);
    expect(midMorning).toBeLessThan(dawn);
    expect(noon).toBe(0);
    expect(afternoon).toBe(0);
    expect(mistAmount(50 * DEG, false, 0.8)).toBeGreaterThan(0.5);
    expect(mistAmount(-30 * DEG, false, 0)).toBeGreaterThan(0);
  });

  it('pools in misty zones and never in dusty ones', () => {
    expect(recipeMist({ clouds: 'fog', particles: 'none' })).toBeGreaterThan(1);
    expect(recipeMist({ clouds: 'clear', particles: 'dust' })).toBe(0);
    expect(recipeMist(null)).toBe(1);
  });
});

describe('ambient particles', () => {
  const zone = (biome: number, particles: 'none' | 'dust' | 'mist' | 'snow' | 'pollen') => ({
    biome,
    recipe: { particles },
  });

  it('draws each zone’s kind and none at density 0', () => {
    expect(ambientFor(zone(Biome.TemperateGrassland, 'pollen'), 30 * DEG, 1)?.kind).toBe('dust');
    expect(ambientFor(zone(Biome.TemperateForest, 'pollen'), 30 * DEG, 1)?.kind).toBe('snow');
    expect(ambientFor(zone(Biome.HotDesert, 'dust'), 30 * DEG, 1)?.kind).toBe('dust');
    expect(ambientFor(zone(Biome.Tundra, 'snow'), 30 * DEG, 1)?.kind).toBe('snow');
    expect(ambientFor(zone(Biome.Tundra, 'none'), 30 * DEG, 1)).toBeNull();
    expect(ambientFor(zone(Biome.HotDesert, 'dust'), 30 * DEG, 0)).toBeNull();
  });

  it('lights fireflies at dusk in humid zones', () => {
    const f = ambientFor(zone(Biome.TropicalRainforest, 'pollen'), -3 * DEG, 1);
    expect(f?.glow[1]).toBeGreaterThan(0);
    expect(ambientFor(zone(Biome.TropicalRainforest, 'none'), 30 * DEG, 1)).toBeNull();
  });
});
