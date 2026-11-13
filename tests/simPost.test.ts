/**
 * The CPU side of the simulation view's post-processing (src/render/sim/post/):
 * the time-of-day grade and the view-ray and depth arithmetic the shaders mirror.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { DEG } from '../src/core/units';
import { GRADE_BANDS, gradeAt, gradeWeights } from '../src/render/sim/post/grade';
import {
  reversedDepthFromViewDepth,
  viewDepthFromReversedDepth,
  viewRay,
  viewRayAxes,
} from '../src/render/sim/post/viewRays';

describe('time-of-day grade', () => {
  it('weights the bands to one at every sun elevation', () => {
    for (let e = -90; e <= 90; e += 0.5) {
      for (const morning of [-1, 0, 0.3, 1]) {
        const w = gradeWeights(e * DEG, morning);
        const sum = w.night + w.dawn + w.dusk + w.golden + w.day;
        expect(sum).toBeCloseTo(1, 12);
        for (const v of Object.values(w)) expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('puts each band where the sun is', () => {
    expect(gradeWeights(40 * DEG, 0).day).toBe(1);
    expect(gradeWeights(4 * DEG, 0).golden).toBeGreaterThan(0.9);
    expect(gradeWeights(-4.5 * DEG, -1).dusk).toBeGreaterThan(0.9);
    expect(gradeWeights(-4.5 * DEG, 1).dawn).toBeGreaterThan(0.9);
    expect(gradeWeights(-4.5 * DEG, 1).dusk).toBe(0);
    expect(gradeWeights(-20 * DEG, 0).night).toBe(1);
  });

  it('changes smoothly as the sun moves', () => {
    let last = gradeAt(-30 * DEG, -1);
    for (let e = -30 + 0.05; e <= 30; e += 0.05) {
      const g = gradeAt(e * DEG, -1);
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(g.gain[i]! - last.gain[i]!)).toBeLessThan(0.004);
        expect(Math.abs(g.lift[i]! - last.lift[i]!)).toBeLessThan(0.001);
      }
      expect(Math.abs(g.saturation - last.saturation)).toBeLessThan(0.004);
      last = g;
    }
  });

  it('is warm at golden hour, violet at dusk, blue at night, pale at midday', () => {
    const golden = gradeAt(4 * DEG, 0);
    expect(golden.gain[0]).toBeGreaterThan(golden.gain[2] + 0.1);
    const dusk = gradeAt(-4.5 * DEG, -1);
    expect(dusk.gain[0]).toBeGreaterThan(dusk.gain[1]);
    expect(dusk.gain[2]).toBeGreaterThan(dusk.gain[1]);
    const night = gradeAt(-30 * DEG, 0);
    expect(night.gain[2]).toBeGreaterThan(night.gain[0] + 0.2);
    expect(night.saturation).toBeLessThan(0.9);
    const day = gradeAt(60 * DEG, 0);
    expect(day.saturation).toBeLessThan(1);
    expect(day).toEqual(GRADE_BANDS.day);
    // Subtle: no band moves a channel by more than a sixth, or black by more than five steps.
    for (const band of Object.values(GRADE_BANDS)) {
      for (const g of band.gain) expect(Math.abs(g - 1)).toBeLessThan(0.17);
      for (const l of band.lift) expect(l).toBeLessThanOrEqual(5 / 255);
    }
    // The bloom threshold rises with the daylight.
    expect(night.bloom).toBeLessThan(dusk.bloom);
    expect(dusk.bloom).toBeLessThan(golden.bloom);
    expect(golden.bloom).toBeLessThan(day.bloom);
  });
});

describe('view rays and reversed depth', () => {
  it('recovers the view depth from a float32 depth across the range of the planes', () => {
    const near = 1;
    const far = 800_000;
    for (const z of [1, 1.5, 12, 250, 4000, 65_000, 300_000, 799_000]) {
      const stored = Math.fround(reversedDepthFromViewDepth(z, near, far));
      // The shader's arithmetic, in float32.
      const f = Math.fround;
      const back = f(f(near * far) / f(f(stored * f(far - near)) + near));
      expect(Math.abs(back - z) / z).toBeLessThan(2e-6);
      expect(viewDepthFromReversedDepth(stored, near, far)).toBeCloseTo(back, 0);
    }
    expect(reversedDepthFromViewDepth(far, near, far)).toBe(0);
    expect(reversedDepthFromViewDepth(near, near, far)).toBeCloseTo(1, 12);
  });

  it('builds the ray through a pixel from the camera axes', () => {
    const camera = new PerspectiveCamera(50, 16 / 9, 1, 500_000);
    camera.up.set(0.2, 0.9, -0.1).normalize();
    camera.lookAt(0.3, -0.2, -0.8);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const axes = viewRayAxes(camera, {
      forward: new Vector3(),
      right: new Vector3(),
      up: new Vector3(),
    });
    const forward = camera.getWorldDirection(new Vector3());
    // The center of the screen looks along the view axis.
    expect(viewRay(axes, 0.5, 0.5).distanceTo(forward)).toBeLessThan(1e-12);
    for (const point of [
      new Vector3(120, -40, -900),
      new Vector3(-3000, 800, -9000),
      new Vector3(40_000, 9000, -200_000),
    ]) {
      // A world point (the camera is at the origin), where the camera draws it.
      const world = point.clone().applyMatrix4(camera.matrixWorld);
      const ndc = world.clone().project(camera);
      const ray = viewRay(axes, (ndc.x + 1) / 2, (1 - ndc.y) / 2);
      const depth = -point.z;
      // The ray has length 1 along the view axis: depth × ray is the point.
      expect(ray.clone().multiplyScalar(depth).distanceTo(world) / world.length()).toBeLessThan(
        1e-9,
      );
      expect(ray.dot(forward)).toBeCloseTo(1, 12);
    }
  });
});
