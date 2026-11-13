import { describe, expect, it } from 'vitest';
import { rng } from '../src/core/rng';
import { PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { sphereOutsideView } from '../src/render/common/terrain/quadtree';
import { instanceExtent, instanceSphere } from '../src/render/sim/instanceBounds';
import { shuffled, thinKeep, THIN_MIN, THIN_START } from '../src/render/sim/forest/forestLayer';

const R = PLANET_RADIUS;

describe('instance bounds (decision 131)', () => {
  it('contains every instance as drawn, at any exaggeration', () => {
    const r = rng(5, 'instance-bounds');
    const origin = new Vec3d(0.3, 0.8, 0.52).normalize().scale(R);
    const up0 = origin.clone().normalize();
    // Ten floats per instance: base xyz relative to the origin, up xyz, height, three more.
    const n = 500;
    const data = new Float32Array(n * 10);
    const points: { base: Vec3d; up: Vec3d; h: number }[] = [];
    for (let i = 0; i < n; i++) {
      // Points on the sphere within 2 km of the origin.
      const east = new Vec3d(0, 1, 0).cross(up0).normalize();
      const north = up0.clone().cross(east);
      const d = up0
        .clone()
        .addScaled(east, r.range(-2000, 2000) / R)
        .addScaled(north, r.range(-2000, 2000) / R)
        .normalize();
      const base = d.clone().scale(R).sub(origin);
      const h = r.range(-50, 3000);
      data.set([base.x, base.y, base.z, d.x, d.y, d.z, h], i * 10);
      points.push({ base, up: d, h });
    }
    const extent = instanceExtent([data], 10);
    for (const ex of [1, 4, 40]) {
      const center = new Vec3d();
      const radius = instanceSphere(origin, extent, ex, 0, center);
      for (const p of points) {
        const drawn = origin
          .clone()
          .add(p.base)
          .addScaled(p.up, p.h * ex);
        expect(drawn.distanceTo(center)).toBeLessThanOrEqual(radius * 1.0001 + 1);
      }
    }
  });

  it('culls spheres behind or beside the camera and keeps those straddling the frustum', () => {
    const eye = new Vec3d(0, 0, R + 500);
    const view = {
      eye,
      forward: new Vec3d(1, 0, 0),
      up: new Vec3d(0, 0, 1),
      fovY: Math.PI / 3,
      aspect: 16 / 9,
    };
    const at = (x: number, y: number, z: number) => eye.clone().add(new Vec3d(x, y, z));
    expect(sphereOutsideView(at(3000, 0, 0), 100, view)).toBe(false); // ahead
    expect(sphereOutsideView(at(-3000, 0, 0), 100, view)).toBe(true); // behind
    expect(sphereOutsideView(at(-3000, 0, 0), 3100, view)).toBe(false); // around the eye
    expect(sphereOutsideView(at(1000, 5000, 0), 100, view)).toBe(true); // far to the side
    expect(sphereOutsideView(at(1000, 5000, 0), 4500, view)).toBe(false); // reaching into view
  });
});

describe('tree thinning (decision 131)', () => {
  it('keeps every clump within 1.5 km, then (1.5 km / d)², at least a quarter', () => {
    expect(thinKeep(0)).toBe(1);
    expect(thinKeep(THIN_START)).toBe(1);
    expect(thinKeep(2 * THIN_START)).toBeCloseTo(0.25, 10);
    expect(thinKeep(1.2 * THIN_START)).toBeCloseTo(1 / 1.44, 10);
    expect(thinKeep(5000)).toBe(THIN_MIN);
    for (let d = 0; d < 6000; d += 100) expect(thinKeep(d + 100)).toBeLessThanOrEqual(thinKeep(d));
  });

  it('shuffles rows deterministically, as a permutation', () => {
    const stride = 3;
    const data = Float32Array.from(
      { length: 300 },
      (_, i) => Math.floor(i / stride) * 10 + (i % stride),
    );
    const a = shuffled(data, stride, 'tile/conifer');
    expect(a).toEqual(shuffled(data, stride, 'tile/conifer'));
    expect(a).not.toEqual(data);
    expect(shuffled(data, stride, 'tile/broadleaf')).not.toEqual(a);
    // Rows stay whole, and every row appears once.
    const rows = new Set<number>();
    for (let i = 0; i < a.length; i += stride) {
      expect(a[i + 1]).toBe(a[i]! + 1);
      expect(a[i + 2]).toBe(a[i]! + 2);
      rows.add(a[i]!);
    }
    expect(rows.size).toBe(100);
  });
});
