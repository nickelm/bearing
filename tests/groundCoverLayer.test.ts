import { describe, expect, it } from 'vitest';
import { Noise3 } from '../src/core/noise';
import { rng } from '../src/core/rng';
import { directionToCubeFace } from '../src/core/coords';
import {
  tileKey,
  tileSampleDirection,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { buildTileMesh, displacedPosition } from '../src/render/common/terrain/tileMesh';
import type { MeshOptions } from '../src/render/common/terrain/tileMesh';
import { TILE_SEGMENTS } from '../src/render/common/terrain/quadtree';
import { treeDataTile } from '../src/render/sim/forest/forestLayer';
import {
  COVER_FLOATS,
  COVER_SPLIT,
  COVER_TILE_LEVEL,
  placeCoverChunk,
} from '../src/render/sim/ground/groundCoverLayer';
import type { CoverContext } from '../src/render/sim/ground/groundCoverLayer';
import { Biome } from '../src/worldgen/biomes';
import { NO_LAKE } from '../src/worldgen/gpu/tileSynth';
import type { TileData } from '../src/worldgen/gpu/tileSynth';

const opts: MeshOptions = {
  radius: PLANET_RADIUS,
  reliefScale: 0.157,
  mode: 'biome',
  detail: new Noise3(rng(1, 'test-detail')),
};

/** Level-7 data: sea in the low-x half, a sloping grassland at 200 m and up in the other. */
function data(k: TileKey, forest = 0.05): TileData {
  const n = TILE_STRIDE * TILE_STRIDE;
  const height = new Float32Array(n);
  const material = new Uint32Array(n);
  const d = new Vec3d();
  for (let sy = -TILE_BORDER; sy <= TILE_TEXELS + TILE_BORDER; sy++) {
    for (let sx = -TILE_BORDER; sx <= TILE_TEXELS + TILE_BORDER; sx++) {
      tileSampleDirection(k, sx, sy, d);
      const i = (sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER;
      height[i] = sx < TILE_TEXELS / 2 ? -20 : 200 + 3 * (sx - 128) + 2 * sy;
      material[i] = Biome.TemperateGrassland | (Math.round(forest * 255) << 24);
    }
  }
  return {
    key: k,
    height,
    material,
    lake: new Float32Array(n).fill(NO_LAKE),
    minHeight: -20,
    maxHeight: 1000,
  };
}

const ctx: CoverContext = {
  climate: (_d, out) => {
    out.set([14, 10, 0.55, 100]);
    return out;
  },
};

/** Every item's foot (planet-centered, exaggeration `ex`) and its kind. */
function feet(chunk: ReturnType<typeof placeCoverChunk>, ex: number): Vec3d[] {
  const out: Vec3d[] = [];
  for (const list of chunk.lists.values()) {
    for (let o = 0; o < list.length; o += COVER_FLOATS) {
      out.push(
        new Vec3d(
          chunk.origin.x + list[o]! + list[o + 3]! * ex,
          chunk.origin.y + list[o + 1]! + list[o + 4]! * ex,
          chunk.origin.z + list[o + 2]! + list[o + 5]! * ex,
        ),
      );
    }
  }
  return out;
}

describe('ground cover chunks (decision 174)', () => {
  // A level-10 tile in the land half of its level-7 data tile.
  const t = tileKey(4, COVER_TILE_LEVEL, 302 * 2, 280 * 2);
  const k7 = treeDataTile(t);
  const d7 = data(k7);

  it('places items deterministically, none in the sea', () => {
    const a = placeCoverChunk(t, { i: 3, j: 4 }, d7, opts, 7, ctx);
    const b = placeCoverChunk(t, { i: 3, j: 4 }, d7, opts, 7, ctx);
    expect([...a.lists.entries()]).toEqual([...b.lists.entries()]);
    expect(a.lists.get('cover-tuft')!.length / COVER_FLOATS).toBeGreaterThan(1000);
    const sea = tileKey(4, COVER_TILE_LEVEL, 300 * 2, 280 * 2);
    expect(
      placeCoverChunk(sea, { i: 3, j: 4 }, data(treeDataTile(sea)), opts, 7, ctx).lists.size,
    ).toBe(0);
    // Closed forest: nothing.
    expect(placeCoverChunk(t, { i: 3, j: 4 }, data(k7, 0.9), opts, 7, ctx).lists.size).toBe(0);
  });

  it('stands every item on the drawn level-10 triangle, at any exaggeration', () => {
    const chunk = placeCoverChunk(t, { i: 5, j: 2 }, d7, opts, 7, ctx);
    const mesh = buildTileMesh(t, { data: d7, parentData: null }, opts);
    const size = TILE_TEXELS * (1 << t.level);
    const step = TILE_TEXELS / TILE_SEGMENTS;
    const V = TILE_SEGMENTS + 1;
    for (const ex of [1, 3]) {
      const pts = feet(chunk, ex);
      expect(pts.length).toBeGreaterThan(500);
      let worst = 0;
      for (const p of pts) {
        const uv = directionToCubeFace(p.clone().normalize());
        const fx = (uv.u * size - t.x * TILE_TEXELS) / step;
        const fy = (uv.v * size - t.y * TILE_TEXELS) / step;
        const i = Math.floor(fx);
        const j = Math.floor(fy);
        const u = fx - i;
        const v = fy - j;
        const g = (a: number, b: number) => (j + b) * V + (i + a);
        const corners = u >= v ? [g(0, 0), g(1, 0), g(1, 1)] : [g(0, 0), g(1, 1), g(0, 1)];
        const [a, b, c] = corners.map((k) => displacedPosition(mesh, k, ex).add(mesh.origin)) as [
          Vec3d,
          Vec3d,
          Vec3d,
        ];
        const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
        worst = Math.max(worst, Math.abs(p.clone().sub(a).dot(n)));
      }
      // Within a centimeter of the drawn plane (the mesh stores float32 offsets).
      expect(worst).toBeLessThan(0.01);
    }
  });

  it('cuts tiles into chunks that cover the tile once', () => {
    expect(TILE_TEXELS % COVER_SPLIT).toBe(0);
    expect((TILE_TEXELS / COVER_SPLIT) % (TILE_TEXELS / TILE_SEGMENTS)).toBe(0);
  });
});
