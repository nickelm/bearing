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
import { DEFAULT_LOD, TILE_SEGMENTS, vertexSpacing } from '../src/render/common/terrain/quadtree';
import {
  buildTileIndex,
  buildTileMesh,
  dataTileFor,
  displacedPosition,
  TILE_VERTEX_COUNT,
} from '../src/render/common/terrain/tileMesh';
import type { MeshOptions, TileMeshData } from '../src/render/common/terrain/tileMesh';
import { NO_LAKE } from '../src/worldgen/gpu/tileSynth';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import { LAKE_DRY } from '../src/render/common/terrain/tileMesh';

const R = PLANET_RADIUS;
const V = TILE_SEGMENTS + 1;
const opts: MeshOptions = {
  radius: R,
  reliefScale: 0.157,
  mode: 'biome',
  detail: new Noise3(rng(1, 'test-detail')),
};

const EX = 3;

/** Synthetic tile data from an analytic height field (same function at every level). */
function fakeData(
  k: TileKey,
  river?: (sx: number, sy: number) => boolean,
  offset = 300,
  lake?: (sx: number, sy: number) => number,
): TileData {
  const height = new Float32Array(TILE_STRIDE * TILE_STRIDE);
  const material = new Uint32Array(TILE_STRIDE * TILE_STRIDE).fill(8);
  const lakeLevel = new Float32Array(TILE_STRIDE * TILE_STRIDE).fill(NO_LAKE);
  const d = new Vec3d();
  for (let sy = -TILE_BORDER; sy <= TILE_TEXELS + TILE_BORDER; sy++) {
    for (let sx = -TILE_BORDER; sx <= TILE_TEXELS + TILE_BORDER; sx++) {
      tileSampleDirection(k, sx, sy, d);
      height[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER] =
        offset + 200 * Math.sin(d.x * 400) * Math.cos(d.z * 300);
      const i = (sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER;
      if (river?.(sx, sy)) material[i] = 8 | (255 << 8);
      if (lake) lakeLevel[i] = lake(sx, sy);
    }
  }
  return { key: k, height, material, lake: lakeLevel, minHeight: 0, maxHeight: 500 };
}

/** World position of vertex v, as the shader displaces it (morph 1 = own, 0 = parent). */
const world = (m: TileMeshData, v: number, morph = 1) =>
  displacedPosition(m, v, EX, morph).add(m.origin);

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
    expect(m.base.length).toBe(TILE_VERTEX_COUNT * 3);
    for (const a of [m.base, m.up, m.height, m.parentBase, m.parentDisp, m.slope, m.color]) {
      expect(a.every(Number.isFinite)).toBe(true);
    }
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
        const pc = world(mc, j * V + i, 0);
        const pp = world(mp, (half + j / 2) * V + half + i / 2);
        expect(pc.distanceTo(pp)).toBeLessThan(0.01);
      }
    }
    // Odd vertices sit on the midpoint of the parent's edge.
    const m1 = world(mc, 1, 0);
    const mid = world(mc, 0, 0)
      .add(world(mc, 2, 0))
      .scale(0.5);
    expect(m1.distanceTo(mid)).toBeLessThan(0.01);
  });

  it('keeps flat facets through geomorphing: at morph 0 each child facet lies in a parent facet', () => {
    // Flat shading shows every triangle (decision 123), so a split must not change
    // the facets: the child's two triangles per quad share the parent's diagonal
    // direction, and its odd vertices sit on the parent's edges and diagonals.
    const parent = tileKey(2, 6, 20, 33);
    const child = childTiles(parent)[3]!; // (+1, +1) quadrant
    const mp = build(parent);
    const mc = build(child);
    const index = buildTileIndex();
    const half = TILE_SEGMENTS / 2;
    const normalOf = (p: Vec3d[]) =>
      p[1]!.clone().sub(p[0]!).cross(p[2]!.clone().sub(p[0]!)).normalize();
    let worst = 0;
    let bent = 0;
    for (let t = 0; t < 2 * TILE_SEGMENTS * TILE_SEGMENTS; t++) {
      const tri = [index[3 * t]!, index[3 * t + 1]!, index[3 * t + 2]!];
      const nc = normalOf(tri.map((v) => world(mc, v, 0)));
      // Centroid in the parent's grid coordinates, and the parent triangle containing it.
      const cx = half + tri.reduce((s, v) => s + (v % V), 0) / 6;
      const cy = half + tri.reduce((s, v) => s + Math.floor(v / V), 0) / 6;
      const qi = Math.floor(cx);
      const qj = Math.floor(cy);
      const g = (i: number, j: number) => j * V + i;
      const ptri =
        cx - qi >= cy - qj
          ? [g(qi, qj), g(qi + 1, qj), g(qi + 1, qj + 1)]
          : [g(qi, qj), g(qi + 1, qj + 1), g(qi, qj + 1)];
      const np = normalOf(ptri.map((v) => world(mp, v)));
      worst = Math.max(worst, Math.acos(Math.min(1, nc.dot(np))));
      // At full detail the child's own heights bend the facets away from the parent's.
      const n1 = normalOf(tri.map((v) => world(mc, v, 1)));
      if (Math.acos(Math.min(1, n1.dot(np))) > 1e-3) bent++;
    }
    expect(worst).toBeLessThan(1e-3);
    expect(bent).toBeGreaterThan(0);
  });

  it('gives facets of about 20 to 60 m at the finest level', () => {
    // docs/visual-style.md Part I, Terrain: facets of roughly 20–60 m at low altitude.
    const s = vertexSpacing(DEFAULT_LOD.maxLevel, R);
    expect(s).toBeGreaterThanOrEqual(20);
    expect(s * Math.SQRT2).toBeLessThanOrEqual(60);
  });

  it('has outward normals and puts the origin on the sphere', () => {
    const m = build(tileKey(0, 4, 7, 9));
    expect(m.origin.length()).toBeCloseTo(R, 3);
    const up = m.origin.clone().normalize();
    for (let v = 0; v < V * V; v += 97) {
      // The shader's normal: normalize(up − slope · exaggeration).
      const n = new Vec3d(
        m.up[v * 3]! - m.slope[v * 3]! * EX,
        m.up[v * 3 + 1]! - m.slope[v * 3 + 1]! * EX,
        m.up[v * 3 + 2]! - m.slope[v * 3 + 2]! * EX,
      ).normalize();
      expect(n.dot(up)).toBeGreaterThan(0.5);
    }
    expect(m.maxHeight).toBeGreaterThan(m.minHeight);
  });

  it('marks farmable biomes on land in the landform attribute (decision 127)', () => {
    const t = tileKey(1, 5, 3, 4);
    const withBiome = (biome: number, mode: MeshOptions['mode'] = 'biome') => {
      const data = fakeData(t);
      const parentData = fakeData(parentTile(t)!);
      data.material.fill(biome);
      parentData.material.fill(biome);
      return buildTileMesh(t, { data, parentData }, { ...opts, mode });
    };
    const farmable = (m: TileMeshData) =>
      Array.from({ length: TILE_VERTEX_COUNT }, (_, v) => m.landform[v * 3 + 2]);
    // Temperate forest (8) is farmable, taiga (6) is not; debug views carry none.
    expect(new Set(farmable(withBiome(8)))).toEqual(new Set([1]));
    expect(new Set(farmable(withBiome(6)))).toEqual(new Set([0]));
    expect(new Set(farmable(withBiome(8, 'height')))).toEqual(new Set([0]));
  });

  it('keeps raw sea depths but draws the sea flat', () => {
    // Heights from -200 to +200 m around a coast.
    const t = tileKey(4, 6, 20, 30);
    const m = buildTileMesh(
      t,
      { data: fakeData(t, undefined, 0), parentData: fakeData(parentTile(t)!, undefined, 0) },
      opts,
    );
    let sea = 0;
    let land = 0;
    for (let v = 0; v < V * V; v++) {
      const h = m.height[v]!;
      const radial = world(m, v).length() - R;
      expect(m.water[v]).toBe(-LAKE_DRY);
      if (h < 0) {
        sea++;
        expect(radial).toBeCloseTo(0, 1);
        // Coast distance: positive at sea.
        expect(m.shore[v]).toBeGreaterThan(0);
      } else {
        land++;
        expect(radial).toBeCloseTo(h * EX, 0);
        expect(m.shore[v]).toBeLessThanOrEqual(0);
      }
    }
    expect(sea).toBeGreaterThan(100);
    expect(land).toBeGreaterThan(100);
    expect(m.minHeight).toBe(0);
  });

  it('draws lakes flat at their level, with a signed depth for the shoreline', () => {
    // Terrain 100..500 m; a lake at 300 m covering everything below it.
    const t = tileKey(4, 6, 20, 30);
    const level = () => 300;
    const m = buildTileMesh(
      t,
      {
        data: fakeData(t, undefined, 300, level),
        parentData: fakeData(parentTile(t)!, undefined, 300, level),
      },
      opts,
    );
    let wet = 0;
    let dry = 0;
    for (let v = 0; v < V * V; v++) {
      const h = m.height[v]!;
      const radial = world(m, v).length() - R;
      expect(m.water[v]).toBeCloseTo(Math.max(-LAKE_DRY, 300 - h), 3);
      if (h < 300) {
        wet++;
        expect(radial).toBeCloseTo(300 * EX, 0);
        // The lake surface is flat: no slope away from the shore.
        if (h < 250) {
          const s = Math.hypot(m.slope[v * 3]!, m.slope[v * 3 + 1]!, m.slope[v * 3 + 2]!);
          expect(s).toBeLessThan(1e-6);
        }
      } else {
        dry++;
        expect(radial).toBeCloseTo(h * EX, 0);
      }
    }
    expect(wet).toBeGreaterThan(100);
    expect(dry).toBeGreaterThan(100);
  });
});
