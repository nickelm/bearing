import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import type { Dir } from '../src/core/greatCircle';
import { DEG } from '../src/core/units';
import { AIRCRAFT_TYPES } from '../src/sim/air/aircraft';
import { analyticPose } from '../src/sim/air/analyticPose';
import { FORMATION_CHANGE, formationAt, slotOffset, slotPose } from '../src/sim/air/formation';
import type { Formation } from '../src/sim/air/formation';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import { routeTimeline } from '../src/sim/air/route';
import { planMissionRoute } from '../src/sim/air/missionRoute';
import { MISSION_PLUGINS } from '../src/sim/command/missions/registry';

const R = 1_000_000;
const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};
const type = AIRCRAFT_TYPES.find((t) => t.role === 'air-superiority')!;
const route = planMissionRoute({
  type,
  loadout: type.loadouts[0]!,
  profile: MISSION_PROFILES.cap,
  radius: R,
  rangeFactor: 1,
  basePoint: () => dir(40, 10),
  carrierBased: false,
  target: dir(42, 13),
  launch: 0,
})!;
const timeline = routeTimeline(route);
const at = (phase: string) => timeline.find((e) => e.phase === phase)!.time;

describe('formations', () => {
  it('name a formation for every phase of every registered mission type', () => {
    expect(MISSION_PLUGINS.length).toBeGreaterThan(0);
    for (const p of MISSION_PLUGINS) {
      for (const phase of [
        'departure',
        'climb-out',
        'ingress',
        'on-target',
        'egress',
        'approach',
      ] as const)
        expect(p.formations[phase], `${p.type} ${phase}`).toBeDefined();
    }
  });

  it('change formation with the phase, eased over FORMATION_CHANGE', () => {
    const f: Partial<Record<string, Formation>> = { ingress: 'route', 'fence-in': 'spread' };
    const t0 = at('fence-in');
    // Phases without a formation of their own fly the fallback, route.
    expect(formationAt(timeline, f, t0 - 1)).toMatchObject({ from: 'route', to: 'route' });
    const start = formationAt(timeline, f, t0);
    expect(start).toMatchObject({ from: 'route', to: 'spread', blend: 0 });
    const half = formationAt(timeline, f, t0 + FORMATION_CHANGE / 2);
    expect(half.blend).toBeCloseTo(0.5, 9);
    expect(formationAt(timeline, f, t0 + FORMATION_CHANGE).blend).toBe(1);
  });

  it('spread the flight line abreast in combat spread and close it near the field', () => {
    const lead = analyticPose(route, (at('on-target') + at('egress')) / 2, R);
    const span = 10;
    const pos = (formation: Formation, k: number) => {
      const p = slotPose(lead, k, { from: formation, to: formation, blend: 1 }, span);
      return Math.hypot(p.pos[0] - lead.pos[0], p.pos[1] - lead.pos[1], p.pos[2] - lead.pos[2]);
    };
    // Combat spread is a nautical mile abeam whatever the span (decision 258).
    expect(pos('spread', 1)).toBeCloseTo(Math.hypot(30, 1852), 0);
    expect(pos('close', 1)).toBeLessThan(30);
    expect(pos('trail', 1)).toBeGreaterThan(pos('route', 1));
    // Slots past the fourth repeat further back.
    expect(slotOffset('route', 4)[0]).toBeGreaterThan(slotOffset('route', 1)[0]);
  });

  it('keep the wingmen level with a banked lead', () => {
    // The lead banks in the racetrack's turns: a wingman abeam stays at its height.
    const orbit = route.segments.find((s) => s.kind === 'orbit')!;
    let worst = 0;
    for (let t = orbit.t0 + 30; t < orbit.t1 - 30; t += 20) {
      const lead = analyticPose(route, t, R);
      const two = slotPose(lead, 1, { from: 'spread', to: 'spread', blend: 1 }, 10);
      worst = Math.max(worst, Math.abs(Math.hypot(...two.pos) - Math.hypot(...lead.pos)));
    }
    // The slot is in the lead's tangent plane: a mile abeam it sits d²/2R higher on this
    // small test planet (1.7 m), and no more for the bank.
    expect(worst).toBeLessThan(1 + 1852 ** 2 / (2 * R));
  });
});

describe('a formation in a turn', () => {
  it('flies the outside wingman faster and the inside one slower', () => {
    const orbit = route.segments.find((s) => s.kind === 'orbit')!;
    // A moment in a racetrack's turn (it banks left: the left side is inside).
    let lead = analyticPose(route, orbit.t0 + 30, R);
    for (let t = orbit.t0 + 30; t < orbit.t1; t += 5) {
      lead = analyticPose(route, t, R);
      if (Math.abs(lead.bank) > 20 * DEG) break;
    }
    expect(Math.abs(lead.bank)).toBeGreaterThan(20 * DEG);
    const spread = { from: 'spread', to: 'spread', blend: 1 } as const;
    const right = slotPose(lead, 1, spread, 10);
    const left = slotPose(lead, 2, spread, 10);
    const [outside, inside] = lead.bank < 0 ? [right, left] : [left, right];
    expect(outside.speed).toBeGreaterThan(lead.speed * 1.02);
    expect(inside.speed).toBeLessThan(lead.speed * 0.98);
  });
});
