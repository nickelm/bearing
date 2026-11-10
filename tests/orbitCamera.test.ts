import { describe, expect, it } from 'vitest';
import { DEFAULT_ORBIT_LIMITS, OrbitCamera } from '../src/render/orbitCamera';
import { DEG, KM, PLANET_RADIUS } from '../src/core/units';

const R = PLANET_RADIUS;

describe('OrbitCamera', () => {
  it('places the eye at radius + altitude and looks at nadir with zero tilt', () => {
    const cam = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, 100 * KM);
    expect(cam.eye.length()).toBeCloseTo(R + 100 * KM, 6);
    const radial = cam.eye.clone().normalize();
    expect(cam.forward.dot(radial)).toBeCloseTo(-1, 12);
    expect(Math.abs(cam.up.dot(cam.forward))).toBeLessThan(1e-12);
  });

  it('clamps zoom between the ground clearance and 5,000 km', () => {
    const cam = new OrbitCamera();
    cam.zoom(-100);
    cam.update(0);
    // Ground unknown and no terrain: 2 km above sea level.
    expect(cam.altitude).toBeCloseTo(2 * KM, 6);
    cam.zoom(100);
    cam.update(0);
    expect(cam.altitude).toBeCloseTo(5000 * KM, 6);
  });

  it('keeps 500 m above the ground under it once the ground is known', () => {
    const cam = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, 50 * KM);
    cam.groundHeight = 1200;
    cam.zoom(-100);
    for (let i = 0; i < 100; i++) cam.update(1 / 60);
    expect(cam.altitude).toBeCloseTo(1700, 3);
    // Flying toward higher ground pushes the camera up at once.
    cam.groundHeight = 3000;
    cam.update(1 / 60);
    expect(cam.altitude).toBeGreaterThanOrEqual(3500);
  });

  it('keeps near below the clearance and far at the horizon', () => {
    for (const h of [600, 10 * KM, 500 * KM, 5000 * KM]) {
      const cam = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, h);
      cam.groundHeight = 100;
      cam.altitude = cam.targetAltitude = h;
      cam.update(0);
      const horizon = Math.sqrt(h * (2 * R + h));
      expect(cam.near).toBeLessThan(h - 100);
      expect(cam.near).toBeGreaterThanOrEqual(1);
      expect(cam.far).toBeGreaterThanOrEqual(horizon);
    }
  });

  it('tilts nearly to the horizon only at low altitude', () => {
    const high = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, 1000 * KM);
    high.tiltBy(-1e9);
    expect(high.tilt).toBeCloseTo(75 * DEG, 12);
    const low = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, 5 * KM);
    low.groundHeight = 0;
    low.altitude = low.targetAltitude = 5 * KM;
    low.update(0);
    low.tiltBy(-1e9);
    expect(low.tilt).toBeCloseTo(87 * DEG, 12);
  });

  it('moves along its heading', () => {
    const cam = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, 10 * KM);
    cam.lat = 10 * DEG;
    cam.lon = 20 * DEG;
    cam.move(1000, 0);
    expect(cam.lat).toBeCloseTo(10 * DEG + 1000 / R, 9);
    cam.heading = 90 * DEG;
    const lon0 = cam.lon;
    cam.move(1000, 0);
    expect(cam.lon).toBeGreaterThan(lon0);
    // Tilted forward, the view looks toward the heading (east here).
    cam.tilt = 60 * DEG;
    cam.update(0);
    const eastward = cam.forward.x * Math.cos(cam.lon) - cam.forward.z * Math.sin(cam.lon);
    expect(eastward).toBeGreaterThan(0.5);
  });

  it('flies with keyboard input at a speed proportional to height', () => {
    const cam = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, 2 * KM);
    cam.groundHeight = 0;
    cam.altitude = cam.targetAltitude = 2 * KM;
    const lat0 = cam.lat;
    cam.input.forward = 1;
    for (let i = 0; i < 60; i++) cam.update(1 / 60);
    const meters = (cam.lat - lat0) * R;
    expect(meters).toBeGreaterThan(1500);
    expect(meters).toBeLessThan(2500);
  });
});
