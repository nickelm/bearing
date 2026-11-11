import { describe, expect, it } from 'vitest';
import { Biome } from '../src/worldgen/biomes';
import {
  biomeFillTexels,
  biomeMaskTexels,
  hexToLinear,
  STRATEGIC_BIOME_FILL,
} from '../src/render/strategic/biomeFill';

const N = 32;
const M = N / 2;

/** A biome map with `pick(face, i, j)` per cell. */
function map(pick: (face: number, i: number, j: number) => number): Uint8Array {
  const b = new Uint8Array(6 * N * N);
  for (let f = 0; f < 6; f++)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) b[(f * N + j) * N + i] = pick(f, i, j);
  return b;
}

const texel = (t: Float32Array, f: number, I: number, J: number) => {
  const k = ((f * M + J) * M + I) * 4;
  return [t[k]!, t[k + 1]!, t[k + 2]!];
};

describe('strategic biome fill', () => {
  it('uses the Part II fills', () => {
    expect(STRATEGIC_BIOME_FILL[Biome.TemperateGrassland]).toBe(0xa3ae78);
    expect(STRATEGIC_BIOME_FILL[Biome.Taiga]).toBe(0x5e7a5c);
    expect(STRATEGIC_BIOME_FILL[Biome.HotDesert]).toBe(0xdcc195);
    expect(STRATEGIC_BIOME_FILL[Biome.IceSheet]).toBe(0xf1f3f2);
    for (const sea of [Biome.DeepOcean, Biome.Ocean, Biome.Shelf, Biome.SeaIce])
      expect(STRATEGIC_BIOME_FILL[sea]).toBeNull();
  });

  it('paints a uniform biome exactly, at half the resolution', () => {
    const t = biomeFillTexels(
      map(() => Biome.Savanna),
      N,
    );
    expect(t.length).toBe(6 * M * M * 4);
    const s = hexToLinear(0xc2b57e);
    for (const [f, I, J] of [
      [0, 0, 0],
      [3, 7, 9],
      [5, M - 1, M - 1],
    ])
      expect(texel(t, f!, I!, J!)).toEqual(s.map((x) => expect.closeTo(x, 6)));
  });

  it('blends across a biome boundary over a few texels', () => {
    // Grassland west of i = N/2, desert east of it, on every face.
    const t = biomeFillTexels(
      map((_f, i) => (i < N / 2 ? Biome.TemperateGrassland : Biome.HotDesert)),
      N,
    );
    const g = hexToLinear(0xa3ae78)[0];
    const d = hexToLinear(0xdcc195)[0];
    const row = Array.from({ length: M }, (_, I) => texel(t, 4, I, 5)[0]);
    // Pure far from the edge, monotone across it, with intermediate values only near it.
    expect(row[0]).toBeCloseTo(g, 6);
    expect(row[M - 1]).toBeCloseTo(d, 6);
    for (let I = 1; I < M; I++) expect(row[I]!).toBeGreaterThanOrEqual(row[I - 1]! - 1e-9);
    const mixed = row.filter((x) => x > g + 1e-6 && x < d - 1e-6).length;
    expect(mixed).toBeGreaterThanOrEqual(2);
    expect(mixed).toBeLessThanOrEqual(3);
  });

  it('keeps coasts the land color and carries it out to sea', () => {
    // Taiga on the first quarter of each face, ocean elsewhere.
    const t = biomeFillTexels(
      map((_f, i) => (i < N / 4 ? Biome.Taiga : Biome.Ocean)),
      N,
    );
    const taiga = hexToLinear(0x5e7a5c);
    // The last land texel and the sea texels next to it are all taiga.
    for (const I of [M / 4 - 1, M / 4, M / 4 + 2])
      expect(texel(t, 1, I, 3)).toEqual(taiga.map((x) => expect.closeTo(x, 6)));
    for (const x of t) expect(Number.isFinite(x)).toBe(true);
  });

  it('carries farmability in alpha: open lowland biomes, blended at their edges', () => {
    const t = biomeFillTexels(
      map((_f, i) => (i < N / 2 ? Biome.TemperateGrassland : Biome.Taiga)),
      N,
    );
    const alpha = (I: number) => t[((2 * M + 5) * M + I) * 4 + 3]!;
    expect(alpha(0)).toBeCloseTo(1, 6);
    expect(alpha(M - 1)).toBeCloseTo(0, 6);
    expect(alpha(M / 2)).toBeGreaterThan(0);
    expect(alpha(M / 2)).toBeLessThan(1);
  });

  it('masks sand desert, tundra and ice for their patterns', () => {
    for (const [b, mask] of [
      [Biome.HotDesert, [1, 0, 0, 0]],
      [Biome.Tundra, [0, 1, 0, 0]],
      [Biome.IceSheet, [0, 0, 1, 0]],
      [Biome.ColdDesert, [0, 0, 0, 0]],
      [Biome.Taiga, [0, 0, 0, 0]],
    ] as const) {
      const t = biomeMaskTexels(
        map(() => b),
        N,
      );
      expect(Array.from(t.slice(0, 4))).toEqual(mask.map((x) => expect.closeTo(x, 6)));
    }
  });
});
