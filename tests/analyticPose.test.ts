import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { dot } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { DEG } from '../src/core/units';
import { AIRCRAFT_TYPES } from '../src/sim/air/aircraft';
import { analyticPose, MAX_BANK } from '../src/sim/air/analyticPose';
import { slotPose } from '../src/sim/air/formation';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import { planMissionRoute } from '../src/sim/air/missionRoute';

const R = 1_000_000;
const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};
const type = AIRCRAFT_TYPES.find((t) => t.role === 'air-superiority')!;
// A CAP: out to a station, a racetrack, home; corners at the station's entry.
const route = planMissionRoute({
  type,
  loadout: type.loadouts[0]!,
  profile: MISSION_PROFILES.cap,
  radius: R,
  rangeFactor: 1,
  basePoint: () => dir(40, 10),
  carrierBased: false,
  target: dir(44, 14),
  launch: 0,
})!;
const end = route.segments[route.segments.length - 1]!.t1;

describe('the analytic pose', () => {
  it('keeps nose, top and velocity consistent, and the position on the route', () => {
    for (let t = 0; t <= end; t += 37) {
      const p = analyticPose(route, t, R);
      expect(Math.hypot(...p.forward)).toBeCloseTo(1, 9);
      expect(Math.hypot(...p.up)).toBeCloseTo(1, 9);
      expect(Math.abs(dot(p.forward, p.up))).toBeLessThan(1e-9);
      expect(Math.abs(p.bank)).toBeLessThanOrEqual(MAX_BANK + 1e-12);
      expect(Math.hypot(...p.pos)).toBeCloseTo(R + Math.max(0, p.altitude), 3);
      if (!p.airborne) expect(p.bank).toBe(0);
    }
  });

  it('turns smoothly through the route’s corners and banks into the turn', () => {
    let worst = 0;
    let banked = 0;
    const step = 0.25;
    let prev = analyticPose(route, 600, R);
    for (let t = 600 + step; t < end - 600; t += step) {
      const p = analyticPose(route, t, R);
      if (p.airborne && prev.airborne) {
        const dh = Math.abs(
          Math.atan2(Math.sin(p.heading - prev.heading), Math.cos(p.heading - prev.heading)),
        );
        worst = Math.max(worst, dh / step);
        if (Math.abs(p.bank) > 10 * DEG) banked++;
      }
      prev = p;
    }
    // No snap: a turn rate under 30°/s anywhere (a corner would be infinite), and some banking.
    expect(worst).toBeLessThan(30 * DEG);
    expect(banked).toBeGreaterThan(0);
  });

  it('banks right in a right turn: the top tips toward the turn', () => {
    // The racetrack turns left (counterclockwise seen from above), so its turns bank left.
    const orbit = route.segments.find((s) => s.kind === 'orbit')!;
    let left = 0;
    let right = 0;
    for (let t = orbit.t0 + 30; t < orbit.t1 - 30; t += 5) {
      const b = analyticPose(route, t, R).bank;
      if (b < -5 * DEG) left++;
      if (b > 5 * DEG) right++;
    }
    expect(left).toBeGreaterThan(right);
  });

  it('puts wingmen behind and beside the lead (route: #2 left, #3 right)', () => {
    const lead = analyticPose(route, (route.segments[2]!.t0 + route.segments[2]!.t1) / 2, R);
    const two = slotPose(lead, 1);
    const three = slotPose(lead, 2);
    const rel = (p: typeof lead) =>
      [p.pos[0] - lead.pos[0], p.pos[1] - lead.pos[1], p.pos[2] - lead.pos[2]] as Dir;
    expect(dot(rel(two), lead.forward)).toBeLessThan(0);
    const right: Dir = [
      lead.forward[1] * lead.up[2] - lead.forward[2] * lead.up[1],
      lead.forward[2] * lead.up[0] - lead.forward[0] * lead.up[2],
      lead.forward[0] * lead.up[1] - lead.forward[1] * lead.up[0],
    ];
    expect(dot(rel(two), right)).toBeLessThan(0);
    expect(dot(rel(three), right)).toBeGreaterThan(0);
  });
});

describe('the analytic pose’s speed', () => {
  it('eases from leg to leg instead of stepping (decision 259)', () => {
    // The route's own speed steps at segment boundaries (climb, cruise, loiter, egress).
    let steps = 0;
    for (let i = 1; i < route.segments.length; i++) {
      const a = route.segments[i - 1]!;
      const b = route.segments[i]!;
      if (a.kind !== 'ground' && b.kind !== 'ground' && Math.abs(a.speed - b.speed) > 5) steps++;
    }
    expect(steps).toBeGreaterThan(0);
    let worst = 0;
    let prev = NaN;
    for (let t = route.segments[1]!.t0 + 30; t < end - 600; t += 0.25) {
      const p = analyticPose(route, t, R);
      if (!p.airborne) continue;
      if (Number.isFinite(prev)) worst = Math.max(worst, Math.abs(p.speed - prev) / 0.25);
      prev = p.speed;
    }
    // A step of tens of m/s spread over the 20 s window: a few m/s² at most.
    expect(worst).toBeLessThan(5);
  });
});
