/**
 * The rotary director, the AI helicopter pilot and the landing zone (roadmap
 * R2.9): the director flies through the same model as recorded inputs do; it
 * holds a hover point; the AI pilot follows a route, approaches and lands in a
 * crosswind, waits, takes off and follows the route again; the landing zone
 * keeps off trees, slopes and water.
 */
import { describe, expect, it } from 'vitest';
import { destination } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { DEG, KNOT } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import type { ReferencePoint } from '../src/sim/flight/aiPilot';
import type { DirectorTarget } from '../src/sim/flight/director';
import { FLIGHT_STEP } from '../src/sim/flight/rigidBody';
import { eastNorth, runwayEnds, runwayFrame, runwayPoint } from '../src/sim/flight/runway';
import { HeloDirector } from '../src/sim/flight/rotor/heloDirector';
import { HeloPilot } from '../src/sim/flight/rotor/heloPilot';
import { chooseLandingZone } from '../src/sim/flight/rotor/landingZone';
import type { LandingSampler } from '../src/sim/flight/rotor/landingZone';
import { neutralRotorControls } from '../src/sim/flight/rotor/rotorcraftModel';
import type { RotorControls, RotorcraftModel } from '../src/sim/flight/rotor/rotorcraftModel';
import { OPEN_ROUGHNESS, surfaceWindFactor } from '../src/sim/flight/wind';
import { flatGround, RADIUS, testRunway } from './helpers/flight';
import { scout, utility } from './helpers/rotor';

const runway = testRunway();
const ground = flatGround(runway);
const end = runwayEnds(runway)[0];
const frame = runwayFrame(runway);

function spawn(m: RotorcraftModel, height: number | null, vel = new Vec3d()): void {
  const h = height ?? m.gearHeight - 0.02;
  m.place(runwayPoint(runway, frame, -1500, 300, h, RADIUS), vel, end.heading, 0);
  m.updateAttitude(ground);
}

/** Every number of the model's state, for exact comparison. */
function stateOf(m: RotorcraftModel): number[] {
  const t = m.telemetry;
  return [
    m.pos.x,
    m.pos.y,
    m.pos.z,
    m.vel.x,
    m.vel.y,
    m.vel.z,
    m.q.x,
    m.q.y,
    m.q.z,
    m.q.w,
    m.omega.x,
    m.omega.y,
    m.omega.z,
    m.inflow,
    m.tailInflow,
    m.enginePower,
    m.flapForward,
    m.flapRight,
    m.fuel,
    t.rotorSpeed,
    t.torque,
  ];
}

describe('the rotary director', () => {
  it('flies the same as its recorded controls replayed into the model', () => {
    for (const make of [scout, utility]) {
      const a = make();
      spawn(a, null);
      const dir = new HeloDirector();
      const ctl = neutralRotorControls();
      const recorded: RotorControls[] = [];
      const target: DirectorTarget = { course: 0, gamma: 0, speed: null };
      const start = a.pos.clone();
      for (let i = 0; i < 90 / FLIGHT_STEP; i++) {
        const t = i * FLIGHT_STEP;
        target.groundVelocity = undefined;
        target.hoverPoint = undefined;
        target.height = { reference: 'radar', value: t < 20 ? 15 : 40 };
        target.heading = t < 30 ? end.heading + 40 * DEG : undefined;
        if (t < 20) target.hoverPoint = start;
        else if (t < 60) {
          target.groundVelocity = { north: 30, east: 20, up: 0 };
        } else target.hoverPoint = start;
        dir.fly(a, target, ctl, FLIGHT_STEP);
        recorded.push({ ...ctl });
        a.step(ctl, ground);
      }
      expect(a.crashed).toBeNull();
      const b = make();
      spawn(b, null);
      for (const c of recorded) b.step(c, ground);
      expect(stateOf(b)).toEqual(stateOf(a));
    }
  });

  it('holds a hover point within a meter', () => {
    for (const make of [scout, utility]) {
      const m = make();
      spawn(m, 10);
      const dir = new HeloDirector();
      const ctl = neutralRotorControls();
      const point = runwayPoint(runway, frame, -1460, 320, 10, RADIUS);
      const target: DirectorTarget = {
        course: 0,
        gamma: 0,
        speed: null,
        hoverPoint: point,
        height: { reference: 'radar', value: 10 },
      };
      let worst = 0;
      for (let i = 0; i < 100 / FLIGHT_STEP; i++) {
        dir.fly(m, target, ctl, FLIGHT_STEP);
        m.step(ctl, ground);
        if (i * FLIGHT_STEP > 40) {
          const d = point.clone().sub(m.pos);
          d.addScaled(m.pos.clone().normalize(), -d.dot(m.pos.clone().normalize()));
          worst = Math.max(worst, d.length());
        }
      }
      expect(m.crashed).toBeNull();
      expect(worst).toBeLessThan(1);
      expect(Math.abs(m.telemetry.radarAltitude - 10)).toBeLessThan(1);
    }
  });
});

describe('the AI helicopter pilot', () => {
  it('follows a route, lands at a point in a 10 m/s crosswind, waits and goes on', () => {
    for (const make of [scout, utility]) {
      const m = make();
      // 120 kt, or 70% of the never-exceed speed for the scout, whose 120 kt is its top
      // cruise: it could never catch up with the route after the stop.
      const speed = Math.min(120 * KNOT, 0.7 * m.spec.limits.vne);
      // A straight route at 150 m: 3 km to the landing point, a 90 s stop there, on again.
      const t1 = 3000 / speed;
      const t2 = t1 + 90;
      const along = (t: number) => -1500 + speed * (t < t1 ? t : t < t2 ? t1 : t - (t2 - t1));
      const reference = (t: number): ReferencePoint => {
        const p = runwayPoint(runway, frame, along(t), 300, 150, RADIUS);
        const q = runwayPoint(runway, frame, along(t + 0.1), 300, 150, RADIUS);
        return { pos: p, vel: q.sub(p).scale(10) };
      };
      const v0 = reference(0).vel.clone();
      spawn(m, 150, v0);
      const pilot = new HeloPilot(reference);
      const lz = runwayPoint(runway, frame, 1500, 300, 0, RADIUS);
      // The wind blows across the route from the right: 10 m/s at the hover's 10 m.
      const up = lz.clone().normalize();
      const fwd = reference(0).vel.clone().normalize();
      const across = fwd.clone().cross(up).normalize();
      const weather = 10 / surfaceWindFactor(10, OPEN_ROUGHNESS);
      const blow = across.clone().scale(-1);
      const { east, north } = eastNorth(up);
      const into = Math.atan2(-blow.dot(east), -blow.dot(north));
      pilot.land({ point: lz, heading: into, waitUntil: t2 });
      const ctl = neutralRotorControls();
      let tookOff = -1;
      const states = new Set<string>();
      for (let i = 0; i < 360 / FLIGHT_STEP && !m.crashed; i++) {
        const t = i * FLIGHT_STEP;
        const k = surfaceWindFactor(Math.max(0, m.telemetry.radarAltitude), OPEN_ROUGHNESS);
        m.wind.copy(blow).scale(weather * k);
        pilot.step(m, t, ctl, FLIGHT_STEP);
        m.step(ctl, ground);
        states.add(pilot.state);
        if (tookOff < 0 && pilot.touchdown && pilot.state === 'track') tookOff = t;
      }
      expect(m.crashed).toBeNull();
      expect([...states]).toEqual(
        expect.arrayContaining(['track', 'approach', 'hover', 'land', 'wait', 'takeoff']),
      );
      const td = pilot.touchdown!;
      expect(td, 'touched down').toBeTruthy();
      expect(td.sink).toBeLessThan(1.5);
      expect(td.miss).toBeLessThan(5);
      expect(tookOff).toBeGreaterThanOrEqual(t2);
      expect(pilot.state).toBe('track');
      // Back on its point of the route.
      const ref = reference(360);
      expect(ref.pos.distanceTo(m.pos)).toBeLessThan(50);
    }
  }, 120_000);

  it('climbs over a butte on its route instead of flying into it (R2.9 review)', () => {
    const m = utility();
    // A route at 40 m over flat ground, straight at a butte 180 m high and 300 m across.
    const speed = 120 * KNOT;
    const reference = (t: number): ReferencePoint => {
      const p = runwayPoint(runway, frame, -1500 + speed * t, 300, 40, RADIUS);
      const q = runwayPoint(runway, frame, -1500 + speed * (t + 0.1), 300, 40, RADIUS);
      return { pos: p, vel: q.sub(p).scale(10) };
    };
    const butte = runwayPoint(runway, frame, 1500, 300, 0, RADIUS).normalize();
    const withButte = {
      height: (d: Readonly<Vec3d>) =>
        ground.height(d) + (d.distanceTo(butte) * RADIUS < 150 ? 180 : 0),
      surface: ground.surface,
    };
    spawn(m, 40, reference(0).vel.clone());
    const pilot = new HeloPilot(reference);
    pilot.ground = withButte;
    const ctl = neutralRotorControls();
    let least = Infinity;
    for (let i = 0; i < 90 / FLIGHT_STEP && !m.crashed; i++) {
      pilot.step(m, i * FLIGHT_STEP, ctl, FLIGHT_STEP);
      m.step(ctl, withButte);
      const d = m.pos.clone().normalize();
      least = Math.min(least, m.pos.length() - RADIUS - withButte.height(d));
    }
    expect(m.crashed).toBeNull();
    // It cleared the butte's top by a margin, and was past it by the end.
    expect(least).toBeGreaterThan(5);
  }, 60_000);
});

describe('the landing zone', () => {
  const R = RADIUS;
  const center: Dir = [0, 0, 1];
  /** Flat at 100 m, a slope rising north of 200 m, forest within 120 m, a lake east beyond 400 m. */
  function sampler(forestRadius: number, lake = true): LandingSampler {
    const local = (d: Readonly<Dir>) => ({ x: d[0] * R, y: d[1] * R });
    return {
      height: (d) => {
        const { y } = local(d);
        return 100 + (y > 200 ? (y - 200) * 0.3 : 0);
      },
      forest: (d) => {
        const { x, y } = local(d);
        return Math.hypot(x, y) < forestRadius ? 0.8 : 0;
      },
      water: (d) => lake && local(d).x > 400,
    };
  }
  const opts = { radius: R, rotorRadius: 8, slopeLimit: 15 * DEG };

  it('lands on the point itself when it is clear', () => {
    const z = chooseLandingZone(center, sampler(0), opts)!;
    expect(z.distance).toBe(0);
    expect(z.slope).toBe(0);
  });

  it('takes the nearest clear, flat spot outside a forest', () => {
    const z = chooseLandingZone(center, sampler(120), opts)!;
    expect(z).not.toBeNull();
    expect(z.forest).toBeLessThanOrEqual(0.15);
    expect(z.slope).toBeLessThan(8 * DEG);
    // The forest's edge plus the rotor's footprint, on the first ring past it.
    expect(z.distance).toBeGreaterThanOrEqual(120 + 12);
    expect(z.distance).toBeLessThanOrEqual(175);
    // Not on the slope north of 200 m.
    expect(z.point[1] * R).toBeLessThan(200);
  });

  it('heads into the wind, and refuses water and slopes everywhere', () => {
    const z = chooseLandingZone(center, sampler(0), { ...opts, wind: { east: 10, north: 0 } })!;
    // A wind toward the east blows from the west: land heading west.
    expect(z.heading).toBeCloseTo(270 * DEG, 6);
    const wet: LandingSampler = { height: () => 0, forest: () => 0, water: () => true };
    expect(chooseLandingZone(center, wet, opts)).toBeNull();
    const steep: LandingSampler = {
      height: (d) => d[0] * R * 0.5,
      forest: () => 0,
      water: () => false,
    };
    expect(chooseLandingZone(center, steep, opts)).toBeNull();
    // A point in the lake lands on its shore.
    const shore = chooseLandingZone(destination(center, Math.PI / 2, 450, R), sampler(0), opts)!;
    expect(shore.point[0] * R).toBeLessThan(400 - 12);
  });
});
