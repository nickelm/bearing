import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { arcDistance, initialHeading } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { DEG } from '../src/core/units';
import { AIRCRAFT_TYPES } from '../src/sim/air/aircraft';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import { PASS_HALF, planMissionRoute } from '../src/sim/air/missionRoute';

const R = 1_000_000;
const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe('the egress off a target', () => {
  // A penetrator on interdiction: low, a pass over the target, home behind it.
  const type = AIRCRAFT_TYPES.find((t) => t.role === 'deep-strike' && t.side === 'alliance')!;
  const target = dir(44, 15);
  const route = planMissionRoute({
    type,
    loadout: type.loadouts[0]!,
    profile: MISSION_PROFILES.interdiction,
    radius: R,
    rangeFactor: 1,
    basePoint: () => dir(40, 10),
    carrierBased: false,
    target,
    launch: 0,
  })!;
  const legs = route.segments.filter((s) => s.kind === 'leg' && s.phase === 'egress');

  it('turns through a radius: no corner of more than the turn step', () => {
    expect(legs.length).toBeGreaterThan(3);
    let worst = 0;
    for (let i = 1; i < legs.length; i++) {
      const a = initialHeading(legs[i - 1]!.b, legs[i - 1]!.a) + Math.PI;
      const b = initialHeading(legs[i]!.a, legs[i]!.b);
      worst = Math.max(worst, Math.abs(wrap(b - a)));
    }
    expect(worst).toBeLessThan(21 * DEG);
  });

  it('does not fly back over the target', () => {
    let nearest = Infinity;
    for (const s of legs) {
      for (let f = 0; f <= 1; f += 0.1) {
        const p: Dir = [
          s.a[0] + (s.b[0] - s.a[0]) * f,
          s.a[1] + (s.b[1] - s.a[1]) * f,
          s.a[2] + (s.b[2] - s.a[2]) * f,
        ];
        const n = Math.hypot(...p);
        nearest = Math.min(nearest, arcDistance([p[0] / n, p[1] / n, p[2] / n], target, R));
      }
    }
    expect(nearest).toBeGreaterThan(PASS_HALF * 0.5);
  });
});
