import { describe, expect, it } from 'vitest';
import { DEFAULT_ORBIT_LIMITS, OrbitCamera } from '../src/render/orbitCamera';
import { DEG, KM, PLANET_RADIUS } from '../src/core/units';

describe('OrbitCamera', () => {
  it('places the eye at radius + altitude and looks at nadir with zero tilt', () => {
    const cam = new OrbitCamera(PLANET_RADIUS, DEFAULT_ORBIT_LIMITS, 100 * KM);
    expect(cam.eye.length()).toBeCloseTo(PLANET_RADIUS + 100 * KM, 6);
    const radial = cam.eye.clone().normalize();
    expect(cam.forward.dot(radial)).toBeCloseTo(-1, 12);
    expect(Math.abs(cam.up.dot(cam.forward))).toBeLessThan(1e-12);
  });

  it('clamps zoom to 10 km .. 5,000 km', () => {
    const cam = new OrbitCamera();
    cam.zoom(-100);
    cam.update(0);
    expect(cam.altitude).toBeCloseTo(10 * KM, 6);
    cam.zoom(100);
    cam.update(0);
    expect(cam.altitude).toBeCloseTo(5000 * KM, 6);
  });

  it('keeps near below the altitude and far at the horizon', () => {
    for (const h of [10 * KM, 500 * KM, 5000 * KM]) {
      const cam = new OrbitCamera(PLANET_RADIUS, DEFAULT_ORBIT_LIMITS, h);
      const horizon = Math.sqrt(h * (2 * PLANET_RADIUS + h));
      expect(cam.near).toBeLessThan(h);
      expect(cam.far).toBeGreaterThanOrEqual(horizon);
      expect(cam.far / cam.near).toBeLessThan(40);
    }
  });

  it('clamps latitude and tilt', () => {
    const cam = new OrbitCamera();
    cam.drag(0, 1e9, 1);
    expect(cam.lat).toBeCloseTo(89.9 * DEG, 12);
    cam.tiltBy(-1e9);
    expect(cam.tilt).toBeCloseTo(75 * DEG, 12);
  });
});
