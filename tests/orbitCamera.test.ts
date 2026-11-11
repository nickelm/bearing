import { describe, expect, it } from 'vitest';
import { DEFAULT_ORBIT_LIMITS, OrbitCamera, twoFingerStep } from '../src/render/sim/orbitCamera';
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

  it('pinch zoom changes altitude at once and keeps the ground under the pinch center', () => {
    const rpp = (50 * DEG) / 1000;
    const cam = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, 20 * KM);
    cam.lat = 0;
    cam.lon = 0;
    cam.update(0);
    // Ground point 200 px right of center (east at heading 0): 200·rpp·h meters east.
    const groundEast = 200 * rpp * cam.heightAboveGround;
    cam.zoomAt(0.5, 200, 0, rpp);
    expect(cam.altitude).toBeCloseTo(10 * KM, 6);
    expect(cam.targetAltitude).toBeCloseTo(10 * KM, 6);
    // After zooming, that point is again 200 px right of center.
    const camEast = cam.lon * R;
    expect((groundEast - camEast) / (rpp * cam.heightAboveGround)).toBeCloseTo(200, 3);
    expect(cam.lat).toBeCloseTo(0, 12);
  });

  it('twist about the center only turns the heading', () => {
    const cam = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, 20 * KM);
    const { lat, lon } = cam;
    cam.rotateAt(0.3, 0, 0, 0.001);
    expect(cam.heading).toBeCloseTo(-0.3, 12);
    expect(cam.lat).toBe(lat);
    expect(cam.lon).toBe(lon);
  });

  it('twist about an off-center point keeps that point fixed', () => {
    const rpp = 0.001;
    const cam = new OrbitCamera(R, DEFAULT_ORBIT_LIMITS, 20 * KM);
    cam.lat = 0;
    cam.lon = 0;
    cam.update(0);
    // Ground point 100 px right of center: east of the camera.
    const k = rpp * cam.heightAboveGround;
    const target = { east: 100 * k, north: 0 };
    cam.rotateAt(Math.PI / 2, 100, 0, rpp);
    // Heading is now west, so screen-right points north: the target must sit
    // 100 px north of the camera, which puts the camera 100 px south of it.
    expect(cam.heading).toBeCloseTo(-Math.PI / 2, 12);
    expect((cam.lon * R) / k).toBeCloseTo(target.east / k, 2);
    expect((cam.lat * R) / k).toBeCloseTo(target.north / k - 100, 2);
  });
});

describe('twoFingerStep', () => {
  it('reports spread, centroid motion and clockwise rotation', () => {
    const g = twoFingerStep({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 200 });
    expect(g.scale).toBeCloseTo(2, 12);
    expect(g.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(g.cx).toBe(10);
    expect(g.cy).toBe(100);
    expect(g.dx).toBe(-40);
    expect(g.dy).toBe(100);
  });

  it('ignores scale and rotation when the fingers nearly touch', () => {
    const g = twoFingerStep({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 });
    expect(g.scale).toBe(1);
    expect(g.rotation).toBe(0);
  });
});
