import { describe, expect, it } from 'vitest';
import {
  TILE_BORDER,
  TILE_TEXELS,
  childTiles,
  neighborTile,
  parentTile,
  parseTileKey,
  texelSizeAtLevel,
  tileEquals,
  tileForDirection,
  tileKey,
  tileKeyString,
  tileTexelDirection,
  tileUvBounds,
} from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import type { CubeFace } from '../src/core/coords';
import { directionToCubeFace } from '../src/core/coords';
import { rng } from '../src/core/rng';
import { PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';

function allTiles(level: number): TileKey[] {
  const out: TileKey[] = [];
  const size = 1 << level;
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) out.push(tileKey(f as CubeFace, level, x, y));
    }
  }
  return out;
}

describe('tile keys', () => {
  it('round-trips through strings', () => {
    const k = tileKey(3, 5, 17, 30);
    expect(tileKeyString(k)).toBe('3/5/17/30');
    expect(tileEquals(parseTileKey('3/5/17/30'), k)).toBe(true);
    expect(() => parseTileKey('3/5/32/0')).toThrow(RangeError);
    expect(() => tileKey(6 as CubeFace, 0, 0, 0)).toThrow(RangeError);
  });

  it('has consistent parent and child relations', () => {
    const k = tileKey(2, 4, 9, 6);
    const kids = childTiles(k);
    expect(kids).toHaveLength(4);
    for (const c of kids) expect(tileEquals(parentTile(c)!, k)).toBe(true);
    expect(parentTile(tileKey(0, 0, 0, 0))).toBeNull();
    // Children exactly tile the parent's UV bounds.
    const [u0, v0, u1, v1] = tileUvBounds(k);
    const b = kids.map(tileUvBounds);
    expect(Math.min(...b.map((x) => x[0]))).toBeCloseTo(u0, 15);
    expect(Math.max(...b.map((x) => x[2]))).toBeCloseTo(u1, 15);
    expect(Math.min(...b.map((x) => x[1]))).toBeCloseTo(v0, 15);
    expect(Math.max(...b.map((x) => x[3]))).toBeCloseTo(v1, 15);
  });

  it('finds the tile containing a direction at any level', () => {
    const r = rng(1, 'test/tiles');
    const d = new Vec3d();
    for (let i = 0; i < 500; i++) {
      d.set(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize();
      const level = r.int(8);
      const k = tileForDirection(d, level);
      const uv = directionToCubeFace(d);
      const [u0, v0, u1, v1] = tileUvBounds(k);
      expect(k.face).toBe(uv.face);
      expect(uv.u).toBeGreaterThanOrEqual(u0);
      expect(uv.u).toBeLessThanOrEqual(u1);
      expect(uv.v).toBeGreaterThanOrEqual(v0);
      expect(uv.v).toBeLessThanOrEqual(v1);
      if (level > 0) {
        expect(tileEquals(tileForDirection(d, level - 1), parentTile(k)!)).toBe(true);
      }
    }
  });

  it('has symmetric edge neighbors across face seams', () => {
    for (const level of [0, 1, 3]) {
      for (const k of allTiles(level)) {
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nb = neighborTile(k, dx, dy);
          expect(tileEquals(nb, k)).toBe(false);
          const back = [
            neighborTile(nb, 1, 0),
            neighborTile(nb, -1, 0),
            neighborTile(nb, 0, 1),
            neighborTile(nb, 0, -1),
          ];
          expect(back.some((b) => tileEquals(b, k))).toBe(true);
        }
      }
    }
  });

  it('places border texels on the adjacent tile', () => {
    const k = tileKey(4, 2, 3, 1); // touches the +u edge of face +Z
    const inside = tileTexelDirection(k, TILE_TEXELS - 1, 100);
    const border = tileTexelDirection(k, TILE_TEXELS + TILE_BORDER - 1, 100);
    expect(tileEquals(tileForDirection(inside, 2), k)).toBe(true);
    expect(tileEquals(tileForDirection(border, 2), neighborTile(k, 1, 0))).toBe(true);
  });

  it('matches the design texel sizes', () => {
    expect(texelSizeAtLevel(4, PLANET_RADIUS)).toBeCloseTo(383.5, 0);
    expect(texelSizeAtLevel(7, PLANET_RADIUS)).toBeCloseTo(47.9, 0);
  });
});
