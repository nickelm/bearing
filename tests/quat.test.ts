import { describe, expect, it } from 'vitest';
import { Quatd } from '../src/core/quat';
import { Vec3d } from '../src/core/vec3d';

describe('Quatd', () => {
  it('builds from axes and rotates body vectors into them', () => {
    const fwd = new Vec3d(0, 0, 1);
    const right = new Vec3d(1, 0, 0);
    const down = fwd.clone().cross(right);
    const q = Quatd.fromAxes(fwd, right, down);
    const x = q.rotate(new Vec3d(1, 0, 0));
    expect(x.distanceTo(fwd)).toBeLessThan(1e-12);
    expect(q.rotate(new Vec3d(0, 1, 0)).distanceTo(right)).toBeLessThan(1e-12);
    const back = q.unrotate(x);
    expect(back.distanceTo(new Vec3d(1, 0, 0))).toBeLessThan(1e-12);
  });

  it('integrates a constant body rate exactly', () => {
    const q = new Quatd();
    for (let i = 0; i < 1000; i++) q.integrateBodyRates(0, 0, Math.PI / 2, 0.001);
    // A quarter turn about body z: x goes to y.
    expect(q.rotate(new Vec3d(1, 0, 0)).distanceTo(new Vec3d(0, 1, 0))).toBeLessThan(1e-9);
  });
});
