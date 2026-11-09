import { describe, expect, it } from 'vitest';
import { buildCubeSphereArrays } from '../src/render/cubeSphereGeometry';
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
