/**
 * Every flyable jet but the Kestrel (whose suite is tests/flightModel.test.ts) against its
 * plausibility targets (roadmap R2.7): rest on the runway, takeoff, the landing
 * configuration's stall, top speed, the control laws' limits, hands-off level flight, the
 * test pilot's circuit, and its air-war entry's cruise at military power.
 */
import { describe, expect, it } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { bundleOfType, AIRCRAFT_BUNDLES } from '../src/sim/air/bundles';
import { MIL_DETENT, neutralControls } from '../src/sim/flight/controlLaws';
import type { FlightControls } from '../src/sim/flight/controlLaws';
import { FlightDirector } from '../src/sim/flight/flightDirector';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { FlightMonitor } from '../src/sim/flight/outcomes';
import type { FlightEvent } from '../src/sim/flight/outcomes';
import { runwayEnds, runwayFrame, toRunway } from '../src/sim/flight/runway';
import { spawnInAir, spawnOnRunway } from '../src/sim/flight/spawn';
import { TestPilot } from '../src/sim/flight/testPilot';
import { flatGround, flightModelOf, FLYABLE_JETS, RADIUS, testRunway } from './helpers/flight';

interface Targets {
  /** Rotation speed (KCAS) at full aft stick and full power, and the ground roll (m). */
  rotateKt: [number, number];
  rollM: [number, number];
  /** Stall in the landing configuration with 1,000 kg of fuel (KCAS). */
  stallKt: [number, number];
  /** Top speed at 300 m at full power (Mach). */
  seaLevelMach: [number, number];
}

/** Public figures, loosely: what each type's flight data must reach. */
const TARGETS: Record<string, Targets> = {
  // MiG-29: takeoff run 250–600 m in afterburner, about 1,500 km/h at sea level.
  'pact-fighter': {
    rotateKt: [120, 150],
    rollM: [350, 800],
    stallKt: [95, 125],
    seaLevelMach: [1.12, 1.25],
  },
  // Su-25: takeoff run about 600 m, 975 km/h at sea level clean, landing at 225–260 km/h.
  'pact-strike': {
    rotateKt: [125, 155],
    rollM: [450, 900],
    stallKt: [95, 125],
    seaLevelMach: [0.76, 0.84],
  },
};

const runway = testRunway();
const ground = flatGround(runway);
const end = runwayEnds(runway)[0];

function run(m: FlightModel, ctl: FlightControls, seconds: number) {
  for (let i = 0; i < seconds / FLIGHT_STEP; i++) m.step(ctl, ground);
}

const types = FLYABLE_JETS.filter((id) => id !== 'alliance-fighter');

describe('flyable jets', () => {
  it('each have targets here and an air-war entry', () => {
    expect(types.length).toBeGreaterThan(0);
    for (const id of types) {
      expect(TARGETS[id], id).toBeDefined();
      expect(AIRCRAFT_BUNDLES[id]!.airWar, id).not.toBeNull();
    }
  });
});

describe.each(types)('%s', (id) => {
  const t = TARGETS[id]!;
  const make = () => flightModelOf(id);
  const full = make().spec.engine.thrust.afterburner ? 1 : MIL_DETENT;

  it('rests on the runway with the parking brake set, the nose carrying 8–25% of the weight', () => {
    const m = make();
    spawnOnRunway(m, runway, end);
    const ctl = neutralControls();
    ctl.parkingBrake = true;
    run(m, ctl, 5);
    const p0 = m.pos.clone();
    run(m, ctl, 20);
    expect(m.crashed).toBeNull();
    expect(m.pos.distanceTo(p0)).toBeLessThan(0.01);
    expect(Math.abs(m.telemetry.pitch / DEG)).toBeLessThan(2);
    const total = m.wheels.reduce((s, w) => s + w.load, 0);
    expect(total / (m.mass * 9.80665)).toBeCloseTo(1, 2);
    expect(m.wheels[0]!.load / total).toBeGreaterThan(0.08);
    expect(m.wheels[0]!.load / total).toBeLessThan(0.25);
  });

  it('clears its tail to 13.5° of pitch on the main wheels, as the tail-strike warning assumes', () => {
    const spec = make().spec;
    const main = spec.gear.wheels.find((w) => w.name === 'left')!.at;
    let least = Infinity;
    for (const c of spec.contacts) {
      if (c[0] >= main[0]) continue;
      least = Math.min(least, Math.atan2(c[1] - main[1], main[0] - c[0]));
    }
    expect(least / DEG).toBeGreaterThan(13.5);
  });

  it('takes off at full power and full aft stick without a tail strike', () => {
    const m = make();
    spawnOnRunway(m, runway, end);
    const ctl = neutralControls();
    ctl.throttle = full;
    ctl.pitch = 1;
    const frame = runwayFrame(runway);
    const start = toRunway(runway, frame, m.pos, RADIUS).along;
    let rotate = 0;
    let roll = 0;
    for (let i = 0; i < 60 / FLIGHT_STEP && !roll; i++) {
      m.step(ctl, ground);
      const tel = m.telemetry;
      if (!rotate && m.wheels[0]!.load === 0 && tel.cas > 30) rotate = tel.cas;
      if (rotate)
        ctl.pitch = Math.max(-1, Math.min(1, 0.3 * (10 - tel.pitch / DEG) - 2 * m.omega.y));
      if (rotate && !m.onGround) roll = toRunway(runway, frame, m.pos, RADIUS).along - start;
    }
    expect(m.crashed).toBeNull();
    expect(rotate / KNOT).toBeGreaterThan(t.rotateKt[0]);
    expect(rotate / KNOT).toBeLessThan(t.rotateKt[1]);
    expect(roll).toBeGreaterThan(t.rollM[0]);
    expect(roll).toBeLessThan(t.rollM[1]);
  });

  it('stalls in the landing configuration within its range', () => {
    const m = make();
    m.fuel = 1000;
    spawnInAir(m, runway, end, 1500, 200 * KNOT);
    const ctl = neutralControls();
    m.gear = 1;
    const fd = new FlightDirector();
    const target = runway.elevation + 1500;
    let stall = 0;
    for (let i = 0; i < 120 / FLIGHT_STEP && !stall; i++) {
      const tel = m.telemetry;
      const gamma = Math.max(-0.1, Math.min(0.1, (target - tel.altitude) * 0.002));
      fd.fly(m, { course: end.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
      ctl.throttle = 0;
      m.step(ctl, ground);
      if (tel.alpha > m.spec.controls.maxAlpha - 1.5 * DEG && tel.verticalSpeed < -1.5)
        stall = tel.cas;
    }
    expect(stall / KNOT).toBeGreaterThan(t.stallKt[0]);
    expect(stall / KNOT).toBeLessThan(t.stallKt[1]);
  });

  it('reaches its sea-level top speed at full power', () => {
    const m = make();
    spawnInAir(m, runway, end, 300, 450 * KNOT);
    m.power = 1;
    const ctl = neutralControls();
    ctl.gearDown = false;
    const fd = new FlightDirector();
    for (let i = 0; i < 200 / FLIGHT_STEP; i++) {
      const tel = m.telemetry;
      const gamma = Math.max(
        -0.02,
        Math.min(0.02, (runway.elevation + 300 - tel.altitude) * 0.0005),
      );
      fd.fly(m, { course: end.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
      ctl.throttle = full;
      m.step(ctl, ground);
    }
    expect(m.telemetry.mach).toBeGreaterThan(t.seaLevelMach[0]);
    expect(m.telemetry.mach).toBeLessThan(t.seaLevelMach[1]);
  });

  it('holds its load factor and angle-of-attack limits at full aft stick', () => {
    for (const [speed, check] of [
      [550, 'load'],
      [220, 'alpha'],
    ] as const) {
      const m = make();
      spawnInAir(m, runway, end, 3000, speed * KNOT);
      const ctl = neutralControls();
      ctl.gearDown = false;
      ctl.throttle = full;
      ctl.pitch = 1;
      let load = 0;
      let alpha = 0;
      for (let i = 0; i < 4 / FLIGHT_STEP; i++) {
        m.step(ctl, ground);
        load = Math.max(load, m.telemetry.load);
        alpha = Math.max(alpha, m.telemetry.alpha);
      }
      const c = m.spec.controls;
      if (check === 'load') {
        expect(load).toBeGreaterThan(c.maxLoad - 1.5);
        expect(load).toBeLessThan(c.maxLoad + 0.5);
      } else expect(alpha / DEG).toBeLessThan((c.maxAlpha + 2.5 * DEG) / DEG);
    }
  });

  it('flies level and stable at 300 kt hands off once trimmed', () => {
    const m = make();
    spawnInAir(m, runway, end, 1500, 300 * KNOT);
    const ctl = neutralControls();
    ctl.gearDown = false;
    const fd = new FlightDirector();
    for (let i = 0; i < 60 / FLIGHT_STEP; i++) {
      fd.fly(m, { course: end.heading, gamma: 0, speed: 300 * KNOT }, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
    }
    const hands = neutralControls();
    hands.gearDown = false;
    hands.throttle = ctl.throttle;
    const alt0 = m.telemetry.altitude;
    const cas0 = m.telemetry.cas;
    let altErr = 0;
    let casErr = 0;
    for (let i = 0; i < 60 / FLIGHT_STEP; i++) {
      m.step(hands, ground);
      altErr = Math.max(altErr, Math.abs(m.telemetry.altitude - alt0));
      casErr = Math.max(casErr, Math.abs(m.telemetry.cas - cas0));
    }
    expect(Math.abs(cas0 - 300 * KNOT) / KNOT).toBeLessThan(3);
    expect(altErr).toBeLessThan(30);
    expect(casErr / KNOT).toBeLessThan(5);
  });

  it('flies the test pilot’s circuit and lands', () => {
    const m = make();
    spawnOnRunway(m, runway, end);
    const ctl = neutralControls();
    const pilot = new TestPilot(runway, end, RADIUS);
    const monitor = new FlightMonitor([runway], RADIUS);
    const events: FlightEvent[] = [];
    for (let i = 0; i < 900 / FLIGHT_STEP && !m.crashed && pilot.phase !== 'stopped'; i++) {
      pilot.fly(m, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
      events.push(...monitor.update(m, FLIGHT_STEP));
    }
    expect(m.crashed).toBeNull();
    expect(pilot.phase).toBe('stopped');
    const tds = events.filter((e) => e.kind === 'touchdown');
    expect(tds).toHaveLength(1);
    const td = tds[0]!.kind === 'touchdown' ? tds[0]!.touchdown : null;
    expect(td!.grade).not.toBe('hard');
  });

  it('cruises at its air-war speed and altitude on military power', () => {
    const type = bundleOfType(AIRCRAFT_BUNDLES[id]!.airWar!.id).airWar!;
    const m = make();
    spawnInAir(m, runway, end, type.cruiseAltitude, type.cruiseSpeed);
    m.power = 1;
    const ctl = neutralControls();
    ctl.gearDown = false;
    const fd = new FlightDirector();
    // The autothrottle holds the cruise speed's CAS; it needs less than military power.
    for (let i = 0; i < 2 / FLIGHT_STEP; i++) m.step(ctl, ground);
    const cas = m.telemetry.cas;
    for (let i = 0; i < 90 / FLIGHT_STEP; i++) {
      fd.fly(m, { course: end.heading, gamma: 0, speed: cas }, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
    }
    expect(ctl.throttle).toBeLessThan(MIL_DETENT);
    expect(Math.abs(m.telemetry.cas - cas) / KNOT).toBeLessThan(5);
  });
});
