import { describe, expect, it } from 'vitest';
import {
  Character,
  CHARACTER_EFFECTS,
  DISTINCT_JSD,
  jsdBits,
  MAX_REDRAWS,
} from '../src/worldgen/characters';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';

describe('continental character (decision 212)', () => {
  const worlds = ['1', '2', '3', '4', '5', '6'].map((seed) =>
    generateWorld({ ...DEFAULT_PLANET_PARAMS, seed }, { resolution: 64 }),
  );

  it('gives the continents characters, more than one kind per world in most seeds', () => {
    let varied = 0;
    for (const w of worlds) {
      const list = w.info.continents!;
      expect(list.length).toBeGreaterThan(0);
      const kinds = new Set(list.filter((k) => k.area >= 250_000e6).map((k) => k.character));
      if (kinds.size > 1) varied++;
      expect(w.info.characterRedraws).toBeLessThanOrEqual(MAX_REDRAWS);
    }
    expect(varied).toBeGreaterThanOrEqual(4);
  });

  it('only young mountains raise the floor on young runs, and no character is outside the table', () => {
    for (const fx of CHARACTER_EFFECTS)
      expect(fx.youngFloor === 0 || fx === CHARACTER_EFFECTS[Character.YoungMountains]).toBe(true);
    for (const w of worlds)
      for (const k of w.info.continents!) expect(CHARACTER_EFFECTS[k.character]).toBeDefined();
  });

  it('is deterministic, redraws included', () => {
    const again = generateWorld({ ...DEFAULT_PLANET_PARAMS, seed: '4' }, { resolution: 64 });
    expect(again.info.continents).toEqual(worlds[3]!.info.continents);
    expect(again.maps.biome).toEqual(worlds[3]!.maps.biome);
  });

  it('measures divergence in bits', () => {
    const a = new Float64Array([1, 0]);
    const b = new Float64Array([0, 1]);
    expect(jsdBits(a, b)).toBeCloseTo(1, 6);
    expect(jsdBits(a, a)).toBe(0);
    expect(DISTINCT_JSD).toBeGreaterThan(0);
  });
});
