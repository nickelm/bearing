import { describe, expect, it } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { neutralControls } from '../src/sim/flight/controlLaws';
import { FlightDirector } from '../src/sim/flight/flightDirector';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { fixedWingFromState, FlownAircraft } from '../src/sim/flight/flownAircraft';
import { FLIGHT_STEP } from '../src/sim/flight/rigidBody';
import { headingVector, runwayEnds } from '../src/sim/flight/runway';
import { spawnOnRunway } from '../src/sim/flight/spawn';
import { TestPilot } from '../src/sim/flight/testPilot';
import { flatGround, kestrel, kestrelSpec, RADIUS, testRunway } from './helpers/flight';

const runway = testRunway();
const end = runwayEnds(runway)[0];
const ground = flatGround(runway);

describe('the flown aircraft', () => {
  it('flies the scripted pilot’s circuit from a state, step for step as the airframe alone', () => {
    // 540 s: a whole circuit, takeoff to stop, flown by the test pilot.
    const STEPS = 540 / FLIGHT_STEP;
    // Reference: the airframe stepped directly, as the flight-model tests do.
    const ref = kestrel();
    spawnOnRunway(ref, runway, end);
    ref.fuel = 2500;
    ref.unlimitedFuel = false;
    const refCtl = neutralControls();
    const refPilot = new TestPilot(runway, end, RADIUS);
    for (let i = 0; i < STEPS && !ref.crashed; i++) {
      refPilot.fly(ref, refCtl, FLIGHT_STEP);
      ref.step(refCtl, ground);
    }
    expect(refPilot.phase).toBe('stopped');

    // The same lineup as a flight state: position, no velocity, fuel.
    const flown = fixedWingFromState(
      kestrelSpec(),
      RADIUS,
      { pos: lineupPos(), vel: new Vec3d(), fuel: 2500, heading: end.heading },
      neutralControls(),
      'f21',
    );
    const pilot = new TestPilot(runway, end, RADIUS);
    flown.pilot = (a, ctl, dt) => pilot.fly(a as FlightModel, ctl, dt);
    let steps = 0;
    flown.onStep = () => steps++;
    // Frames of exactly two steps, as the app advances it at 60 Hz.
    while (steps < STEPS && !flown.crashed) flown.advance(2 * FLIGHT_STEP, ground);
    expect(steps).toBe(STEPS);
    expect(pilot.phase).toBe('stopped');
    expect(flown.crashed).toBeNull();
    const m = flown.airframe as FlightModel;
    // Bit for bit the reference flight: the wrapper adds nothing to the physics.
    expect([m.pos.x, m.pos.y, m.pos.z]).toEqual([ref.pos.x, ref.pos.y, ref.pos.z]);
    expect(m.fuel).toBe(ref.fuel);
    expect(m.fuel).toBeLessThan(2500);
    expect(flown.distance).toBeGreaterThan(10_000);
  });

  it('holds a course and height from an air state, flown by the director', () => {
    const up = lineupPos().normalize();
    const pos = up.clone().scale(RADIUS + runway.elevation + 3000);
    const vel = headingVector(up, 90 * DEG).scale(320 * KNOT);
    const flown = fixedWingFromState(
      kestrelSpec(),
      RADIUS,
      { pos, vel, fuel: 3000 },
      neutralControls(),
      'f21',
    );
    const m = flown.airframe as FlightModel;
    expect(m.gear).toBe(0);
    const director = new FlightDirector();
    const target = { course: 90 * DEG, gamma: 0, speed: 300 * KNOT };
    flown.pilot = (_a, ctl, dt) => director.fly(m, target, ctl, dt);
    const h0 = m.pos.length();
    for (let i = 0; i < 60 * 60; i++) flown.advance(1 / 60, ground);
    expect(flown.crashed).toBeNull();
    expect(Math.abs(m.pos.length() - h0)).toBeLessThan(150);
    expect(Math.abs(m.telemetry.heading - 90 * DEG)).toBeLessThan(3 * DEG);
    expect(Math.abs(m.telemetry.cas - 300 * KNOT)).toBeLessThan(10 * KNOT);
    expect(m.fuel).toBeLessThan(3000);
  });

  it('caps the steps per advance and keeps no backlog past it', () => {
    const m = kestrel();
    spawnOnRunway(m, runway, end);
    const flown = new FlownAircraft(m, neutralControls(), 'f21');
    expect(flown.advance(10, ground, 30)).toBe(30);
    expect(flown.advance(0, ground, 30)).toBe(0);
  });
});

/** The lined-up Kestrel's CG, as spawnOnRunway places it. */
function lineupPos(): Vec3d {
  const m = kestrel();
  spawnOnRunway(m, runway, end);
  return m.pos.clone();
}
