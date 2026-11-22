/**
 * The direct-control hold (decision 306): from the attitude the pilot left, the Kestrel
 * holds the altitude or the flight path, and the track or the bank, through the flight
 * director and the same control laws.
 */
import { describe, expect, it } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { MIL_DETENT, neutralControls } from '../src/sim/flight/controlLaws';
import type { FlightControls } from '../src/sim/flight/controlLaws';
import { FlightDirector } from '../src/sim/flight/flightDirector';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { AttitudeHold, holdAllowed } from '../src/sim/flight/holds';
import { headingOf, runwayEnds } from '../src/sim/flight/runway';
import { spawnInAir } from '../src/sim/flight/spawn';
import { flatGround, kestrel, testRunway } from './helpers/flight';

const runway = testRunway();
const ground = flatGround(runway);
const end = runwayEnds(runway)[0];
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** An air start, then `setup` seconds of stick (pitch, roll), then the stick let go. */
function airborne(
  pitch: number,
  roll: number,
  setup: number,
): { m: FlightModel; ctl: FlightControls } {
  const m = kestrel();
  spawnInAir(m, runway, end, 3000, 330 * KNOT);
  const ctl = neutralControls();
  ctl.gearDown = false;
  ctl.throttle = MIL_DETENT;
  for (let i = 0; i < 2 / FLIGHT_STEP; i++) m.step(ctl, ground);
  ctl.pitch = pitch;
  ctl.roll = roll;
  for (let i = 0; i < setup / FLIGHT_STEP; i++) m.step(ctl, ground);
  ctl.pitch = 0;
  ctl.roll = 0;
  return { m, ctl };
}

function fly(m: FlightModel, ctl: FlightControls, hold: AttitudeHold | null, seconds: number) {
  const d = new FlightDirector();
  const track: number[] = [];
  for (let i = 0; i < seconds / FLIGHT_STEP; i++) {
    if (hold) hold.fly(d, m, ctl, FLIGHT_STEP);
    m.step(ctl, ground);
    track.push(headingOf(m.pos.clone().normalize(), m.vel));
  }
  return track;
}

describe('the direct-control hold (decision 306)', () => {
  it('levels the wings and holds the track and the altitude when let go nearly level', () => {
    const { m, ctl } = airborne(0, 0.06, 0.4);
    expect(holdAllowed(m)).toBe(true);
    const hold = new AttitudeHold();
    hold.engage(m);
    expect(hold.pitch?.kind).toBe('altitude');
    expect(hold.roll?.kind).toBe('track');
    expect(hold.label).toBe('alt hold');
    const alt = m.telemetry.altitude;
    const course = hold.roll!.kind === 'track' ? hold.roll!.course : 0;
    fly(m, ctl, hold, 30);
    expect(Math.abs(m.telemetry.bank) / DEG).toBeLessThan(2);
    expect(Math.abs(m.telemetry.altitude - alt)).toBeLessThan(15);
    expect(Math.abs(wrap(headingOf(m.pos.clone().normalize(), m.vel) - course)) / DEG).toBeLessThan(
      1,
    );
  });

  it('holds a bank in a steady turn at the altitude, where the laws alone would sink', () => {
    const banked = () => airborne(0, 0.35, 0.6);
    const { m, ctl } = banked();
    const bank = m.telemetry.bank;
    expect(Math.abs(bank) / DEG).toBeGreaterThan(15);
    const hold = new AttitudeHold();
    hold.engage(m);
    expect(hold.roll?.kind).toBe('bank');
    const alt = m.telemetry.altitude;
    const track = fly(m, ctl, hold, 20);
    expect(Math.abs(m.telemetry.bank - bank) / DEG).toBeLessThan(3);
    expect(Math.abs(m.telemetry.altitude - alt)).toBeLessThan(25);
    // Still turning, the same way.
    expect(Math.sign(wrap(track[track.length - 1]! - track[track.length - 121]!))).toBe(
      Math.sign(bank),
    );
    // Without the hold the same start sinks more.
    const free = banked();
    fly(free.m, free.ctl, null, 20);
    expect(Math.abs(free.m.telemetry.altitude - alt)).toBeGreaterThan(
      Math.abs(m.telemetry.altitude - alt),
    );
  });

  it('holds the flight path when let go in a climb', () => {
    const { m, ctl } = airborne(0.3, 0, 3);
    const gamma = m.telemetry.gamma;
    expect(gamma / DEG).toBeGreaterThan(8);
    const hold = new AttitudeHold();
    hold.engage(m);
    expect(hold.pitch?.kind).toBe('path');
    expect(hold.label).toBe('att hold');
    fly(m, ctl, hold, 8);
    expect(Math.abs(m.telemetry.gamma - gamma) / DEG).toBeLessThan(1.5);
  });

  it('stays out on the wheels and with the gear down', () => {
    const { m } = airborne(0, 0, 0.1);
    m.gear = 1;
    expect(holdAllowed(m)).toBe(false);
    const hold = new AttitudeHold();
    expect(hold.engaged).toBe(false);
    expect(hold.label).toBeNull();
  });
});
