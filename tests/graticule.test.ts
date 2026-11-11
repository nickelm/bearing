import { describe, expect, it } from 'vitest';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  GRATICULE_TARGET_PX,
  graticuleStep,
  pickSphere,
  RING_TARGET_PX,
  ringStep,
} from '../src/render/strategic/graticule';

const R = 1000 * KM;

describe('graticule and range-ring spacing', () => {
  it('picks the finest round graticule step at least the target apart', () => {
    // At the ceiling (about 2.6 km per px), 120 px is about 18°: 30° lines.
    expect(graticuleStep(2600, R)).toBeCloseTo(30 * DEG, 12);
    // At 400 km (about 350 m per px): about 2.4°, so 5°.
    expect(graticuleStep(350, R)).toBeCloseTo(5 * DEG, 12);
    // At the floor (about 100 m per px): about 0.7°, so 1°.
    expect(graticuleStep(100, R)).toBeCloseTo(1 * DEG, 12);
    for (const scale of [50, 120, 900, 3000]) {
      const px = (graticuleStep(scale, R) * R) / scale;
      expect(px).toBeGreaterThanOrEqual(Math.min(GRATICULE_TARGET_PX, (30 * DEG * R) / scale));
    }
  });

  it('picks round ring distances at least the target apart', () => {
    expect(ringStep(100)).toBe(25e3);
    expect(ringStep(1000)).toBe(100e3);
    expect(ringStep(2600)).toBe(250e3);
    for (const scale of [80, 300, 1000, 5000]) {
      expect(ringStep(scale) / scale).toBeGreaterThanOrEqual(
        Math.min(RING_TARGET_PX, 500e3 / scale),
      );
    }
  });
});

describe('picking the ground under the cursor', () => {
  it('hits the near side of the sphere and misses beside it', () => {
    const eye = new Vec3d(0, 0, 3 * R);
    const hit = pickSphere(eye, new Vec3d(0, 0, -1), R);
    expect(hit).not.toBeNull();
    expect(hit!.z).toBeCloseTo(1, 12);
    const off = pickSphere(eye, new Vec3d(0.5, 0, -1).normalize(), R);
    expect(off).toBeNull();
    // Looking away never hits.
    expect(pickSphere(eye, new Vec3d(0, 0, 1), R)).toBeNull();
  });
});
