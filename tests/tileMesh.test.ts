import { describe, expect, it } from 'vitest';
import { Noise3 } from '../src/core/noise';
import { rng } from '../src/core/rng';
import {
  childTiles,
  neighborTile,
  parentTile,
  tileKey,
  tileSampleDirection,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { TILE_SEGMENTS } from '../src/render/terrain/quadtree';
import {
  buildTileIndex,
  buildTileMesh,
  dataTileFor,
  TILE_VERTEX_COUNT,
} from '../src/render/terrain/tileMesh';
import type { MeshOptions } from '../src/render/terrain/tileMesh';
import type { TileData } from '../src/worldgen/gpu/tileSynth';

const R = PLANET_RADIUS;
const V = TILE_SEGMENTS + 1;
const opts: MeshOptions = {
  radius: R,
  reliefScale: 0.157,
  exaggeration: 3,
  mode: 'biome',
  detail: new Noise3(rng(1, 'test-detail')),
};

/** Synthetic tile data from an analytic height field (same function at every level). */
function fakeData(k: TileKey): TileData {
  const height = new Float32Array(TILE_STRIDE * TILE_STRIDE);
  const material = new Uint32Array(TILE_STRIDE * TILE_STRIDE).fill(8);
  const d = new Vec3d();
  for (let sy = -TILE_BORDER; sy <= TILE_TEXELS + TILE_BORDER; sy++) {
    for (let sx = -TILE_BORDER; sx <= TILE_TEXELS + TILE_BORDER; sx++) {
      tileSampleDirection(k, sx, sy, d);
      height[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER] =
        300 + 200 * Math.sin(d.x * 400) * Math.cos(d.z * 300);
    }
  }
  return { key: k, height, material, minHeight: 0, maxHeight: 500 };
}

const world = (m: { origin: Vec3d; position: Float32Array }, v: number, which = m.position) =>
  new Vec3d(which[v * 3]!, which[v * 3 + 1]!, which[v * 3 + 2]!).add(m.origin);

const build = (t: TileKey) =>
  buildTileMesh(
    t,
    {
      data: fakeData(dataTileFor(t)),
      parentData: t.level > 0 && t.level <= 7 ? fakeData(parentTile(t)!) : null,
    },
    opts,
  );

describe('buildTileMesh', () => {
  it('builds a valid index and vertex count', () => {
    const idx = buildTileIndex();
    expect(idx.length).toBe(TILE_SEGMENTS * TILE_SEGMENTS * 6 + 4 * TILE_SEGMENTS * 6);
    expect(Math.max(...idx)).toBe(TILE_VERTEX_COUNT - 1);
    const m = build(tileKey(4, 5, 10, 12));
    expect(m.position.length).toBe(TILE_VERTEX_COUNT * 3);
    expect(m.position.every(Number.isFinite)).toBe(true);
  });

  for (const level of [5, 9]) {
    it(`shares edge vertices with its same-level neighbor (level ${level})`, () => {
      const a = tileKey(4, level, 300 >> (10 - level), 401 >> (10 - level));
      const b = neighborTile(a, 1, 0);
      const ma = build(a);
      const mb = build(b);
      for (let j = 0; j < V; j++) {
        const pa = world(ma, j * V + TILE_SEGMENTS);
        const pb = world(mb, j * V);
        expect(pa.distanceTo(pb)).toBeLessThan(0.01);
      }
    });
  }

  it('morphs to exactly the parent surface', () => {
    const parent = tileKey(2, 6, 20, 33);
    const child = childTiles(parent)[3]!; // (+1, +1) quadrant
    const mp = build(parent);
    const mc = build(child);
    const half = TILE_SEGMENTS / 2;
    for (let j = 0; j < V; j += 2) {
      for (let i = 0; i < V; i += 2) {
        const pc = world(mc, j * V + i, mc.positionParent);
        const pp = world(mp, (half + j / 2) * V + half + i / 2);
        expect(pc.distanceTo(pp)).toBeLessThan(0.01);
      }
    }
    // Odd vertices sit on the midpoint of the parent's edge.
    const m1 = world(mc, 1, mc.positionParent);
    const mid = world(mc, 0, mc.positionParent)
      .add(world(mc, 2, mc.positionParent))
      .scale(0.5);
    expect(m1.distanceTo(mid)).toBeLessThan(0.01);
  });

  it('has outward normals and puts the origin on the sphere', () => {
    const m = build(tileKey(0, 4, 7, 9));
    expect(m.origin.length()).toBeCloseTo(R, 3);
    const up = m.origin.clone().normalize();
    for (let v = 0; v < V * V; v += 97) {
      const n = new Vec3d(m.normal[v * 3]!, m.normal[v * 3 + 1]!, m.normal[v * 3 + 2]!);
      expect(n.dot(up)).toBeGreaterThan(0.5);
    }
    expect(m.maxHeight).toBeGreaterThan(m.minHeight);
  });
});
