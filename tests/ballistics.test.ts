/** A released store's fall (decision 294). */
import { describe, expect, it } from 'vitest';
import { Quatd } from '../src/core/quat';
import { Vec3d } from '../src/core/vec3d';
import { stepFalling } from '../src/sim/flight/ballistics';

const R = 6_371_000;

describe('a falling store (decision 294)', () => {
  it('falls to the ground from 3 km in about the vacuum time, losing speed to drag', () => {
    const s = {
      pos: new Vec3d(0, 0, R + 3000),
      vel: new Vec3d(200, 0, 0),
      q: new Quatd(),
      mass: 140,
      dragArea: 0.045,
      tumble: [0.25, -0.5, 0.12] as [number, number, number],
    };
    let t = 0;
    while (s.pos.length() - R > 0 && t < 120) {
      stepFalling(s, 1 / 60, R);
      t += 1 / 60;
    }
    // In a vacuum 24.7 s; an empty tank is slowed a little.
    expect(t).toBeGreaterThan(24.7);
    expect(t).toBeLessThan(32);
    expect(s.vel.x).toBeLessThan(200);
    expect(s.vel.x).toBeGreaterThan(50);
  });
});
