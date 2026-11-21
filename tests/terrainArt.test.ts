/**
 * Terrain art (Proposal 0010, decisions 296 and 298): the settings by quality and
 * style, the governor's steps, the curvature bake's signs and the rock table.
 */
import { describe, expect, it } from 'vitest';
import { rockArt } from '../src/render/common/terrain/surfaceArt';
import {
  ART_GOVERNOR_STEPS,
  ART_QUALITIES,
  ART_STYLES,
  artFromQuery,
  governed,
  terrainArtSettings,
} from '../src/render/common/terrainArt';
import { curvatureMap } from '../src/worldgen/curvature';
import { LAYERED, Rock } from '../src/worldgen/lithology';

describe('terrain art settings', () => {
  it('turns every layer off at quality off', () => {
    const s = terrainArtSettings('off', 'storybook');
    expect(s.curvature + s.strata + s.drift + s.mist + s.heightFog + s.particles).toBe(0);
    expect(s.rocks.enabled || s.waterfalls || s.structures).toBe(false);
  });

  it('scales the costly layers with quality and the strengths with style', () => {
    const low = terrainArtSettings('low');
    const med = terrainArtSettings('medium');
    const high = terrainArtSettings('high');
    expect(low.rocks.far).toBeLessThan(med.rocks.far);
    expect(med.rocks.far).toBeLessThan(high.rocks.far);
    expect(low.particles).toBeLessThan(high.particles);
    expect(terrainArtSettings('medium', 'storybook').curvature).toBeGreaterThan(med.curvature);
    expect(terrainArtSettings('medium', 'muted').drift).toBeLessThan(med.drift);
    for (const q of ART_QUALITIES)
      for (const st of ART_STYLES) expect(terrainArtSettings(q, st).quality).toBe(q);
  });

  it('sheds the costly layers in steps and keeps the shading', () => {
    const s = terrainArtSettings('high');
    let prev = s;
    for (let k = 1; k <= ART_GOVERNOR_STEPS; k++) {
      const g = governed(s, k);
      expect(g.rocks.far).toBeLessThanOrEqual(prev.rocks.far);
      expect(g.particles).toBeLessThanOrEqual(prev.particles);
      expect(g.curvature).toBe(s.curvature);
      prev = g;
    }
    expect(prev.rocks.enabled).toBe(false);
    expect(prev.mist).toBe(0);
    expect(governed(s, 0)).toBe(s);
  });

  it('reads the URL and falls back on unknown values', () => {
    expect(artFromQuery(new URLSearchParams('art=low&artStyle=muted'))).toEqual({
      quality: 'low',
      style: 'muted',
    });
    expect(artFromQuery(new URLSearchParams('art=ultra'))).toEqual({
      quality: 'medium',
      style: 'bearing',
    });
  });
});

describe('curvature bake', () => {
  // One face's cell (i, j) on an n-per-face grid, face 4 (+Z), well inside the face.
  const n = 32;
  const cell = (i: number, j: number) => (4 * n + j) * n + i;

  it('is positive in a hollow, negative on a crest, zero at sea', () => {
    const height = new Float32Array(6 * n * n).fill(500);
    height[cell(10, 10)] = 300; // a pit
    height[cell(20, 20)] = 800; // a peak
    height[cell(5, 25)] = -50; // sea
    const c = curvatureMap(n, height);
    expect(c[cell(10, 10)]).toBeGreaterThan(0.5);
    expect(c[cell(20, 20)]).toBeLessThan(-0.5);
    expect(c[cell(5, 25)]).toBe(0);
    expect(Math.abs(c[cell(15, 5)]!)).toBeLessThan(1e-6);
    for (const v of c) expect(Math.abs(v)).toBeLessThan(1);
  });
});

describe('rock art', () => {
  it('bands layered rock fully, granite not at all, and tones by rock', () => {
    expect(rockArt(Rock.Sandstone | LAYERED)[0]).toBe(1);
    expect(rockArt(Rock.Granite)[0]).toBe(0);
    expect(rockArt(Rock.Limestone)[1]).toBeGreaterThan(rockArt(Rock.Granite)[1]);
    expect(rockArt(Rock.Basalt)[1]).toBeLessThan(1);
    expect(rockArt(Rock.None)).toEqual([0, 1]);
  });
});

describe('world profiles', () => {
  it('falls back to Bearing’s and keeps the relief in range', async () => {
    const { worldProfile, WORLD_PROFILES } = await import('../src/worldgen/worldProfile');
    expect(worldProfile('nonsense').name).toBe('bearing');
    expect(worldProfile(null).name).toBe('bearing');
    for (const p of Object.values(WORLD_PROFILES)) {
      expect(p.reliefExaggeration).toBeGreaterThanOrEqual(1);
      expect(p.reliefExaggeration).toBeLessThanOrEqual(1.5);
    }
    expect(worldProfile('natural').poiKinds).toEqual([]);
  });
});
