import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { rng } from '../src/core/rng';
import { Vec3d } from '../src/core/vec3d';

describe('CubeGrid', () => {
  for (const n of [4, 17, 64]) {
    describe(`n = ${n}`, () => {
      const g = new CubeGrid(n);

      it('indexes cells consistently', () => {
        expect(g.cellCount).toBe(6 * n * n);
        for (let c = 0; c < g.cellCount; c += 7) {
          expect(g.index(g.faceOf(c), g.iOf(c), g.jOf(c))).toBe(c);
        }
      });

      it('has cell areas summing to 4π', () => {
        const total = g.areas.reduce((s, a) => s + a, 0);
        expect(total).toBeCloseTo(4 * Math.PI, 9);
      });

      it('finds each cell from its own center', () => {
        const d = new Vec3d();
        for (let c = 0; c < g.cellCount; c++) {
          expect(g.cellOfDirection(g.center(c, d))).toBe(c);
        }
      });

      it('gives every cell four distinct, symmetric edge neighbors', () => {
        for (let c = 0; c < g.cellCount; c++) {
          const nbs = Array.from(g.neighbors4.subarray(c * 4, c * 4 + 4));
          expect(new Set(nbs).size).toBe(4);
          expect(nbs).not.toContain(c);
          for (const nb of nbs) {
            const back = Array.from(g.neighbors4.subarray(nb * 4, nb * 4 + 4));
            expect(back).toContain(c);
          }
        }
      });

      it('keeps edge neighbors about one cell apart', () => {
        // Equi-angular cells span between ~(π/2)/n·0.7 and (π/2)/n·1.3 in angle.
        const step = Math.PI / 2 / n;
        for (let c = 0; c < g.cellCount; c++) {
          for (let k = 0; k < 4; k++) {
            const a = g.angleBetween(c, g.neighbors4[c * 4 + k]!);
            expect(a).toBeGreaterThan(step * 0.6);
            expect(a).toBeLessThan(step * 1.4);
          }
        }
      });

      it('gives 8 neighbors everywhere except the 24 cube-corner cells, which get 7', () => {
        let sevens = 0;
        for (let c = 0; c < g.cellCount; c++) {
          const nbs = Array.from(g.neighbors8.subarray(c * 8, c * 8 + 8)).filter((x) => x >= 0);
          expect(new Set(nbs).size).toBe(nbs.length);
          expect(nbs).not.toContain(c);
          if (nbs.length === 7) sevens++;
          else expect(nbs.length).toBe(8);
          for (const nb of nbs) {
            const back = Array.from(g.neighbors8.subarray(nb * 8, nb * 8 + 8));
            expect(back).toContain(c);
          }
        }
        expect(sevens).toBe(24);
      });
    });
  }

  it('looks up random directions into the nearest-center cell neighborhood', () => {
    const g = new CubeGrid(32);
    const r = rng(1, 'test/grid-lookup');
    const d = new Vec3d();
    const cd = new Vec3d();
    for (let k = 0; k < 2000; k++) {
      d.set(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize();
      const c = g.cellOfDirection(d);
      const own = Math.acos(Math.min(1, d.dot(g.center(c, cd))));
      // The containing cell's center is never far beyond the nearest neighbor center.
      for (let m = 0; m < 8; m++) {
        const nb = g.neighbors8[c * 8 + m]!;
        if (nb < 0) continue;
        const other = Math.acos(Math.min(1, d.dot(g.center(nb, cd))));
        expect(own).toBeLessThan(other + (Math.PI / 2 / 32) * 0.5);
      }
    }
  });
});
