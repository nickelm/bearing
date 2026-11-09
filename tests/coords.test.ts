import { describe, expect, it } from 'vitest';
import {
  CUBE_FACES,
  CUBE_FACE_COUNT,
  CubeFace,
  cartesianToGeodetic,
  cubeFaceUvToDirection,
  directionToCubeFace,
  geodeticToCartesian,
  greatCircleDistance,
  latLonToDirection,
  projectToCubeFace,
} from '../src/core/coords';
import { rng } from '../src/core/rng';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';

const EPS = 1e-12;

function randomDirection(r: ReturnType<typeof rng>): Vec3d {
  // Uniform on the sphere: z uniform in [-1, 1], azimuth uniform.
  const y = r.range(-1, 1);
  const a = r.range(0, 2 * Math.PI);
  const s = Math.sqrt(1 - y * y);
  return new Vec3d(s * Math.cos(a), y, s * Math.sin(a));
}

describe('geodetic conventions', () => {
  it('puts the north pole on +Y', () => {
    const g = cartesianToGeodetic(new Vec3d(0, PLANET_RADIUS, 0));
    expect(g.lat).toBeCloseTo(Math.PI / 2, 12);
    expect(g.alt).toBeCloseTo(0, 6);
  });

  it('puts lat 0, lon 0 on +Z and 90°E on +X', () => {
    expect(latLonToDirection(0, 0).equals(new Vec3d(0, 0, 1), EPS)).toBe(true);
    expect(latLonToDirection(0, 90 * DEG).equals(new Vec3d(1, 0, 0), EPS)).toBe(true);
    expect(latLonToDirection(0, -90 * DEG).equals(new Vec3d(-1, 0, 0), EPS)).toBe(true);
    expect(latLonToDirection(-90 * DEG, 0).equals(new Vec3d(0, -1, 0), EPS)).toBe(true);
  });

  it('round-trips geodetic to Cartesian and back, including altitude', () => {
    const r = rng(1, 'test/geodetic');
    for (let i = 0; i < 1000; i++) {
      const lat = r.range(-89.9, 89.9) * DEG;
      const lon = r.range(-179.9, 179.9) * DEG;
      const alt = r.range(-10_000, 5_000_000);
      const g = cartesianToGeodetic(geodeticToCartesian(lat, lon, alt));
      expect(g.lat).toBeCloseTo(lat, 10);
      expect(g.lon).toBeCloseTo(lon, 10);
      expect(Math.abs(g.alt - alt)).toBeLessThan(1e-6);
    }
  });

  it('measures great-circle distance', () => {
    const a = latLonToDirection(0, 0);
    const b = latLonToDirection(0, 90 * DEG);
    expect(greatCircleDistance(a, b)).toBeCloseTo((Math.PI / 2) * PLANET_RADIUS, 6);
    expect(greatCircleDistance(a, a)).toBe(0);
  });
});

describe('cube faces', () => {
  it('has right-handed face frames (u × v = normal)', () => {
    for (const f of CUBE_FACES) {
      expect(f.uAxis.clone().cross(f.vAxis).equals(f.normal, EPS)).toBe(true);
    }
  });

  it('maps face centers to their normals and back to (0.5, 0.5)', () => {
    for (let face = 0 as CubeFace; face < CUBE_FACE_COUNT; face++) {
      const d = cubeFaceUvToDirection(face, 0.5, 0.5);
      expect(d.equals(CUBE_FACES[face].normal, EPS)).toBe(true);
      const uv = directionToCubeFace(d);
      expect(uv.face).toBe(face);
      expect(uv.u).toBeCloseTo(0.5, 12);
      expect(uv.v).toBeCloseTo(0.5, 12);
    }
  });

  it('round-trips random directions through face UV', () => {
    const r = rng(1, 'test/cube-roundtrip');
    for (let i = 0; i < 10_000; i++) {
      const d = randomDirection(r);
      const uv = directionToCubeFace(d);
      expect(uv.u).toBeGreaterThanOrEqual(0);
      expect(uv.u).toBeLessThanOrEqual(1);
      expect(uv.v).toBeGreaterThanOrEqual(0);
      expect(uv.v).toBeLessThanOrEqual(1);
      expect(cubeFaceUvToDirection(uv.face, uv.u, uv.v).equals(d, 1e-12)).toBe(true);
    }
  });

  it('agrees across shared edges', () => {
    // Every edge point of every face must lie in [0,1]² on some neighboring face.
    for (let face = 0 as CubeFace; face < CUBE_FACE_COUNT; face++) {
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        for (const [u, v] of [
          [t, 0],
          [t, 1],
          [0, t],
          [1, t],
        ] as const) {
          const d = cubeFaceUvToDirection(face, u, v);
          let onNeighbor = false;
          for (let other = 0 as CubeFace; other < CUBE_FACE_COUNT; other++) {
            if (other === face || d.dot(CUBE_FACES[other].normal) <= 0) continue;
            const p = projectToCubeFace(d, other);
            const inside = (x: number) => x >= -1e-12 && x <= 1 + 1e-12;
            if (!inside(p.u) || !inside(p.v)) continue;
            onNeighbor = true;
            expect(cubeFaceUvToDirection(other, p.u, p.v).equals(d, 1e-12)).toBe(true);
          }
          expect(onNeighbor).toBe(true);
        }
      }
    }
  });

  it('keeps cell areas within a 1.5x ratio (equi-angular warp)', () => {
    const n = 64;
    const a = new Vec3d();
    const b = new Vec3d();
    const c = new Vec3d();
    const d = new Vec3d();
    let min = Infinity;
    let max = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        cubeFaceUvToDirection(CubeFace.PosZ, i / n, j / n, a);
        cubeFaceUvToDirection(CubeFace.PosZ, (i + 1) / n, j / n, b);
        cubeFaceUvToDirection(CubeFace.PosZ, i / n, (j + 1) / n, c);
        cubeFaceUvToDirection(CubeFace.PosZ, (i + 1) / n, (j + 1) / n, d);
        // Approximate the cell as two planar triangles.
        const ab = b.clone().sub(a);
        const ac = c.clone().sub(a);
        const db = b.clone().sub(d);
        const dc = c.clone().sub(d);
        const area = (ab.cross(ac).length() + db.cross(dc).length()) / 2;
        min = Math.min(min, area);
        max = Math.max(max, area);
      }
    }
    expect(max / min).toBeLessThan(1.5);
  });
});
