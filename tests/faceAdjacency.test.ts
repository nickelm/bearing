import { describe, expect, it } from 'vitest';
import { CubeGrid, NEIGHBOR_OFFSETS } from '../src/core/cubeGrid';
import { FACE_EDGES, neighborCell, wrapCell } from '../src/core/faceAdjacency';

describe('faceAdjacency', () => {
  it('maps every edge to a different face, and each edge map is mirrored by its partner', () => {
    for (let f = 0; f < 6; f++) {
      for (let e = 0; e < 4; e++) {
        const m = FACE_EDGES[f * 4 + e]!;
        expect(m.face).not.toBe(f);
        // Exactly one edge of the target face leads back.
        const back = [0, 1, 2, 3].filter((k) => FACE_EDGES[m.face * 4 + k]!.face === f);
        expect(back).toHaveLength(1);
      }
    }
  });

  for (const n of [2, 3, 8, 64]) {
    describe(`n = ${n}`, () => {
      const g = new CubeGrid(n);

      it('matches CubeGrid edge neighbors', () => {
        for (let c = 0; c < g.cellCount; c++) {
          for (let k = 0; k < 4; k++) {
            const [di, dj] = NEIGHBOR_OFFSETS[k]!;
            expect(neighborCell(n, c, di, dj)).toBe(g.neighbors4[c * 4 + k]);
          }
        }
      });

      it('gives every cell 8 distinct neighbors, except 7 at the 24 corner cells', () => {
        let sevens = 0;
        for (let c = 0; c < g.cellCount; c++) {
          const nbs = NEIGHBOR_OFFSETS.map(([di, dj]) => neighborCell(n, c, di, dj)).filter(
            (x) => x >= 0,
          );
          if (nbs.length === 7) sevens++;
          else expect(nbs).toHaveLength(8);
          expect(new Set(nbs).size).toBe(nbs.length);
          expect(nbs).not.toContain(c);
        }
        expect(sevens).toBe(24);
      });

      it('has symmetric 8-neighborhoods', () => {
        for (let c = 0; c < g.cellCount; c++) {
          for (const [di, dj] of NEIGHBOR_OFFSETS) {
            const nb = neighborCell(n, c, di, dj);
            if (nb < 0) continue;
            const back = NEIGHBOR_OFFSETS.map(([a, b]) => neighborCell(n, nb, a, b));
            expect(back).toContain(c);
          }
        }
      });

      it('keeps diagonal neighbors about √2 cells apart', () => {
        const step = Math.PI / 2 / n;
        for (let c = 0; c < g.cellCount; c++) {
          for (const [di, dj] of NEIGHBOR_OFFSETS.slice(4)) {
            const nb = neighborCell(n, c, di, dj);
            if (nb < 0) continue;
            const a = g.angleBetween(c, nb);
            expect(a).toBeGreaterThan(step * 0.6);
            expect(a).toBeLessThan(step * 2.1);
          }
        }
      });
    });
  }

  it('returns −1 only past a cube corner', () => {
    expect(wrapCell(8, 0, 8, 8)).toBe(-1);
    expect(wrapCell(8, 0, -1, -1)).toBe(-1);
    expect(wrapCell(8, 0, 8, 3)).toBeGreaterThanOrEqual(0);
  });

  it('steps several cells past an edge along a chain of edge neighbors', () => {
    const n = 16;
    const g = new CubeGrid(n);
    for (let f = 0; f < 6; f++) {
      for (let j = 0; j < n; j++) {
        const chain = [0, 1, 2, 3].map((t) => wrapCell(n, f, n - 1 + t, j));
        expect(new Set(chain).size).toBe(4);
        for (let t = 0; t < 3; t++) {
          const nbs = Array.from(g.neighbors4.subarray(chain[t]! * 4, chain[t]! * 4 + 4));
          expect(nbs).toContain(chain[t + 1]);
        }
      }
    }
  });

  it('agrees with CubeGrid diagonals away from cube corners', () => {
    const n = 32;
    const g = new CubeGrid(n);
    let mismatches = 0;
    for (let c = 0; c < g.cellCount; c++) {
      for (let k = 4; k < 8; k++) {
        const [di, dj] = NEIGHBOR_OFFSETS[k]!;
        if (neighborCell(n, c, di, dj) !== g.neighbors8[c * 8 + k]) mismatches++;
      }
    }
    // CubeGrid finds diagonals by direction lookup, which can pick the other
    // cell of a pair near the corners. Allow a handful, never a systematic offset.
    expect(mismatches).toBeLessThanOrEqual(48);
  });
});
