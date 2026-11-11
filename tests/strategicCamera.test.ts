import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  focusRange,
  STRATEGIC_CAMERA_LIMITS,
  STRATEGIC_CEILING,
  STRATEGIC_FLOOR,
  STRATEGIC_MAX_TILT,
  STRATEGIC_TILT_START,
  StrategicCamera,
  strategicTilt,
} from '../src/render/strategic/strategicCamera';

const R = 1000 * KM;

describe('strategic tilt curve', () => {
  it('looks straight down from 1,500 km up and tilts 50° at the floor', () => {
    expect(STRATEGIC_MAX_TILT).toBeCloseTo(50 * DEG, 12);
    expect(strategicTilt(STRATEGIC_CEILING)).toBe(0);
    expect(strategicTilt(STRATEGIC_TILT_START)).toBe(0);
    expect(strategicTilt(STRATEGIC_FLOOR)).toBeCloseTo(STRATEGIC_MAX_TILT, 12);
    expect(strategicTilt(10 * KM)).toBeCloseTo(STRATEGIC_MAX_TILT, 12);
  });

  it('eases monotonically and smoothly in between', () => {
    let prev = Infinity;
    let maxStep = 0;
    const steps = 200;
    const lo = Math.log(STRATEGIC_FLOOR);
    const hi = Math.log(STRATEGIC_TILT_START);
    for (let i = 0; i <= steps; i++) {
      const t = strategicTilt(Math.exp(lo + ((hi - lo) * i) / steps));
      expect(t).toBeLessThanOrEqual(prev);
      if (i > 0) maxStep = Math.max(maxStep, prev - t);
      prev = t;
    }
    // Smoothstep: the steepest step is 1.5× the mean, and the ends are flat.
    expect(maxStep).toBeLessThan((1.6 * STRATEGIC_MAX_TILT) / steps);
    const nearFloor = strategicTilt(STRATEGIC_FLOOR * 1.01);
    expect(STRATEGIC_MAX_TILT - nearFloor).toBeLessThan(0.002);
    // Halfway in log altitude (about 390 km), half the tilt.
    expect(strategicTilt(Math.exp((lo + hi) / 2))).toBeCloseTo(STRATEGIC_MAX_TILT / 2, 12);
  });
});

describe('StrategicCamera', () => {
  it('clamps the altitude between the floor and the ceiling', () => {
    const o = new StrategicCamera(R);
    expect(o.altitude).toBeCloseTo(STRATEGIC_CEILING, 3);
    o.targetAltitude = 2 * KM;
    o.update(0);
    expect(o.altitude).toBeCloseTo(STRATEGIC_FLOOR, 3);
    o.zoom(10);
    o.update(0);
    expect(o.altitude).toBeCloseTo(STRATEGIC_CEILING, 3);
    o.zoomAt(1e-3, 0, 0, 0.001);
    expect(o.altitude).toBeCloseTo(STRATEGIC_FLOOR, 3);
  });

  it('puts the eye at its altitude and looks at the focus, at any tilt', () => {
    const o = new StrategicCamera(R);
    o.lat = 20 * DEG;
    o.lon = -40 * DEG;
    o.heading = 70 * DEG;
    const focus = latLonToDirection(o.lat, o.lon, new Vec3d()).scale(R);
    for (const h of [STRATEGIC_CEILING, 800 * KM, 300 * KM, STRATEGIC_FLOOR]) {
      o.altitude = o.targetAltitude = h;
      o.update(0);
      expect(o.tilt).toBeCloseTo(strategicTilt(h), 12);
      expect(o.eye.length() - R).toBeCloseTo(h, 2);
      const toFocus = focus.clone().sub(o.eye);
      expect(toFocus.length()).toBeCloseTo(o.range, 2);
      expect(toFocus.normalize().dot(o.forward)).toBeCloseTo(1, 12);
      expect(o.up.dot(o.forward)).toBeCloseTo(0, 12);
      expect(o.up.length()).toBeCloseTo(1, 12);
      expect(o.near).toBeGreaterThan(1000);
      expect(o.far).toBeGreaterThan(o.range);
    }
  });

  it('keeps the horizon just out of a 45° frame at the floor', () => {
    const o = new StrategicCamera(R);
    o.altitude = o.targetAltitude = STRATEGIC_FLOOR;
    o.update(0);
    const down = o.eye.clone().normalize().scale(-1);
    const axisFromNadir = Math.acos(o.forward.dot(down));
    const topBelowHorizontal = Math.PI / 2 - axisFromNadir - 22.5 * DEG;
    const horizonDip = Math.acos(R / (R + STRATEGIC_FLOOR));
    expect(topBelowHorizontal).toBeLessThan(horizonDip);
    expect(topBelowHorizontal).toBeGreaterThan(horizonDip - 3 * DEG);
  });

  it('pans with the keys and the drag, and turns but never tilts by hand', () => {
    const o = new StrategicCamera(R);
    o.lat = 0;
    o.lon = 0;
    o.heading = 0;
    o.update(0);
    o.drag(0, 100, 0.001);
    expect(o.lat).toBeGreaterThan(0); // dragging down pulls the ground south: focus moves north
    const lat = o.lat;
    o.tiltBy(-500);
    o.turnBy(100);
    o.update(0);
    expect(o.tilt).toBe(0);
    expect(o.heading).toBeCloseTo(0.5, 12);
    o.input.forward = 1;
    o.update(0.1);
    expect(Math.hypot(o.lat - lat, o.lon)).toBeGreaterThan(0);
  });

  it('ranges agree with the eye geometry', () => {
    const { floor, maxTilt } = STRATEGIC_CAMERA_LIMITS;
    // Straight down, the range is the altitude.
    expect(focusRange(R, floor, 0)).toBeCloseTo(floor, 6);
    // Tilted, the eye is farther from the focus than its altitude.
    expect(focusRange(R, floor, maxTilt)).toBeGreaterThan(floor);
  });
});
