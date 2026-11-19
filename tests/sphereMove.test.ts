import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { moveOnSphere } from '../src/render/common/sphereMove';
import { StrategicCamera } from '../src/render/strategic/strategicCamera';

const R = 6000 * KM;

/** World direction of "up the screen" at a place. */
function aheadOf(p: { lat: number; lon: number; heading: number }): Vec3d {
  const n = latLonToDirection(p.lat, p.lon);
  const east = new Vec3d(0, 1, 0).cross(n).normalize();
  const north = n.clone().cross(east);
  return north.scale(Math.cos(p.heading)).addScaled(east, Math.sin(p.heading));
}

describe('moveOnSphere (decision 246)', () => {
  it('pans straight over a pole and down the other side', () => {
    const p = { lat: 80 * DEG, lon: 10 * DEG, heading: 0 };
    const step = (R * DEG) / 10;
    for (let i = 0; i < 200; i++) moveOnSphere(p, step, 0, R);
    // 20° of arc from 80° N heading north: over the pole to 80° N on the far meridian, heading south.
    expect(p.lat / DEG).toBeCloseTo(80, 6);
    expect(p.lon / DEG).toBeCloseTo(-170, 6);
    expect(Math.abs(p.heading) / DEG).toBeCloseTo(180, 6);
  });

  it('keeps up the screen steady under small drags beside the pole', () => {
    const p = { lat: 89.99 * DEG, lon: 0, heading: 0.3 };
    let prev = aheadOf(p);
    for (let i = 0; i < 400; i++) {
      // A circle of drags around the pole, 100 m each.
      moveOnSphere(p, 100 * Math.cos(i * 0.05), 100 * Math.sin(i * 0.05), R);
      const a = aheadOf(p);
      // Up the screen turns by at most the arc moved, never by the change in longitude.
      expect(a.dot(prev)).toBeGreaterThan(Math.cos(1e-3));
      prev = a;
    }
  });

  it('moves the strategic camera over the pole without stopping', () => {
    const cam = new StrategicCamera(R);
    cam.lat = 88 * DEG;
    cam.lon = 40 * DEG;
    cam.heading = 0;
    cam.move(4 * DEG * R, 0);
    expect(cam.lat / DEG).toBeCloseTo(88, 6);
    expect(cam.lon / DEG).toBeCloseTo(-140, 6);
  });
});
