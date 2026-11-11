import { describe, expect, it } from 'vitest';
import { buildCornerCells, buildCubeSphereArrays } from '../src/render/common/cubeSphereGeometry';
import { CubeGrid } from '../src/core/cubeGrid';
import { PLANET_RADIUS } from '../src/core/units';

describe('cube-sphere geometry', () => {
  const n = 16;
  const g = buildCubeSphereArrays(n, PLANET_RADIUS);

  it('has 6 × (n+1)² vertices and 6 × n² × 2 triangles', () => {
    expect(g.positions.length / 3).toBe(6 * (n + 1) ** 2);
    expect(g.indices.length / 3).toBe(6 * n * n * 2);
  });

  it('places every vertex on the sphere', () => {
    for (let i = 0; i < g.positions.length; i += 3) {
      const r = Math.hypot(g.positions[i]!, g.positions[i + 1]!, g.positions[i + 2]!);
      // Float32 storage at 1e6 m resolves to ~0.06 m.
      expect(Math.abs(r - PLANET_RADIUS)).toBeLessThan(0.1);
    }
  });

  it('winds triangles counterclockwise seen from outside', () => {
    const p = g.positions;
    for (let t = 0; t < g.indices.length; t += 3) {
      const [a, b, c] = [g.indices[t]! * 3, g.indices[t + 1]! * 3, g.indices[t + 2]! * 3];
      const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
      const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
      const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      expect(nx * p[a]! + ny * p[a + 1]! + nz * p[a + 2]!).toBeGreaterThan(0);
    }
  });
});

describe('corner cells', () => {
  const n = 12;
  const grid = new CubeGrid(n);
  const lattice = buildCubeSphereArrays(n, 1);
  const corners = buildCornerCells(grid);

  it('gives 4 cells per vertex, or 3 at the 8 cube corners', () => {
    const vertexCount = lattice.normals.length / 3;
    let threes = 0;
    for (let v = 0; v < vertexCount; v++) {
      const list = Array.from(corners.subarray(v * 4, v * 4 + 4)).filter((c) => c >= 0);
      if (list.length === 3) threes++;
      else expect(list.length).toBe(4);
    }
    // Each cube corner appears once on each of its 3 faces.
    expect(threes).toBe(8 * 3);
  });

  it('assigns identical corner lists to duplicated seam vertices', () => {
    const groups = new Map<string, string>();
    const d = lattice.normals;
    for (let v = 0; v < d.length / 3; v++) {
      const key = [d[v * 3]!, d[v * 3 + 1]!, d[v * 3 + 2]!].map((x) => x.toFixed(5)).join(',');
      const list = Array.from(corners.subarray(v * 4, v * 4 + 4)).join(',');
      const seen = groups.get(key);
      if (seen === undefined) groups.set(key, list);
      else expect(list).toBe(seen);
    }
    // 6(n+1)² lattice vertices collapse to 6n² + 2 distinct sphere points.
    expect(groups.size).toBe(6 * n * n + 2);
  });
});
