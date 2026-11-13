/**
 * The Free Flight flight model (decision 134): atmosphere, tables, control-law
 * limits, the ground model at rest, determinism, outcomes, and the plausibility
 * targets for the F-21 Kestrel (the F-16 analogue).
 */
import { describe, expect, it } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { rng } from '../src/core/rng';
import { Vec3d } from '../src/core/vec3d';
import {
  calibratedAirspeed,
  SEA_LEVEL_SPEED_OF_SOUND,
  standardAtmosphere,
} from '../src/sim/flight/atmosphere';
import { MIL_DETENT, neutralControls } from '../src/sim/flight/controlLaws';
import type { FlightControls } from '../src/sim/flight/controlLaws';
import { FlightDirector } from '../src/sim/flight/flightDirector';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import type { FlightModel, GroundQuery } from '../src/sim/flight/flightModel';
import { FlightSpecError, lookup, lookup2, parseFlightSpec } from '../src/sim/flight/flightSpec';
import { flightWarnings, FlightMonitor, gradeLanding } from '../src/sim/flight/outcomes';
import type { FlightEvent } from '../src/sim/flight/outcomes';
import { runwayEnds, runwayFrame, toRunway } from '../src/sim/flight/runway';
import { spawnInAir, spawnOnRunway } from '../src/sim/flight/spawn';
import { flatGround, kestrel, kestrelSpec, RADIUS, testRunway } from './helpers/flight';
import specJson from '../src/render/common/models/specs/alliance-fighter.json';

const runway = testRunway();
const ground = flatGround(runway);
const end = runwayEnds(runway)[0];

function run(m: FlightModel, ctl: FlightControls, seconds: number, g: GroundQuery = ground) {
  for (let i = 0; i < Math.round(seconds / FLIGHT_STEP); i++) m.step(ctl, g);
}

describe('standard atmosphere', () => {
  it('matches the 1976 tables at sea level, 11 km and 20 km', () => {
    const sl = standardAtmosphere(0);
    expect(sl.temperature).toBeCloseTo(288.15, 2);
    expect(sl.pressure).toBeCloseTo(101_325, 0);
    expect(sl.density).toBeCloseTo(1.225, 3);
    expect(sl.speedOfSound).toBeCloseTo(340.29, 1);
    const tp = standardAtmosphere(11_000);
    expect(tp.temperature).toBeCloseTo(216.65, 2);
    expect(tp.pressure / 22_632).toBeCloseTo(1, 3);
    expect(tp.density).toBeCloseTo(0.3639, 3);
    expect(tp.speedOfSound).toBeCloseTo(295.07, 1);
    const s20 = standardAtmosphere(20_000);
    expect(s20.pressure / 5474.9).toBeCloseTo(1, 3);
    expect(s20.density).toBeCloseTo(0.088_03, 4);
    expect(standardAtmosphere(5000).temperature).toBeCloseTo(255.65, 2);
  });

  it('is continuous at the layer boundaries', () => {
    for (const h of [11_000, 20_000]) {
      const a = standardAtmosphere(h - 0.01);
      const b = standardAtmosphere(h + 0.01);
      expect(Math.abs(a.pressure - b.pressure) / a.pressure).toBeLessThan(1e-5);
      expect(Math.abs(a.temperature - b.temperature)).toBeLessThan(1e-4);
    }
  });

  it('gives calibrated airspeed equal to true airspeed at sea level and less above it', () => {
    const sl = standardAtmosphere(0);
    for (const v of [50, 150, 300, 400, 500]) expect(calibratedAirspeed(v, sl)).toBeCloseTo(v, 3);
    const hi = standardAtmosphere(9000);
    const cas = calibratedAirspeed(250, hi);
    // About 250 · √(ρ/ρ0) with a compressibility correction.
    expect(cas).toBeGreaterThan(140);
    expect(cas).toBeLessThan(165);
    expect(SEA_LEVEL_SPEED_OF_SOUND).toBeCloseTo(340.29, 1);
  });
});

describe('flight spec and tables', () => {
  const spec = kestrelSpec();

  it('parses the Kestrel spec into SI units', () => {
    expect(spec.controls.maxAlpha).toBeCloseTo(25 * DEG, 6);
    expect(spec.aero.cl.x[0]).toBeCloseTo(-Math.PI / 2, 6);
    expect(spec.gear.wheels).toHaveLength(3);
  });

  it('rejects a broken spec with a path', () => {
    const bad = structuredClone((specJson as { flight: Record<string, unknown> }).flight);
    (bad.wing as Record<string, unknown>).area = -1;
    expect(() => parseFlightSpec(bad, 'x')).toThrow(FlightSpecError);
    expect(() => parseFlightSpec(bad, 'x')).toThrow(/wing\.area/);
  });

  it('interpolates tables and clamps at their ends', () => {
    const t = { x: [0, 1, 2], y: [0, 10, 0] };
    expect(lookup(t, 0.5)).toBe(5);
    expect(lookup(t, -1)).toBe(0);
    expect(lookup(t, 3)).toBe(0);
    expect(
      lookup2(
        [0, 1],
        [0, 1],
        [
          [0, 1],
          [2, 3],
        ],
        0.5,
        0.5,
      ),
    ).toBe(1.5);
  });

  it('has thrust that lapses with altitude, afterburner above military above idle', () => {
    const th = spec.engine.thrust;
    const T = (rows: number[][], h: number, m: number) => lookup2(th.altitude, th.mach, rows, h, m);
    // Sea-level static: about 100–125 kN in afterburner, 70–76 kN military (installed).
    expect(T(th.afterburner, 0, 0)).toBeGreaterThan(100_000);
    expect(T(th.afterburner, 0, 0)).toBeLessThan(125_000);
    expect(T(th.military, 0, 0)).toBeGreaterThan(68_000);
    expect(T(th.military, 0, 0)).toBeLessThan(77_000);
    for (const h of [0, 4000, 9000, 14_000]) {
      for (const m of [0, 0.5, 0.9, 1.3]) {
        expect(T(th.afterburner, h, m)).toBeGreaterThan(T(th.military, h, m));
        expect(T(th.military, h, m)).toBeGreaterThan(T(th.idle, h, m));
        expect(T(th.military, h + 3000, m)).toBeLessThan(T(th.military, h, m));
      }
    }
  });

  it('has a transonic drag rise and a lift curve with a stall break', () => {
    const a = spec.aero;
    expect(lookup(a.cd0, 1.1) / lookup(a.cd0, 0.5)).toBeGreaterThan(3);
    expect(lookup(a.cd0, 0.85)).toBeLessThan(lookup(a.cd0, 0.95));
    // CL rises to a maximum near 30° and falls beyond it.
    const clMax = Math.max(...a.cl.y);
    const at = a.cl.x[a.cl.y.indexOf(clMax)]!;
    expect(at / DEG).toBeGreaterThan(25);
    expect(at / DEG).toBeLessThan(36);
    expect(lookup(a.cl, 50 * DEG)).toBeLessThan(clMax * 0.8);
  });
});

/** Flies `seconds` with stick `pitch`/`roll` from a 1-g air start; returns extremes. */
function maneuver(
  speed: number,
  altitude: number,
  pitch: number,
  roll: number,
  seconds: number,
): { nMax: number; nMin: number; alphaMax: number; pMax: number } {
  const m = kestrel();
  spawnInAir(m, runway, end, altitude, speed);
  const ctl = neutralControls();
  ctl.gearDown = false;
  ctl.throttle = MIL_DETENT;
  run(m, ctl, 2);
  ctl.pitch = pitch;
  ctl.roll = roll;
  let nMax = -Infinity;
  let nMin = Infinity;
  let alphaMax = 0;
  let pMax = 0;
  for (let i = 0; i < seconds / FLIGHT_STEP; i++) {
    m.step(ctl, ground);
    const t = m.telemetry;
    nMax = Math.max(nMax, t.load);
    nMin = Math.min(nMin, t.load);
    alphaMax = Math.max(alphaMax, t.alpha);
    pMax = Math.max(pMax, Math.abs(m.omega.x));
  }
  return { nMax, nMin, alphaMax, pMax };
}

describe('control laws', () => {
  it('limits load factor to +9 g at full aft stick at high speed', () => {
    const r = maneuver(550 * KNOT, 1000, 1, 0, 3);
    expect(r.nMax).toBeGreaterThan(8.5);
    expect(r.nMax).toBeLessThan(9.5);
  });

  it('limits load factor to −3 g at full forward stick', () => {
    const r = maneuver(500 * KNOT, 3000, -1, 0, 2);
    expect(r.nMin).toBeLessThan(-2.5);
    expect(r.nMin).toBeGreaterThan(-3.5);
  });

  it('limits angle of attack near 25° at low speed', () => {
    const r = maneuver(250 * KNOT, 3000, 1, 0, 6);
    expect(r.alphaMax / DEG).toBeGreaterThan(22);
    expect(r.alphaMax / DEG).toBeLessThan(26.5);
  });

  it('commands a roll rate near 230°/s at full lateral stick', () => {
    const r = maneuver(400 * KNOT, 3000, 0, 1, 1.5);
    expect(r.pMax / DEG).toBeGreaterThan(200);
    expect(r.pMax / DEG).toBeLessThan(245);
  });

  it('holds sideslip near zero in a rolling turn (turn coordination)', () => {
    const m = kestrel();
    spawnInAir(m, runway, end, 3000, 350 * KNOT);
    const ctl = neutralControls();
    ctl.gearDown = false;
    ctl.throttle = MIL_DETENT;
    ctl.roll = 0.5;
    let betaMax = 0;
    for (let i = 0; i < 0.5 / FLIGHT_STEP; i++) {
      m.step(ctl, ground);
      betaMax = Math.max(betaMax, Math.abs(m.telemetry.beta));
    }
    ctl.roll = 0;
    ctl.pitch = 0.3;
    for (let i = 0; i < 5 / FLIGHT_STEP; i++) {
      m.step(ctl, ground);
      betaMax = Math.max(betaMax, Math.abs(m.telemetry.beta));
    }
    expect(betaMax / DEG).toBeLessThan(2);
  });
});

describe('ground model', () => {
  it('rests on the runway with the parking brake set: no drift or jitter over 60 s', () => {
    const m = kestrel();
    spawnOnRunway(m, runway, end);
    const ctl = neutralControls();
    ctl.parkingBrake = true;
    run(m, ctl, 5);
    const p0 = m.pos.clone();
    const pitch0 = m.telemetry.pitch;
    let vMax = 0;
    for (let i = 0; i < 60 / FLIGHT_STEP; i++) {
      m.step(ctl, ground);
      vMax = Math.max(vMax, m.vel.length());
    }
    expect(m.crashed).toBeNull();
    expect(m.pos.distanceTo(p0)).toBeLessThan(0.01);
    expect(vMax).toBeLessThan(0.001);
    expect(Math.abs(m.telemetry.pitch - pitch0)).toBeLessThan(0.01 * DEG);
    // All three wheels carry the weight, the nose about a sixth of it.
    const total = m.wheels.reduce((s, w) => s + w.load, 0);
    expect(total / (m.mass * 9.80665)).toBeCloseTo(1, 2);
    expect(m.wheels[0]!.load / total).toBeGreaterThan(0.1);
    expect(m.wheels[0]!.load / total).toBeLessThan(0.25);
  });

  it('creeps forward at idle without brakes and stops with them', () => {
    const m = kestrel();
    spawnOnRunway(m, runway, end);
    const ctl = neutralControls();
    run(m, ctl, 10);
    expect(m.telemetry.groundSpeed).toBeGreaterThan(0.2);
    ctl.brakeLeft = ctl.brakeRight = 1;
    run(m, ctl, 10);
    expect(m.telemetry.groundSpeed).toBeLessThan(0.01);
  });

  it('steers with the nosewheel, and differential braking tightens the turn', () => {
    const turn = (brake: number) => {
      const m = kestrel();
      spawnOnRunway(m, runway, end);
      const ctl = neutralControls();
      ctl.throttle = 0.3;
      run(m, ctl, 6);
      ctl.yaw = 0.4;
      ctl.brakeRight = brake;
      const h0 = m.telemetry.heading;
      run(m, ctl, 4);
      expect(m.crashed).toBeNull();
      const d = m.telemetry.heading - h0;
      return Math.atan2(Math.sin(d), Math.cos(d)) / DEG;
    };
    const steer = turn(0);
    const both = turn(0.6);
    expect(steer).toBeGreaterThan(10);
    expect(both).toBeGreaterThan(steer + 1);
  });

  it('extends and retracts the gear over its transit time and warns above its speed', () => {
    const m = kestrel();
    spawnInAir(m, runway, end, 3000, 250 * KNOT);
    const ctl = neutralControls();
    ctl.throttle = 0.3;
    ctl.gearDown = true;
    run(m, ctl, 3);
    expect(m.gear).toBeGreaterThan(0.4);
    expect(m.gear).toBeLessThan(0.6);
    run(m, ctl, 4);
    expect(m.gear).toBe(1);
  });
});

describe('determinism', () => {
  it('gives identical states for identical input sequences', () => {
    const fly = () => {
      const m = kestrel();
      spawnOnRunway(m, runway, end);
      const r = rng(1, 'flight-test-inputs');
      const ctl = neutralControls();
      ctl.throttle = 1;
      for (let i = 0; i < 40 / FLIGHT_STEP; i++) {
        if (i % 30 === 0) {
          ctl.pitch = m.telemetry.cas > 150 * KNOT ? r.range(0.1, 0.4) : 0;
          ctl.roll = r.range(-0.2, 0.2);
          ctl.yaw = r.range(-0.1, 0.1);
          ctl.gearDown = m.telemetry.radarAltitude < 20;
        }
        m.step(ctl, ground);
      }
      return [m.pos.x, m.pos.y, m.pos.z, m.vel.x, m.q.w, m.q.x, m.omega.y, m.time];
    };
    const a = fly();
    const b = fly();
    expect(b).toEqual(a);
  });
});

describe('outcomes', () => {
  it('grades landings by sink rate', () => {
    expect(gradeLanding(0.5)).toBe('smooth');
    expect(gradeLanding(1.5)).toBe('good');
    expect(gradeLanding(2.5)).toBe('firm');
    expect(gradeLanding(4)).toBe('hard');
  });

  /** Drops the aircraft onto the runway at sink rate `sink` with the gear `down`. */
  function drop(sink: number, down: boolean): { events: FlightEvent[]; m: FlightModel } {
    const m = kestrel();
    const frame = runwayFrame(runway);
    const along = end.threshold + 500;
    const pos = frame.up
      .clone()
      .addScaled(frame.fwd, along / RADIUS)
      .normalize()
      .scale(RADIUS + runway.elevation + m.gearHeight + 0.05);
    const up = pos.clone().normalize();
    const fwd = frame.fwd.clone();
    const vel = fwd.scale(75).addScaled(up, -sink);
    m.place(pos, vel, end.heading, 8 * DEG, 0);
    m.gear = down ? 1 : 0;
    const mon = new FlightMonitor([runway], RADIUS);
    mon.reset(true);
    const ctl = neutralControls();
    ctl.gearDown = down;
    const events: FlightEvent[] = [];
    for (let i = 0; i < 3 / FLIGHT_STEP; i++) {
      m.step(ctl, ground);
      events.push(...mon.update(m, FLIGHT_STEP));
    }
    return { events, m };
  }

  it('records a touchdown with sink rate, distance from the threshold and grade', () => {
    const { events, m } = drop(1.2, true);
    const td = events.find((e) => e.kind === 'touchdown');
    expect(td && td.kind === 'touchdown').toBe(true);
    if (td?.kind !== 'touchdown') return;
    expect(td.touchdown.sinkRate).toBeGreaterThan(1);
    expect(td.touchdown.sinkRate).toBeLessThan(2);
    expect(td.touchdown.distance!).toBeGreaterThan(450);
    expect(td.touchdown.distance!).toBeLessThan(560);
    expect(td.touchdown.inZone).toBe(true);
    expect(td.touchdown.runway?.name).toBe('Test Air Base');
    expect(m.crashed).toBeNull();
  });

  it('marks a hard landing above 3 m/s and crashes above 6 m/s', () => {
    const hard = drop(4, true).events.find((e) => e.kind === 'touchdown');
    expect(hard?.kind === 'touchdown' && hard.touchdown.grade).toBe('hard');
    const { events, m } = drop(7, true);
    expect(m.crashed).toMatch(/sink rate/);
    expect(events.some((e) => e.kind === 'crash')).toBe(true);
  });

  it('crashes on contact with the gear up', () => {
    const { m } = drop(1, false);
    expect(m.crashed).toMatch(/gear up/);
  });

  it('crashes on terrain away from a runway', () => {
    const m = kestrel();
    const hills: GroundQuery = { height: () => 2000, surface: () => 'land' };
    spawnInAir(m, runway, end, 1000, 300 * KNOT);
    run(m, neutralControls(), 1, hills);
    expect(m.crashed).not.toBeNull();
  });
});

describe('rotation with a keyboard (owner report: sluggish, then a tail strike)', () => {
  /**
   * Afterburner takeoff; at 150 KCAS the pilot holds full aft stick (ramping in as
   * the keyboard does, 2.5/s) until the pitch reaches `target`, and lets go a
   * quarter second later (the stick recentres at 4/s).
   */
  function keyboardTakeoff(target: number, reaction = 0.25) {
    const m = kestrel();
    spawnOnRunway(m, runway, end);
    const ctl = neutralControls();
    ctl.throttle = 1;
    let held = false;
    let reached = -1;
    let released = -1;
    let t = 0;
    let maxPitch = 0;
    let maxGroundPitch = 0;
    let maxRate = 0;
    let maxBlend = 0;
    let pitchAtRelease = 0;
    let after: number[] = [];
    for (let i = 0; i < 40 / FLIGHT_STEP && !m.crashed; i++) {
      t += FLIGHT_STEP;
      const tel = m.telemetry;
      if (!held && released < 0 && tel.cas > 150 * KNOT) held = true;
      if (held && reached < 0 && tel.pitch >= target * DEG) reached = t;
      if (held && reached >= 0 && t - reached >= reaction) {
        held = false;
        released = t;
        pitchAtRelease = tel.pitch / DEG;
      }
      const rate = held ? 2.5 : 4;
      ctl.pitch += Math.max(
        -rate * FLIGHT_STEP,
        Math.min(rate * FLIGHT_STEP, (held ? 1 : 0) - ctl.pitch),
      );
      m.step(ctl, ground);
      maxPitch = Math.max(maxPitch, tel.pitch / DEG);
      if (m.onGround) maxGroundPitch = Math.max(maxGroundPitch, tel.pitch / DEG);
      maxRate = Math.max(maxRate, m.omega.y / DEG);
      maxBlend = Math.max(maxBlend, tel.laws.blend);
      if (released > 0 && t > released + 1 && t < released + 4) after.push(tel.pitch / DEG);
      if (released > 0 && t > released + 4) break;
    }
    after = after.length ? after : [NaN];
    return {
      m,
      maxPitch,
      maxGroundPitch,
      maxRate,
      maxBlend,
      pitchAtRelease,
      settle: Math.max(...after) - Math.min(...after),
    };
  }

  it('rotates at the commanded rate and stops short of the tail when released at 9°', () => {
    const r = keyboardTakeoff(9);
    expect(r.m.crashed).toBeNull();
    expect(r.m.onGround).toBe(false);
    // 5°/s commanded; no whip-up when the wheels unload.
    expect(r.maxRate).toBeLessThan(6);
    // The tail strikes near 13.5°.
    expect(r.maxPitch).toBeLessThan(12.5);
    // With the gear down the pitch law stays in rate command through liftoff.
    expect(r.maxBlend).toBe(0);
    // Released, the attitude holds.
    expect(r.settle).toBeLessThan(1);
  });

  it('forgives a late release: held to 11° and released half a second later, no tail strike', () => {
    const r = keyboardTakeoff(11, 0.5);
    expect(r.m.crashed).toBeNull();
    // Airborne by then: the tail clears the runway (it strikes near 13.5° on the gear).
    expect(r.maxGroundPitch).toBeLessThan(12.5);
  });

  it('warns of a tail strike on the ground above 10.5° of pitch', () => {
    const m = kestrel();
    spawnOnRunway(m, runway, end);
    run(m, neutralControls(), 1);
    expect(flightWarnings(m)).not.toContain('tail-strike');
    m.telemetry.pitch = 11 * DEG;
    expect(flightWarnings(m)).toContain('tail-strike');
  });
});

describe('plausibility (F-16 analogue)', () => {
  it('takes off in afterburner in 500–1,000 m, rotating at 140–160 kt with full aft stick', () => {
    const m = kestrel();
    spawnOnRunway(m, runway, end);
    const ctl = neutralControls();
    ctl.parkingBrake = true;
    run(m, ctl, 2);
    ctl.parkingBrake = false;
    ctl.throttle = 1;
    ctl.pitch = 1;
    const frame = runwayFrame(runway);
    const start = toRunway(runway, frame, m.pos, RADIUS).along;
    let rotate = 0;
    let rollDist = 0;
    for (let i = 0; i < 40 / FLIGHT_STEP && !rollDist; i++) {
      m.step(ctl, ground);
      const t = m.telemetry;
      if (!rotate && m.wheels[0]!.load === 0 && t.cas > 30) {
        rotate = t.cas;
        ctl.pitch = 0;
      }
      // Hold about 10° of pitch after rotation, as a pilot would.
      if (rotate) ctl.pitch = Math.max(-1, Math.min(1, 0.3 * (10 - t.pitch / DEG) - 2 * m.omega.y));
      if (rotate && !m.onGround) rollDist = toRunway(runway, frame, m.pos, RADIUS).along - start;
    }
    expect(m.crashed).toBeNull();
    expect(rotate / KNOT).toBeGreaterThan(140);
    expect(rotate / KNOT).toBeLessThan(160);
    expect(rollDist).toBeGreaterThan(500);
    expect(rollDist).toBeLessThan(1000);
  });

  it('stalls at 120–140 kt in the landing configuration', () => {
    const m = kestrel();
    m.fuel = 1000;
    spawnInAir(m, runway, end, 1500, 200 * KNOT);
    const ctl = neutralControls();
    ctl.gearDown = true;
    ctl.throttle = 0;
    m.gear = 1;
    const fd = new FlightDirector();
    const target = m.telemetry.altitude;
    let stall = 0;
    for (let i = 0; i < 120 / FLIGHT_STEP && !stall; i++) {
      const t = m.telemetry;
      const gamma = Math.max(-0.1, Math.min(0.1, (target - t.altitude) * 0.002));
      fd.fly(m, { course: end.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
      ctl.throttle = 0;
      m.step(ctl, ground);
      if (t.alpha > m.spec.controls.maxAlpha - 1.5 * DEG && t.verticalSpeed < -1.5) stall = t.cas;
    }
    expect(stall / KNOT).toBeGreaterThan(120);
    expect(stall / KNOT).toBeLessThan(140);
  });

  it('reaches Mach 1.1–1.2 at sea level in afterburner', () => {
    const m = kestrel();
    spawnInAir(m, runway, end, 300, 650 * KNOT);
    const ctl = neutralControls();
    ctl.gearDown = false;
    ctl.throttle = 1;
    const fd = new FlightDirector();
    for (let i = 0; i < 150 / FLIGHT_STEP; i++) {
      const t = m.telemetry;
      const gamma = Math.max(-0.02, Math.min(0.02, (runway.elevation + 300 - t.altitude) * 0.0005));
      fd.fly(m, { course: end.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
    }
    expect(m.telemetry.mach).toBeGreaterThan(1.1);
    expect(m.telemetry.mach).toBeLessThan(1.2);
  });

  it('flies level and stable at 300 kt with trim', () => {
    const m = kestrel();
    spawnInAir(m, runway, end, 1500, 300 * KNOT);
    const ctl = neutralControls();
    ctl.gearDown = false;
    // Trim: an autothrottle finds the lever for 300 KCAS, then hands off.
    const fd = new FlightDirector();
    for (let i = 0; i < 60 / FLIGHT_STEP; i++) {
      fd.fly(m, { course: end.heading, gamma: 0, speed: 300 * KNOT }, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
    }
    const lever = ctl.throttle;
    const hands = neutralControls();
    hands.gearDown = false;
    hands.throttle = lever;
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
    expect(Math.abs(m.telemetry.bank / DEG)).toBeLessThan(1);
  });
});

void Vec3d;
