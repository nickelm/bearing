import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import type { Dir } from '../src/core/greatCircle';
import { DEG } from '../src/core/units';
import {
  drawnAltitude,
  easeLift,
  flightPoses,
  FOLLOW_CLEARANCE,
  followedLook,
  followHudFrame,
  gearDown,
  liftedPose,
} from '../src/follow/followFlight';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { SCHEMES } from '../src/render/common/models/palettes';
import { AIRCRAFT_TYPES } from '../src/sim/air/aircraft';
import { analyticPose } from '../src/sim/air/analyticPose';
import { AIRCRAFT_BUNDLES, bundleOfType } from '../src/sim/air/bundles';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import type { Mission } from '../src/sim/air/mission';
import { planMissionRoute } from '../src/sim/air/missionRoute';

const R = 1_000_000;
const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};
const look = (typeId: string) => followedLook(bundleOfType(typeId), AIRCRAFT_BUNDLES);

describe('a followed type’s look', () => {
  it('draws a type with its own geometry and rig', () => {
    const f21 = look('f21');
    expect(f21).toMatchObject({ drawn: 'alliance-fighter', standIn: false });
    expect(f21.rig).toBe(bundleOfType('f21').rig);
    expect(look('c150')).toMatchObject({ drawn: 'c150', standIn: false });
    expect(look('vo31k')).toMatchObject({ drawn: 'pact-fighter', standIn: false });
  });

  it('stands in for a type without geometry by class and side, in its own scheme', () => {
    expect(look('f25')).toMatchObject({ drawn: 'alliance-fighter', standIn: true });
    expect(look('f25').scheme).toBe(bundleOfType('f25').scheme ?? 'alliance-air');
    expect(look('vo33')).toMatchObject({ drawn: 'pact-fighter', standIn: true });
    expect(look('vo37')).toMatchObject({ drawn: 'pact-strike', standIn: true });
    expect(look('ra44')).toMatchObject({ drawn: 'c150', standIn: true });
    expect(look('ra44').scheme).toBe(bundleOfType('ra44').scheme);
    // A helicopter stands in for a helicopter and keeps the rotor-scaled rig.
    expect(look('ve18')).toMatchObject({ drawn: 'alliance-utility-helo', standIn: true });
    expect(look('ve18').rig?.kind).toBe('helicopter');
  });

  it('gives every type in the air war a drawable model, a known scheme and a rig', () => {
    for (const t of AIRCRAFT_TYPES) {
      const l = look(t.id);
      expect(MODEL_SPECS[l.drawn], t.id).toBeDefined();
      if (l.scheme) expect(SCHEMES[l.scheme], `${t.id}: ${l.scheme}`).toBeDefined();
      expect(l.rig, t.id).not.toBeNull();
    }
  });
});

describe('the followed flight', () => {
  const type = AIRCRAFT_TYPES.find((t) => t.role === 'cas' && t.side === 'pact')!;
  const route = planMissionRoute({
    type,
    loadout: type.loadouts[0]!,
    profile: MISSION_PROFILES.cas,
    radius: R,
    rangeFactor: 1,
    basePoint: () => dir(40, 10),
    carrierBased: false,
    target: dir(42, 12),
    launch: 0,
  })!;
  const mission = { aircraft: 3, route } as unknown as Mission;
  const mid = (route.segments[2]!.t0 + route.segments[2]!.t1) / 2;

  it('has one pose per aircraft left in the flight', () => {
    expect(flightPoses(mission, mid, R)).toHaveLength(3);
    expect(flightPoses({ ...mission, aircraft: 1 }, mid, R)).toHaveLength(1);
  });

  it('stays above the drawn ground in the air and stands on it on the ground', () => {
    const air = analyticPose(route, mid, R);
    expect(air.airborne).toBe(true);
    // Over low ground the route's altitude holds; over a ridge the aircraft lifts.
    expect(drawnAltitude(air, 0, 2)).toBe(air.altitude);
    const ridge = air.altitude + 100;
    expect(drawnAltitude(air, ridge, 2)).toBe(ridge + FOLLOW_CLEARANCE);
    expect(drawnAltitude(air, null, 2)).toBe(air.altitude);
    const parked = analyticPose(route, -60, R);
    expect(parked.airborne).toBe(false);
    expect(drawnAltitude(parked, 350, 2.4)).toBeCloseTo(352.4, 9);
    // Lifting moves the position out along the vertical only.
    const lifted = liftedPose(air, air.altitude + 500);
    expect(Math.hypot(...lifted.pos) - Math.hypot(...air.pos)).toBeCloseTo(500, 6);
    expect(lifted.forward).toEqual(air.forward);
  });

  it('rises over a ridge at once and sinks into a valley over seconds', () => {
    expect(easeLift(0, 200, 0.016)).toBe(200);
    const one = easeLift(200, 0, 1);
    expect(one).toBeGreaterThan(100);
    expect(one).toBeLessThan(200);
    let x = 200;
    for (let i = 0; i < 60 * 30; i++) x = easeLift(x, 0, 1 / 60);
    expect(x).toBeLessThan(1);
  });

  it('lowers the gear on the ground and low in departure and arrival only', () => {
    const parked = analyticPose(route, -60, R);
    expect(gearDown(parked, 0)).toBe(true);
    const cruise = analyticPose(route, mid, R);
    expect(gearDown(cruise, 50)).toBe(cruise.phase === 'departure' || cruise.phase === 'approach');
    expect(gearDown({ ...cruise, phase: 'approach' }, 100)).toBe(true);
    expect(gearDown({ ...cruise, phase: 'approach' }, 2000)).toBe(false);
  });

  it('builds a read-only HUD frame from the pose', () => {
    const p = analyticPose(route, mid, R);
    const f = followHudFrame({
      pose: p,
      fuel: 1234,
      radarAltitude: 300,
      gear: 0,
      gearDown: false,
      afterburner: 0,
    });
    expect(f.mode).toBe('follow');
    expect(f.onGround).toBe(false);
    expect(f.heading).toBe(p.heading);
    expect(f.fuel).toBe(1234);
    expect(f.load).toBeGreaterThanOrEqual(1);
    // Calibrated airspeed falls below true airspeed with altitude.
    if (p.altitude > 1000) expect(f.cas).toBeLessThan(p.speed);
    expect(Math.hypot(...f.velocity)).toBeCloseTo(1, 9);
    expect(f.warnings).toEqual([]);
  });
});

describe('the chase camera’s heading', () => {
  it('reads the view’s direction clockwise from north', async () => {
    const { ChaseCamera } = await import('../src/render/sim/camera/chaseCamera');
    const c = new ChaseCamera(R);
    c.eye.set(0, 0, R + 1000);
    c.forward.set(0, 1, 0);
    expect(c.heading).toBeCloseTo(0, 9);
    c.forward.set(1, 0, 0);
    expect(c.heading).toBeCloseTo(Math.PI / 2, 9);
    c.forward.set(-1, 0, 0);
    expect(c.heading).toBeCloseTo(-Math.PI / 2, 9);
  });
});

describe('a carrier flight', () => {
  it('stands on the deck where the carrier is now, and flies off it', async () => {
    const { carrierFields, drawnGround, DECK_HEIGHT, flightPoses } =
      await import('../src/follow/followFlight');
    const { AIRCRAFT_TYPES } = await import('../src/sim/air/aircraft');
    const { MISSION_PROFILES } = await import('../src/sim/air/mission');
    const { planMissionRoute } = await import('../src/sim/air/missionRoute');
    const type = AIRCRAFT_TYPES.find((t) => t.carrier)!;
    const launchAt = dir(30, 20);
    const route = planMissionRoute({
      type,
      loadout: type.loadouts[0]!,
      profile: MISSION_PROFILES.cap,
      radius: R,
      rangeFactor: 1,
      basePoint: () => launchAt,
      carrierBased: true,
      target: dir(33, 22),
      launch: 0,
    })!;
    const m = { aircraft: 2, route, base: { kind: 'carrier', id: 0 } } as unknown as Mission;
    // The carrier has sailed 4 km on since the launch was planned.
    const now = dir(30.036, 20);
    const fields = carrierFields(m, { point: now, heading: 0 });
    const parked = flightPoses(m, -30, R, fields)[0]!;
    expect(parked.airborne).toBe(false);
    const d = Math.hypot(...parked.pos);
    const at: Dir = [parked.pos[0] / d, parked.pos[1] / d, parked.pos[2] / d];
    expect(
      Math.acos(Math.min(1, at[0] * now[0] + at[1] * now[1] + at[2] * now[2])) * R,
    ).toBeLessThan(1);
    expect(drawnGround(m, parked, 0)).toBe(DECK_HEIGHT);
    expect(carrierFields({ ...m, base: { kind: 'airbase', id: 0 } } as Mission, null)).toEqual([]);
  });
});

describe('the chase camera under time acceleration', () => {
  it('stretches by the flight’s own deceleration, not the frame’s (decision 259)', async () => {
    const { ChaseCamera } = await import('../src/render/sim/camera/chaseCamera');
    const { Vec3d } = await import('../src/core/vec3d');
    // The same game-time history, a wingman easing off 15 m/s over 20 game seconds after a
    // turn, seen at 1× and at 16×: the camera's distance must not depend on the rate.
    const run = (rate: number) => {
      const c = new ChaseCamera(R);
      c.timeRate = rate;
      const t = c.target;
      t.pos.set(0, 0, R + 5000);
      t.forward.set(0, 1, 0);
      t.up.set(0, 0, 1);
      t.onGround = false;
      let least = Infinity;
      const dt = 1 / 60;
      for (let real = 0; real < 40 / rate + 3; real += dt) {
        const game = real * rate;
        const v = game < 10 ? 225 : game < 30 ? 225 - (15 * (game - 10)) / 20 : 210;
        t.velocity.copy(new Vec3d(0, v, 0));
        t.pos.addScaled(t.velocity, dt * rate);
        c.update(dt);
        least = Math.min(least, c.eye.distanceTo(t.pos));
      }
      return least;
    };
    expect(Math.abs(run(16) - run(1))).toBeLessThan(0.3);
  });
});
