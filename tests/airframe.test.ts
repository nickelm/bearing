/**
 * The pieces every airframe shares (track H, decision 154): the rigid body
 * (gravity, Euler's equations, the integrator, attitude) and ground contact
 * (strut, tire, hard points, support height), and the Kestrel through the
 * Airframe interface. The Kestrel's own flight through them is pinned bit for
 * bit by tests/flightLockstep.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Quatd } from '../src/core/quat';
import { DEG, KNOT } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import type { Airframe, AirframeTelemetry } from '../src/sim/flight/airframe';
import { followAirframe } from '../src/render/sim/camera/chaseCamera';
import type { ChaseTarget } from '../src/render/sim/camera/chaseCamera';
import { landingAid } from '../src/freeflight/hudFrame';
import { G0 } from '../src/sim/flight/atmosphere';
import {
  hardPointHit,
  ON_WATER,
  release,
  supportHeight,
  wheelForce,
} from '../src/sim/flight/contact';
import type { ContactState, GroundQuery, TireSpec, WheelContact } from '../src/sim/flight/contact';
import { standardAtmosphere } from '../src/sim/flight/atmosphere';
import { neutralControls } from '../src/sim/flight/controlLaws';
import type { FlightControls } from '../src/sim/flight/controlLaws';
import { along, toward } from '../src/sim/flight/director';
import type { Director, DirectorTarget } from '../src/sim/flight/director';
import { FlightDirector } from '../src/sim/flight/flightDirector';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { FlightMonitor } from '../src/sim/flight/outcomes';
import {
  airVelocityBody,
  attitudeQuat,
  attitudeTelemetry,
  eulerRates,
  FLIGHT_STEP,
  gravityAt,
  integrate,
  SUBSTEPS,
} from '../src/sim/flight/rigidBody';
import type { AttitudeTelemetry, Inertia, RigidBodyState } from '../src/sim/flight/rigidBody';
import { headingVector, runwayEnds, runwayFrame, runwayPoint } from '../src/sim/flight/runway';
import { spawnInAir, spawnOnRunway } from '../src/sim/flight/spawn';
import { flatGround, kestrel, RADIUS, testRunway } from './helpers/flight';

function body(pos = new Vec3d(0, 0, RADIUS + 1000)): RigidBodyState {
  return {
    radius: RADIUS,
    pos,
    vel: new Vec3d(),
    q: new Quatd(),
    omega: new Vec3d(),
    wind: new Vec3d(),
    time: 0,
  };
}

function attitude(): AttitudeTelemetry {
  return { heading: 0, pitch: 0, bank: 0, gamma: 0, verticalSpeed: 0, groundSpeed: 0, altitude: 0 };
}

/** Ground at sea level everywhere, water where `water` says so. */
function plain(water = (_d: Readonly<Vec3d>) => false): GroundQuery {
  return { height: () => 0, surface: (d) => (water(d) ? 'water' : 'field') };
}

const TIRE: TireSpec = {
  rolling: 0.02,
  braking: 0.5,
  lateral: 0.8,
  cornering: 6,
  gripStiffness: 2e5,
  gripDamping: 2e3,
};
const STRUT = { stiffness: 2e5, damping: 1e4, travel: 0.25 };

describe('rigid body', () => {
  it('has gravity g₀ at the surface, falling as 1/r²', () => {
    expect(gravityAt(RADIUS, RADIUS)).toBe(G0);
    expect(gravityAt(RADIUS, 2 * RADIUS)).toBeCloseTo(G0 / 4, 12);
  });

  it('runs at 120 Hz in four substeps', () => {
    expect(FLIGHT_STEP).toBe(1 / 120);
    expect(SUBSTEPS).toBe(4);
  });

  it('takes airspeed relative to the wind, in body axes', () => {
    const b = body();
    b.vel.set(0, 0, 50);
    b.wind.set(0, 0, 20);
    const out = airVelocityBody(b, new Vec3d(), new Vec3d());
    expect(out.length()).toBeCloseTo(30, 12);
  });

  it('keeps a torque-free spin about a principal axis, and precesses an asymmetric body as Euler says', () => {
    const I: Inertia = [1, 2, 3];
    // About a principal axis: no angular acceleration.
    expect(eulerRates(I, new Vec3d(0, 0, 1), 0, 0, 0, new Vec3d()).length()).toBe(0);
    // ω = (1, 1, 0): ṙ = −(Iyy − Ixx) p q / Izz = −1/3.
    const r = eulerRates(I, new Vec3d(1, 1, 0), 0, 0, 0, new Vec3d());
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.z).toBeCloseTo(-1 / 3, 15);
    // A moment alone: ṗ = Mx / Ixx.
    expect(eulerRates(I, new Vec3d(), 2, 0, 0, new Vec3d()).x).toBe(2);
  });

  it('conserves angular momentum and energy of a free tumbling body to within the integrator', () => {
    const I: Inertia = [10, 20, 30];
    const b = body();
    b.omega.set(0.3, 0.05, 0.4);
    const h0 = Math.hypot(10 * 0.3, 20 * 0.05, 30 * 0.4);
    const e0 = 10 * 0.09 + 20 * 0.0025 + 30 * 0.16;
    const rates = new Vec3d();
    const dt = FLIGHT_STEP / SUBSTEPS;
    for (let i = 0; i < 480 * 20; i++) {
      eulerRates(I, b.omega, 0, 0, 0, rates);
      integrate(b, new Vec3d(), 1, rates, dt);
    }
    const w = b.omega;
    expect(Math.hypot(10 * w.x, 20 * w.y, 30 * w.z) / h0).toBeCloseTo(1, 3);
    expect((10 * w.x * w.x + 20 * w.y * w.y + 30 * w.z * w.z) / e0).toBeCloseTo(1, 2);
    expect(b.time).toBeCloseTo(20, 9);
  });

  it('integrates a constant force semi-implicitly: velocity first, then position', () => {
    const b = body();
    const p0 = b.pos.clone();
    integrate(b, new Vec3d(10, 0, 0), 2, new Vec3d(), 0.5);
    expect(b.vel.x).toBe(2.5);
    expect(b.pos.x - p0.x).toBe(1.25);
  });

  it('builds attitude from heading, pitch and bank, and reads it back', () => {
    const b = body(new Vec3d(RADIUS * 0.6, RADIUS * 0.48, RADIUS * 0.64));
    for (const [h, p, k] of [
      [30, 10, -20],
      [200, -5, 45],
      [355, 60, 170],
    ] as const) {
      attitudeQuat(b.pos, h * DEG, p * DEG, k * DEG, b.q);
      const tel = attitude();
      attitudeTelemetry(b, tel, new Vec3d());
      expect(tel.heading / DEG).toBeCloseTo(h, 9);
      expect(tel.pitch / DEG).toBeCloseTo(p, 9);
      expect(tel.bank / DEG).toBeCloseTo(k, 9);
      expect(tel.altitude).toBeCloseTo(0, 6);
    }
  });
});

describe('ground contact', () => {
  /** A body resting with its wheel at `depth` below the ground. */
  function resting(depth: number): { b: RigidBodyState; w: WheelContact; up: Vec3d } {
    const b = body(new Vec3d(0, 0, RADIUS + 2 - depth));
    attitudeQuat(b.pos, 0, 0, 0, b.q);
    const w: WheelContact = {
      body: new Vec3d(0, 0, 2),
      compression: 0,
      load: 0,
      anchor: null,
      surface: null,
      steer: 0,
    };
    return { b, w, up: b.pos.clone().normalize() };
  }

  it('carries load with the strut spring and stops it hard past its travel', () => {
    const { b, w, up } = resting(0.1);
    const fw = new Vec3d();
    const n = wheelForce(b, w, STRUT, TIRE, 0, plain(), up, fw, new Vec3d());
    expect(n).toBeCloseTo(STRUT.stiffness * 0.1, 3);
    expect(w.compression).toBeCloseTo(0.1, 9);
    expect(fw.dot(up)).toBeCloseTo(n, 3);
    const deep = resting(0.3);
    const m = wheelForce(
      deep.b,
      deep.w,
      STRUT,
      TIRE,
      0,
      plain(),
      deep.up,
      new Vec3d(),
      new Vec3d(),
    );
    expect(m).toBeCloseTo(STRUT.stiffness * 0.3 + 20 * STRUT.stiffness * 0.05, 3);
    expect(deep.w.compression).toBe(STRUT.travel);
  });

  it('writes nothing on water, and releases the point in the air', () => {
    const { b, w, up } = resting(0.1);
    // A loaded wheel first, so "nothing written" is not the same as "cleared".
    wheelForce(b, w, STRUT, TIRE, 0, plain(), up, new Vec3d(), new Vec3d());
    expect(w.load).toBeGreaterThan(0);
    const before = {
      load: w.load,
      compression: w.compression,
      anchor: w.anchor!.clone(),
      surface: w.surface,
    };
    const fw = new Vec3d();
    const mb = new Vec3d();
    expect(
      wheelForce(
        b,
        w,
        STRUT,
        TIRE,
        0,
        plain(() => true),
        up,
        fw,
        mb,
      ),
    ).toBe(ON_WATER);
    expect(w.load).toBe(before.load);
    expect(w.compression).toBe(before.compression);
    expect(w.anchor!.equals(before.anchor)).toBe(true);
    expect(w.surface).toBe(before.surface);
    expect(fw.length()).toBe(0);
    expect(mb.length()).toBe(0);
    // In the air: release clears load, anchor and surface and keeps the compression.
    release(w);
    expect(w.anchor).toBeNull();
    expect(w.load).toBe(0);
    expect(w.surface).toBeNull();
    expect(w.compression).toBe(before.compression);
    const high = resting(-0.5);
    expect(
      wheelForce(high.b, high.w, STRUT, TIRE, 0, plain(), high.up, new Vec3d(), new Vec3d()),
    ).toBe(0);
    expect(high.w.compression).toBe(0);
  });

  it('holds a braked wheel with friction up to its cap, then lets it slide', () => {
    const { b, w, up } = resting(0.1);
    const east = new Vec3d(0, 1, 0).cross(up).normalize();
    // Displaced 1 mm along: the braked grip spring pulls back, under its cap.
    wheelForce(b, w, STRUT, TIRE, 1, plain(), up, new Vec3d(), new Vec3d());
    b.pos.addScaled(east.clone().cross(up).scale(-1), 0.001);
    const fw = new Vec3d();
    const n = wheelForce(b, w, STRUT, TIRE, 1, plain(), up, fw, new Vec3d());
    const tangential = fw.clone().addScaled(up, -fw.dot(up)).length();
    expect(tangential).toBeGreaterThan(0);
    expect(tangential).toBeLessThanOrEqual((TIRE.rolling + TIRE.braking) * n * 1.000001);
    // Pushed a meter: the force is the friction cap, not the spring.
    b.pos.addScaled(east.clone().cross(up).scale(-1), 1);
    const fw2 = new Vec3d();
    const n2 = wheelForce(b, w, STRUT, TIRE, 1, plain(), up, fw2, new Vec3d());
    const t2 = fw2.clone().addScaled(up, -fw2.dot(up)).length();
    expect(t2).toBeCloseTo((TIRE.rolling + TIRE.braking) * n2, 3);
  });

  it('finds the first hard point under the ground, and the support height', () => {
    const b = body(new Vec3d(0, 0, RADIUS + 1));
    attitudeQuat(b.pos, 0, 0, 0, b.q);
    const points = [new Vec3d(5, 0, 0), new Vec3d(0, 0, 0.5), new Vec3d(0, 0, 1.5)];
    expect(hardPointHit(b, points, plain())).toEqual({ index: 2, surface: 'field' });
    expect(hardPointHit(b, points.slice(0, 2), plain())).toBeNull();
    const supports = points.map((p) => ({
      body: p,
      compression: 0,
      load: 0,
      anchor: null,
      surface: null,
    }));
    expect(supportHeight(b, supports)).toBeCloseTo(1.5, 9);
  });
});

describe('the Kestrel as an Airframe', () => {
  it('flies, stands and is watched through the interface alone', () => {
    const runway = testRunway();
    const ground = flatGround(runway);
    const m = kestrel();
    spawnOnRunway(m, runway, runwayEnds(runway)[0]);
    const a: Airframe = m;
    expect(a.kind).toBe('fixed-wing');
    expect(a.supports).toBe(m.wheels);
    const monitor = new FlightMonitor([runway], RADIUS);
    const ctl = neutralControls();
    ctl.parkingBrake = true;
    for (let i = 0; i < 240; i++) {
      a.step(ctl, ground);
      monitor.update(a, FLIGHT_STEP);
    }
    expect(a.onGround).toBe(true);
    expect(a.crashed).toBeNull();
    expect(a.telemetry.wow).toBe(1);
    expect(a.telemetry.radarAltitude).toBeLessThan(0.3);
    expect(a.gearHeightNow()).toBeGreaterThan(1);
    a.crash('test');
    expect(a.crashed).toBe('test');
  });
});

/**
 * A stand-in for the rotorcraft model: a body on two skids that sinks straight
 * down at a set rate and stops on the ground. It is no FlightModel, so what
 * reads it reads only the Airframe interface.
 */
class SkidStub implements Airframe<{ sink: number }> {
  readonly kind = 'rotorcraft' as const;
  readonly radius = RADIUS;
  readonly pos = new Vec3d();
  readonly vel = new Vec3d();
  readonly q = new Quatd();
  readonly omega = new Vec3d();
  readonly wind = new Vec3d();
  time = 0;
  readonly mass = 2000;
  fuel = 300;
  unlimitedFuel = true;
  readonly gear = 1;
  crashed: string | null = null;
  readonly supports: ContactState[] = [-1.1, 1.1].map((y) => ({
    body: new Vec3d(0, y, 1.2),
    compression: 0,
    load: 0,
    anchor: null,
    surface: null,
  }));
  readonly gearHeight = 1.2;
  readonly telemetry: AirframeTelemetry = {
    heading: 0,
    pitch: 0,
    bank: 0,
    gamma: 0,
    verticalSpeed: 0,
    groundSpeed: 0,
    altitude: 0,
    alpha: 0,
    beta: 0,
    tas: 0,
    cas: 0,
    mach: 0,
    qbar: 0,
    load: 1,
    normalLoad: 1,
    radarAltitude: 0,
    aero: new Vec3d(),
    gearForce: new Vec3d(),
    gravity: new Vec3d(),
    wow: 0,
    fuelFlow: 0,
    air: standardAtmosphere(0),
  };

  get onGround(): boolean {
    return this.supports.some((s) => s.load > 0);
  }

  bodyAxis(axis: 0 | 1 | 2, out = new Vec3d()): Vec3d {
    return this.q.rotate(
      new Vec3d(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0),
      out,
    );
  }

  gearHeightNow(): number {
    return supportHeight(this, this.supports);
  }

  place(
    pos: Readonly<Vec3d>,
    vel: Readonly<Vec3d>,
    heading: number,
    pitch: number,
    bank = 0,
  ): void {
    this.pos.copy(pos);
    this.vel.copy(vel);
    attitudeQuat(pos, heading, pitch, bank, this.q);
    this.crashed = null;
  }

  crash(reason: string): void {
    this.crashed ??= reason;
  }

  step(ctl: Readonly<{ sink: number }>, ground: GroundQuery): void {
    if (this.crashed) return;
    const up = this.pos.clone().normalize();
    const h = this.pos.length() - this.radius - this.gearHeight - ground.height(up);
    const sink = h > 0 ? ctl.sink : 0;
    this.vel.copy(up).scale(-sink);
    this.pos.addScaled(up, -Math.min(sink * FLIGHT_STEP, Math.max(0, h)));
    this.time += FLIGHT_STEP;
    const touching = h <= 1e-9;
    for (const s of this.supports) {
      s.load = touching ? (this.mass * G0) / 2 : 0;
      s.surface = touching ? ground.surface(up) : null;
    }
    this.updateAttitude(ground);
  }

  updateAttitude(ground?: GroundQuery): void {
    const up = attitudeTelemetry(this, this.telemetry, new Vec3d());
    this.telemetry.wow = this.onGround ? 1 : 0;
    if (ground) {
      this.telemetry.radarAltitude =
        this.telemetry.altitude - this.gearHeightNow() - ground.height(up);
    }
  }
}

describe('an airframe that is not the Kestrel', () => {
  const runway = testRunway();
  const ground = flatGround(runway);
  const end = runwayEnds(runway)[0];

  function hover(height: number): SkidStub {
    const s = new SkidStub();
    const pos = runwayPoint(runway, runwayFrame(runway), 0, 0, height, RADIUS);
    s.place(pos, new Vec3d(), end.heading, 0);
    return s;
  }

  function settle(s: SkidStub, sink: number, monitor: FlightMonitor, seconds: number): string[] {
    const kinds: string[] = [];
    for (let i = 0; i < seconds / FLIGHT_STEP && !s.crashed; i++) {
      s.step({ sink }, ground);
      for (const e of monitor.update(s, FLIGHT_STEP)) kinds.push(e.kind);
    }
    return kinds;
  }

  it('lifts off, touches down and stops under the outcomes monitor', () => {
    const s = hover(20);
    const monitor = new FlightMonitor([runway], RADIUS);
    expect(settle(s, 0, monitor, 2)).toEqual(['liftoff']);
    expect(settle(s, 0.8, monitor, 30)).toEqual(['touchdown']);
    expect(monitor.lastTouchdown?.grade).toBe('smooth');
    expect(monitor.lastTouchdown?.runway).toBe(runway);
    expect(s.crashed).toBeNull();
    expect(s.onGround).toBe(true);
  });

  it('is crashed by the monitor on a landing above 6 m/s', () => {
    const s = hover(30);
    const monitor = new FlightMonitor([runway], RADIUS);
    settle(s, 0, monitor, 2);
    settle(s, 8, monitor, 10);
    expect(s.crashed).toMatch(/sink rate 8.0/);
  });

  it('gets a landing aid and feeds the chase camera', () => {
    const s = hover(300);
    const back = headingVector(s.pos.clone().normalize(), end.heading + Math.PI);
    s.place(s.pos.clone().addScaled(back, 3000), new Vec3d(), end.heading, 0);
    s.updateAttitude(ground);
    expect(landingAid(s, [runway], s.pos)).not.toBeNull();
    const t: ChaseTarget = {
      pos: new Vec3d(),
      forward: new Vec3d(),
      up: new Vec3d(),
      velocity: new Vec3d(),
      onGround: true,
    };
    followAirframe(t, s);
    expect(t.pos.equals(s.pos)).toBe(true);
    expect(t.forward.dot(s.bodyAxis(0))).toBeCloseTo(1, 12);
    expect(t.up.dot(s.pos.clone().normalize())).toBeCloseTo(1, 9);
    expect(t.onGround).toBe(false);
  });
});

describe('the director interface', () => {
  it("leaves the fixed-wing director's controls alone when a target carries rotary-wing fields", () => {
    const runway = testRunway();
    const ground = flatGround(runway);
    const end = runwayEnds(runway)[0];
    const fly = (rotary: boolean) => {
      const m = kestrel();
      spawnInAir(m, runway, end, 3000, 300 * KNOT);
      const d: Director<FlightModel, FlightControls> = new FlightDirector();
      const ctl = neutralControls();
      ctl.throttle = 0.6;
      const out: number[] = [];
      for (let i = 0; i < 600; i++) {
        const t: DirectorTarget = {
          course: end.heading + 0.5,
          gamma: 0.05,
          speed: 280 * KNOT,
          ...(rotary
            ? {
                heading: 1,
                groundVelocity: { north: 3, east: -2, up: 1 },
                hoverPoint: m.pos.clone(),
                height: { reference: 'radar' as const, value: 30 },
              }
            : {}),
        };
        d.fly(m, t, ctl, FLIGHT_STEP);
        m.step(ctl, ground);
        out.push(ctl.pitch, ctl.roll, ctl.yaw, ctl.throttle);
      }
      return out;
    };
    expect(fly(true)).toEqual(fly(false));
  });

  it('points toward a world point and along a world direction', () => {
    const b = body(new Vec3d(0, 0, RADIUS));
    // At latitude 0, longitude 0: +X is east, +Y north, +Z up.
    const north = toward(b, b.pos.clone().add(new Vec3d(0, 1000, 0)));
    expect(north.course).toBeCloseTo(0, 9);
    expect(north.gamma).toBeCloseTo(0, 9);
    const climbEast = along(b, new Vec3d(1, 0, 1));
    expect(climbEast.course).toBeCloseTo(Math.PI / 2, 9);
    expect(climbEast.gamma).toBeCloseTo(Math.PI / 4, 9);
  });
});
