import { describe, expect, it } from 'vitest';
import { DEG, KM } from '../src/core/units';
import { OrbitCamera } from '../src/render/common/orbitCamera';
import {
  STRATEGIC_CEILING,
  STRATEGIC_FLOOR,
  STRATEGIC_MAX_TILT,
  STRATEGIC_ORBIT_LIMITS,
} from '../src/render/strategic/strategicScene';

describe('strategic view camera limits', () => {
  const R = 1000 * KM;

  it('keeps the camera between the zoom floor and the ceiling', () => {
    const o = new OrbitCamera(R, STRATEGIC_ORBIT_LIMITS);
    expect(o.altitude).toBeCloseTo(STRATEGIC_CEILING, 3);
    o.targetAltitude = 2 * KM; // a simulation-view altitude
    o.update(0);
    expect(o.altitude).toBeCloseTo(STRATEGIC_FLOOR, 6);
    o.zoom(10);
    o.update(0);
    expect(o.altitude).toBeCloseTo(STRATEGIC_CEILING, 6);
  });

  it('stays at the floor even over the highest terrain', () => {
    const o = new OrbitCamera(R, STRATEGIC_ORBIT_LIMITS);
    o.terrainMaxHeight = 6 * KM; // 4× exaggerated peaks
    o.targetAltitude = 0;
    o.update(0);
    expect(o.altitude).toBeGreaterThanOrEqual(STRATEGIC_FLOOR);
    expect(o.altitude).toBeLessThan(STRATEGIC_FLOOR + 1);
  });

  it('never tilts past the strategic maximum', () => {
    const o = new OrbitCamera(R, STRATEGIC_ORBIT_LIMITS);
    o.targetAltitude = STRATEGIC_FLOOR;
    o.update(0);
    o.tiltBy(-100_000);
    o.update(0);
    expect(o.tilt).toBeCloseTo(STRATEGIC_MAX_TILT, 9);
    expect(STRATEGIC_MAX_TILT).toBeCloseTo(50 * DEG, 12);
  });
});
