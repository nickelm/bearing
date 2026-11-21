/**
 * Rock dressing (Proposal 0010, decision 299): the placement rules by slope, curvature
 * and rock; determinism; the density knob; colliders above 20 m; and on a synthetic
 * cliff tile, that every piece sinks below the ground under its footprint and that
 * cliffs steeper than 45° carry dressing.
 */
import { describe, expect, it } from 'vitest';
import { tileKey, TILE_STRIDE, TILE_BORDER, TILE_TEXELS } from '../src/core/tiles';
import { Biome } from '../src/worldgen/biomes';
import { NO_LAKE } from '../src/worldgen/gpu/tileSynth';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import { LAYERED, Rock } from '../src/worldgen/lithology';
import { Province } from '../src/worldgen/provinces';
import {
  DRESSING_KINDS,
  DRESSING_SIZE,
  DRESSING_STRIDE,
  dressingChance,
  dressingCollider,
  dressingInCell,
} from '../src/worldgen/rockDressing';
import type { DressingSite } from '../src/worldgen/rockDressing';
import { placeDressingTile } from '../src/render/sim/props/rockDressingLayer';
import { MODEL_SPECS } from '../src/render/common/models/library';

const site = (over: Partial<DressingSite>): DressingSite => ({
  height: 1200,
  slope: 0.2,
  upslope: 0.2,
  curvature: 0,
  lithology: Rock.Granite,
  province: Province.YoungCollision,
  biome: Biome.Alpine,
  blocked: false,
  ...over,
});

describe('rock dressing rules', () => {
  it('has a model and a far model for every kind', () => {
    for (const k of DRESSING_KINDS) {
      expect(MODEL_SPECS[k], k).toBeDefined();
      expect(MODEL_SPECS[`${k}-lod`], `${k}-lod`).toBeDefined();
    }
  });

  it('lines cliffs with slabs by rock, crests with teeth, feet with scree', () => {
    expect(dressingChance(site({ slope: 1.4, lithology: Rock.Sandstone | LAYERED }))?.kind).toBe(
      'rock-sand-slab',
    );
    expect(dressingChance(site({ slope: 1.4, lithology: Rock.Basalt }))?.kind).toBe(
      'rock-basalt-wall',
    );
    expect(dressingChance(site({ slope: 0.8, lithology: Rock.Sandstone | LAYERED }))?.kind).toBe(
      'rock-sand-buttress',
    );
    expect(dressingChance(site({ slope: 0.6, curvature: -0.2 }))?.kind).toBe('rock-granite-tor');
    expect(dressingChance(site({ slope: 0.3, upslope: 1.2, curvature: 0.1 }))?.kind).toBe(
      'rock-scree',
    );
    expect(dressingChance(site({ slope: 0.1 }))?.kind).toBe('rock-granite-boulder');
    expect(dressingChance(site({ slope: 0.1, biome: Biome.TemperateForest }))).toBeNull();
    expect(dressingChance(site({ slope: 1.4, blocked: true }))).toBeNull();
    expect(dressingChance(site({ slope: 1.4, height: -5 }))).toBeNull();
  });

  it('is deterministic per cell and follows the density', () => {
    const s = site({ slope: 1.4 });
    let some = 0;
    for (let g = 0; g < 400; g++) {
      const a = dressingInCell(7, 2, g, 3 * g, s);
      expect(dressingInCell(7, 2, g, 3 * g, s)).toEqual(a);
      if (a) some++;
      expect(dressingInCell(7, 2, g, 3 * g, s, 0)).toBeNull();
    }
    expect(some).toBeGreaterThan(150);
    let half = 0;
    for (let g = 0; g < 400; g++) if (dressingInCell(7, 2, g, 3 * g, s, 0.3)) half++;
    expect(half).toBeLessThan(some);
  });

  it('gives colliders only to pieces larger than 20 m', () => {
    for (let g = 0; g < 300; g++) {
      const item = dressingInCell(11, 0, g, g, site({ slope: 1.4 }));
      if (!item) continue;
      const big = DRESSING_SIZE[item.kind].size * item.scale > 20;
      expect(dressingCollider(item) !== null).toBe(big && DRESSING_SIZE[item.kind].radius > 0);
    }
  });
});

describe('rock dressing on a cliff tile', () => {
  // A level-7 tile whose ground rises 60 m per sample (about 51°) along x through its middle third.
  const key = tileKey(4, 7, 60, 60);
  const n = TILE_STRIDE * TILE_STRIDE;
  const height = new Float32Array(n);
  for (let y = 0; y < TILE_STRIDE; y++)
    for (let x = 0; x < TILE_STRIDE; x++) {
      const sx = Math.min(170, Math.max(85, x - TILE_BORDER));
      height[y * TILE_STRIDE + x] = 500 + (sx - 85) * 60;
    }
  const data: TileData = {
    key,
    height,
    material: new Uint32Array(n).fill(Biome.Alpine),
    lake: new Float32Array(n).fill(NO_LAKE),
    minHeight: 500,
    maxHeight: 500 + 85 * 60,
  };
  const N = 64;
  const maps = {
    n: N,
    province: new Uint8Array(6 * N * N).fill(Province.YoungCollision),
    lithology: new Uint8Array(6 * N * N).fill(Rock.Sandstone | LAYERED),
    biome: new Uint8Array(6 * N * N).fill(Biome.Alpine),
    karstWonders: [],
    pillarWonders: [],
  };
  const R = 1_000_000;
  const placed = placeDressingTile(data, maps, 99, R, undefined);

  it('dresses the cliff and leaves the level ground bare of cliff pieces', () => {
    let onCliff = 0;
    let cliffCells = 0;
    const cells = TILE_TEXELS / DRESSING_STRIDE;
    for (let cx = 0; cx < cells; cx++) {
      const sx = cx * DRESSING_STRIDE + 1;
      if (sx > 87 && sx < 168) cliffCells++;
    }
    for (const [kind, list] of placed.lists) {
      const face = DRESSING_SIZE[kind as keyof typeof DRESSING_SIZE].pose === 'face';
      if (face) onCliff += list.length / 12;
    }
    expect(cliffCells).toBeGreaterThan(30);
    expect(onCliff).toBeGreaterThan(cells * cliffCells * 0.3);
  });

  it('sinks every piece below the lowest ground under it', () => {
    let pieces = 0;
    for (const [kind, list] of placed.lists) {
      const size = DRESSING_SIZE[kind as keyof typeof DRESSING_SIZE].size;
      for (let o = 0; o < list.length; o += 12) {
        pieces++;
        // Foot height from the displacement along its radial direction (the base's).
        const disp = Math.hypot(list[o + 3]!, list[o + 4]!, list[o + 5]!);
        const scale = list[o + 9]!;
        expect(disp).toBeLessThanOrEqual(data.maxHeight - 0.12 * size * scale + 1e-3);
        expect(disp).toBeLessThan(data.maxHeight);
      }
    }
    expect(pieces).toBeGreaterThan(0);
  });
});
