import { describe, expect, it } from 'vitest';
import { Noise3 } from '../src/core/noise';
import { rng } from '../src/core/rng';
import {
  tileKey,
  tileSampleDirection,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../src/core/tiles';
import { PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { INSTANCE_FLOATS, placeTrees, treeDataTile } from '../src/render/sim/forest/forestLayer';
import { treeClump } from '../src/render/sim/forest/treeGeometry';
import type { MeshOptions } from '../src/render/sim/terrain/tileMesh';
import { Biome } from '../src/worldgen/biomes';
import { NO_LAKE } from '../src/worldgen/gpu/tileSynth';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import type { TileKey } from '../src/core/tiles';

const opts: MeshOptions = {
  radius: PLANET_RADIUS,
  reliefScale: 0.157,
  mode: 'biome',
  detail: new Noise3(rng(1, 'test-detail')),
};

/** Level-7 data: land at 200 m (sea where x < 0 of the direction), forest density `f`. */
function data(k: TileKey, f: number, biome: number = Biome.Taiga): TileData {
  const n = TILE_STRIDE * TILE_STRIDE;
  const height = new Float32Array(n);
  const material = new Uint32Array(n);
  const d = new Vec3d();
  for (let sy = -TILE_BORDER; sy <= TILE_TEXELS + TILE_BORDER; sy++) {
    for (let sx = -TILE_BORDER; sx <= TILE_TEXELS + TILE_BORDER; sx++) {
      tileSampleDirection(k, sx, sy, d);
      const i = (sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER;
      height[i] = sx < TILE_TEXELS / 2 ? -20 : 200;
      material[i] = biome | (Math.round(f * 255) << 24);
    }
  }
  return {
    key: k,
    height,
    material,
    lake: new Float32Array(n).fill(NO_LAKE),
    minHeight: -20,
    maxHeight: 200,
  };
}

describe('tree placement', () => {
  // Covers samples 128..192 of its level-7 data tile: the land half, next to the coast.
  const t = tileKey(4, 9, 302, 280);
  const k7 = treeDataTile(t);

  it('is deterministic per tile and seed', () => {
    const a = placeTrees(t, data(k7, 0.8), opts, 1983);
    const b = placeTrees(t, data(k7, 0.8), opts, 1983);
    expect(Buffer.from(a.conifer.buffer).equals(Buffer.from(b.conifer.buffer))).toBe(true);
    const c = placeTrees(t, data(k7, 0.8), opts, 7);
    expect(Buffer.from(a.conifer.buffer).equals(Buffer.from(c.conifer.buffer))).toBe(false);
  });

  it('follows the density and keeps trees out of the sea', () => {
    expect(placeTrees(t, data(k7, 0), opts, 1).conifer.length).toBe(0);
    const dense = placeTrees(t, data(k7, 1), opts, 1);
    const count = dense.conifer.length / INSTANCE_FLOATS;
    expect(count).toBeGreaterThan(100);
    for (let i = 0; i < count; i++) {
      expect(dense.conifer[i * INSTANCE_FLOATS + 6]).toBeGreaterThan(0); // height above sea
    }
    const sparse = placeTrees(t, data(k7, 0.3), opts, 1).conifer.length / INSTANCE_FLOATS;
    expect(sparse).toBeGreaterThan(count * 0.15);
    expect(sparse).toBeLessThan(count * 0.5);
  });

  it('puts taiga in conifers and grassland savanna in broadleaf', () => {
    const p = placeTrees(t, data(k7, 1, Biome.Savanna), opts, 1);
    expect(p.conifer.length).toBe(0);
    expect(p.broadleaf.length).toBeGreaterThan(0);
  });

  it('builds clumps standing on the ground with outward normals', () => {
    for (const kind of ['conifer', 'broadleaf'] as const) {
      const g = treeClump(kind);
      expect(g.position.length % 9).toBe(0);
      let top = 0;
      for (let i = 1; i < g.position.length; i += 3) top = Math.max(top, g.position[i]!);
      expect(top).toBeGreaterThan(8);
      for (let i = 0; i < g.normal.length; i += 3) {
        expect(Math.hypot(g.normal[i]!, g.normal[i + 1]!, g.normal[i + 2]!)).toBeCloseTo(1, 5);
      }
    }
  });
});
