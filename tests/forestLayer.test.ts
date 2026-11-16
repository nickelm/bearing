import { describe, expect, it } from 'vitest';
import { Noise3 } from '../src/core/noise';
import { rng } from '../src/core/rng';
import {
  tileKey,
  tileKeyString,
  tileSampleDirection,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../src/core/tiles';
import { PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { cubeFaceUvToDirection } from '../src/core/coords';
import {
  INSTANCE_FLOATS,
  placeTrees,
  TREE_TILE_LEVEL,
  treeDataTile,
  treeGeometry,
} from '../src/render/sim/forest/forestLayer';
import type { TreeContext } from '../src/render/sim/forest/forestLayer';
import { buildModel } from '../src/render/common/models/builder';
import { MODEL_SPECS } from '../src/render/common/models/library';
import {
  CANOPY_THRESHOLD,
  canopySeed,
  regionalTerm,
  standAt,
  STAND_HEIGHTS,
  LUMP,
  YOUNG_HEIGHT,
} from '../src/worldgen/canopy';
import type { MeshOptions } from '../src/render/common/terrain/tileMesh';
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

/** Level-7 data: land at 200 m (sea in the tile's low-x half), forest density `f`. */
function data(
  k: TileKey,
  f: number | ((sx: number, sy: number) => number),
  biome: number = Biome.Taiga,
): TileData {
  const n = TILE_STRIDE * TILE_STRIDE;
  const height = new Float32Array(n);
  const material = new Uint32Array(n);
  const d = new Vec3d();
  for (let sy = -TILE_BORDER; sy <= TILE_TEXELS + TILE_BORDER; sy++) {
    for (let sx = -TILE_BORDER; sx <= TILE_TEXELS + TILE_BORDER; sx++) {
      tileSampleDirection(k, sx, sy, d);
      const i = (sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER;
      height[i] = sx < TILE_TEXELS / 2 ? -20 : 200;
      material[i] = biome | (Math.round((typeof f === 'number' ? f : f(sx, sy)) * 255) << 24);
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

/** A climate of `t` °C at sea level, moisture `m`, a low valley floor. */
const climateOf = (t: number, m = 0.6): TreeContext => ({
  climate: (_d, out) => {
    out.set([t, 10, m, 100]);
    return out;
  },
});

/** Instances per list, and all of them. */
function count(p: ReturnType<typeof placeTrees>, prefix = ''): number {
  let n = 0;
  for (const [k, v] of p.lists) if (k.startsWith(prefix)) n += v.length / INSTANCE_FLOATS;
  return n;
}

describe('tree placement (decision 148)', () => {
  // A level-10 tile in the land half of its level-7 data tile, next to the coast.
  const t = tileKey(4, TREE_TILE_LEVEL, 302 * 2, 280 * 2);
  const k7 = treeDataTile(t);

  it('is deterministic per tile and seed', () => {
    const a = placeTrees(t, data(k7, 0.8), opts, 1983, climateOf(0));
    const b = placeTrees(t, data(k7, 0.8), opts, 1983, climateOf(0));
    expect([...a.lists.keys()]).toEqual([...b.lists.keys()]);
    for (const [k, v] of a.lists) expect(b.lists.get(k)).toEqual(v);
    const c = placeTrees(t, data(k7, 0.8), opts, 7, climateOf(0));
    expect(c.lists.get('tree-fir/crown')).not.toEqual(a.lists.get('tree-fir/crown'));
  });

  it('closes the canopy in forest, scatters trees in the open, none at sea', () => {
    expect(count(placeTrees(t, data(k7, 0), opts, 1, climateOf(0)))).toBe(0);
    const dense = placeTrees(t, data(k7, 1), opts, 1, climateOf(0));
    // A part is about 770 m on this planet: a 7.2 m lattice holds about 11,000 crowns.
    expect(count(dense)).toBeGreaterThan(8000);
    for (const v of dense.lists.values())
      for (let i = 0; i < v.length; i += INSTANCE_FLOATS) expect(v[i + 6]).toBeGreaterThan(0);
    // Inside the forest, crowns only; whole trees along its edge.
    expect(count(dense, 'tree-fir/whole') + count(dense, 'tree-pine/whole')).toBe(0);
    const edged = placeTrees(
      t,
      data(k7, (_x, y) => (y < 8 ? 1 : 0.1)),
      opts,
      1,
      climateOf(0),
    );
    const whole = count(edged, 'tree-fir/whole') + count(edged, 'tree-pine/whole');
    expect(whole).toBeGreaterThan(0);
    expect(count(edged, 'tree-fir/crown')).toBeGreaterThan(whole);
    // Open land with a little density: a few trees and shrubs, all whole.
    const open = placeTrees(t, data(k7, 0.15), opts, 1, climateOf(10));
    expect(count(open)).toBeGreaterThan(20);
    expect(count(open)).toBeLessThan(count(dense) * 0.05);
    for (const k of open.lists.keys()) expect(k.endsWith('/whole')).toBe(true);
  });

  it("grows the stand's kind: conifers in the cold, broadleaf in the warmth, acacia in dry heat", () => {
    const cold = placeTrees(t, data(k7, 1), opts, 1, climateOf(-5));
    expect(count(cold, 'tree-fir') + count(cold, 'tree-pine')).toBe(count(cold));
    const warm = placeTrees(t, data(k7, 1), opts, 1, climateOf(18));
    expect(count(warm, 'tree-fir') + count(warm, 'tree-pine')).toBe(0);
    expect(count(warm, 'tree-oak')).toBeGreaterThan(0);
    expect(count(warm, 'tree-birch')).toBeGreaterThan(0);
    const savanna = placeTrees(t, data(k7, 0.2, Biome.Savanna), opts, 1, climateOf(24, 0.3));
    expect(count(savanna, 'tree-acacia')).toBeGreaterThan(0);
    // Acacias grow in savanna only (decision 162), not in other dry, warm land.
    const dryForestLand = placeTrees(
      t,
      data(k7, 0.2, Biome.TemperateForest),
      opts,
      1,
      climateOf(24, 0.3),
    );
    expect(count(dryForestLand, 'tree-acacia')).toBe(0);
  });

  it('stands each forest tree with its top at the canopy height of its stand', () => {
    const p = placeTrees(t, data(k7, 1), opts, 1983, climateOf(0));
    const seed = canopySeed(1983);
    const fir = p.lists.get('tree-fir/crown')!;
    const height = buildModel(MODEL_SPECS['tree-fir']!, { noAo: true }).bounds.max[1];
    for (let i = 0; i < Math.min(fir.length, 200 * INSTANCE_FLOATS); i += INSTANCE_FLOATS) {
      const R = opts.radius;
      const s = standAt(fir[i + 3]! * R, fir[i + 4]! * R, fir[i + 5]! * R, 1, 0, seed);
      const top = fir[i + 7]! * height;
      expect(top).toBeGreaterThanOrEqual(s.height * (1 - LUMP) * 0.85 - 1e-3);
      expect(top).toBeLessThanOrEqual(s.height * (1 + LUMP) * 1.1 + 1e-3);
      expect(top).toBeGreaterThanOrEqual(
        STAND_HEIGHTS.conifer[0] * YOUNG_HEIGHT * (1 - LUMP) * 0.85 - 1e-3,
      );
    }
    expect(CANOPY_THRESHOLD).toBe(0.42);
  });

  it('drops the trunk from crown-only trees and folds occlusion into the colors', () => {
    const oak = buildModel(MODEL_SPECS['tree-oak']!);
    const whole = treeGeometry(oak, 'whole');
    const crown = treeGeometry(oak, 'crown');
    expect(whole.position.length / 9).toBe(oak.triangles);
    expect(crown.position.length).toBeLessThan(whole.position.length);
    expect(crown.position.length).toBeGreaterThan(0);
    for (let i = 0; i < whole.color.length; i++)
      expect(whole.color[i]).toBeLessThanOrEqual(oak.color[i]! + 1e-6);
  });
  it('fringes a forest with its own kinds, and keeps the cold free of birch (decision 151)', () => {
    // Forest in the low rows, fringe density beyond: warm and dry enough for acacia in the open.
    const edged = data(k7, (_x, y) => (y < 8 ? 1 : 0.35));
    const warm = placeTrees(t, edged, opts, 1, climateOf(24, 0.3));
    expect(count(warm, 'tree-acacia')).toBe(0);
    expect(count(warm, 'tree-broadleaf') + count(warm, 'tree-oak')).toBeGreaterThan(0);
    const cold = placeTrees(
      t,
      data(k7, (_x, y) => (y < 8 ? 1 : 0.3)),
      opts,
      1,
      climateOf(-2),
    );
    expect(count(cold, 'tree-birch') + count(cold, 'tree-pine')).toBe(0);
    expect(count(cold, 'tree-fir')).toBeGreaterThan(0);
  });

  it('hedges field boundaries by climate: bocage in maritime farmland, none on continental plains (decision 162)', () => {
    const farm = data(k7, 0.05, Biome.TemperateGrassland);
    const settled = { habitability: () => 0.6 };
    // A maritime climate: small seasonal range, wet. Continental: a large range.
    const maritime = (_d: unknown, out: Float32Array) => (out.set([12, 6, 0.6, 100]), out);
    const continental = (_d: unknown, out: Float32Array) => (out.set([12, 15, 0.4, 100]), out);
    // A world whose regional term favors hedges here (it varies over hundreds of km).
    const c = tileSampleDirection(t, TILE_TEXELS / 2, TILE_TEXELS / 2, new Vec3d()).scale(
      opts.radius,
    );
    const world = Array.from({ length: 400 }, (_, k) => k + 1).find(
      (w) => regionalTerm(c.x, c.y, c.z, canopySeed(w)) > 0.65,
    )!;
    let hedged = 0;
    let plain = 0;
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        hedged += count(
          placeTrees(t, farm, opts, world, { climate: maritime, ...settled }, { i, j }),
          'tree-shrub',
        );
        plain += count(
          placeTrees(t, farm, opts, world, { climate: continental, ...settled }, { i, j }),
          'tree-shrub',
        );
      }
    expect(hedged).toBeGreaterThan(plain * 3);
    // Unsettled land has no fields and no hedges.
    const wild = placeTrees(t, farm, opts, world, { climate: maritime, habitability: () => 0.1 });
    const open = placeTrees(t, farm, opts, world, { climate: maritime });
    expect(count(wild)).toBe(count(open));
  });

  it('lines a share of roads with trees outside their clearing (decision 162)', () => {
    const k = tileKeyString(t);
    // A straight road across the part, east–west through its middle row.
    const size = TILE_TEXELS * (1 << t.level);
    const at = (sx: number, sy: number) =>
      cubeFaceUvToDirection(
        t.face,
        (t.x * TILE_TEXELS + sx) / size,
        (t.y * TILE_TEXELS + sy) / size,
      );
    const roads = Array.from({ length: 40 }, (_, road) => ({
      a: at(2, 4 + road * 0.2),
      b: at(TILE_TEXELS / 2 - 2, 4 + road * 0.2),
      clearing: 11.5,
      road,
      along: 0,
      roadClass: 2,
    }));
    const ctx = { ...climateOf(10), roads: (key: string) => (key === k ? roads : []) };
    const lined = placeTrees(t, data(k7, 0), opts, 1, ctx);
    const rows = count(lined);
    // About 30% of 40 roads, ~370 m each, a tree every 11 m on one or both sides.
    expect(rows).toBeGreaterThan(100);
    expect(count(placeTrees(t, data(k7, 0), opts, 1, climateOf(10)))).toBe(0);
  });
});
