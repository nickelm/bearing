/**
 * Flight-model figures for tuning (decision 134): measures a type's plausibility
 * targets the way tests/flightModel.test.ts and tests/flightTypes.test.ts check them,
 * and prints the numbers. `TYPE` names the bundle (default the Kestrel's).
 *
 *   npx vitest run --config vitest.tools.config.ts tools/flight.preview.ts
 *   TYPE=pact-fighter npx vitest run --config vitest.tools.config.ts tools/flight.preview.ts
 */
import { test } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { MIL_DETENT, neutralControls } from '../src/sim/flight/controlLaws';
import { FlightDirector, speedForAlpha } from '../src/sim/flight/flightDirector';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { runwayEnds, runwayFrame, toRunway } from '../src/sim/flight/runway';
import { spawnInAir, spawnOnRunway } from '../src/sim/flight/spawn';
import { flatGround, flightModelOf, RADIUS, testRunway } from '../tests/helpers/flight';

const TYPE = process.env.TYPE ?? 'alliance-fighter';

test('flight figures', () => {
  const r = testRunway();
  const ground = flatGround(r);
  const end = runwayEnds(r)[0];
  const rows: [string, string][] = [];
  const make = () => flightModelOf(TYPE);
  const ab = make().spec.engine.thrust.afterburner !== null;
  const full = ab ? 1 : MIL_DETENT;
  const kt = (v: number) => `${(v / KNOT).toFixed(0)} KCAS`;

  /** Holds `alt` (m above the runway) on the runway's heading with throttle `lever` for `seconds`. */
  const level = (m: FlightModel, alt: number, lever: number, seconds: number) => {
    const ctl = neutralControls();
    ctl.gearDown = false;
    ctl.throttle = lever;
    const fd = new FlightDirector();
    for (let i = 0; i < seconds / FLIGHT_STEP; i++) {
      const t = m.telemetry;
      const gamma = Math.max(-0.02, Math.min(0.02, (r.elevation + alt - t.altitude) * 0.0005));
      fd.fly(m, { course: end.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
      ctl.throttle = lever;
      m.step(ctl, ground);
    }
  };

  // Takeoff: full aft stick from brake release, then about 10° of pitch.
  {
    const m = make();
    spawnOnRunway(m, r, end);
    const ctl = neutralControls();
    ctl.throttle = full;
    ctl.pitch = 1;
    const f = runwayFrame(r);
    const start = toRunway(r, f, m.pos, RADIUS).along;
    let rotate = 0;
    let lift = 0;
    let dist = 0;
    for (let i = 0; i < 40 / FLIGHT_STEP && !lift; i++) {
      m.step(ctl, ground);
      const t = m.telemetry;
      if (!rotate && m.wheels[0]!.load === 0 && t.cas > 30) rotate = t.cas;
      if (rotate) ctl.pitch = Math.max(-1, Math.min(1, 0.3 * (10 - t.pitch / DEG) - 2 * m.omega.y));
      if (rotate && !m.onGround) {
        lift = t.cas;
        dist = toRunway(r, f, m.pos, RADIUS).along - start;
      }
    }
    const a = m.spec.controls.approachAlpha;
    rows.push(['takeoff mass', `${m.mass.toFixed(0)} kg (${ab ? 'afterburner' : 'military'})`]);
    rows.push(['rotation (nosewheel off, full aft stick)', kt(rotate)]);
    rows.push(['liftoff', `${kt(lift)} after ${dist.toFixed(0)} m`]);
    rows.push([
      `approach speed at ${(a / DEG).toFixed(0)}° (this mass, gear down)`,
      kt(speedForAlpha(m, a)),
    ]);
  }
  // Stall in the landing configuration with 1,000 kg of fuel.
  {
    const m = make();
    m.fuel = 1000;
    spawnInAir(m, r, end, 1500, 200 * KNOT);
    m.gear = 1;
    const ctl = neutralControls();
    const fd = new FlightDirector();
    const target = r.elevation + 1500;
    let stall = 0;
    for (let i = 0; i < 120 / FLIGHT_STEP && !stall; i++) {
      const t = m.telemetry;
      const gamma = Math.max(-0.1, Math.min(0.1, (target - t.altitude) * 0.002));
      fd.fly(m, { course: end.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
      ctl.throttle = 0;
      m.step(ctl, ground);
      if (t.alpha > m.spec.controls.maxAlpha - 1.5 * DEG && t.verticalSpeed < -1.5) stall = t.cas;
    }
    rows.push([`stall, landing configuration, ${(m.mass / 1000).toFixed(1)} t`, kt(stall)]);
  }
  // Top speeds: at 300 m and at 11 km, full power.
  for (const [alt, v0, s] of [
    [300, 650 * KNOT, 150],
    [11000, 900 * KNOT, 300],
  ] as const) {
    const m = make();
    m.unlimitedFuel = true;
    spawnInAir(m, r, end, alt, v0);
    m.power = 1;
    level(m, alt, full, s);
    const t = m.telemetry;
    rows.push([
      `top speed at ${alt} m, ${ab ? 'afterburner' : 'military'}`,
      `Mach ${t.mach.toFixed(3)}, ${(t.tas / KNOT).toFixed(0)} kt true`,
    ]);
  }
  // Top speed at military power at 9 km (cruise).
  {
    const m = make();
    m.unlimitedFuel = true;
    spawnInAir(m, r, end, 9000, 480 * KNOT);
    m.power = 1;
    level(m, 9000, MIL_DETENT, 300);
    const t = m.telemetry;
    rows.push([
      'top speed at 9 km, military',
      `Mach ${t.mach.toFixed(3)}, ${(t.tas / KNOT).toFixed(0)} kt true`,
    ]);
  }
  // Specific excess power at military power (the climb rate at constant speed), 1 g.
  for (const alt of [0, 3000, 6000, 9000]) {
    const out: string[] = [];
    for (const cas of [300, 350, 400]) {
      const m = make();
      m.unlimitedFuel = true;
      spawnInAir(m, r, end, alt + 50, cas * KNOT);
      m.power = 1;
      level(m, alt + 50, MIL_DETENT, 0.5);
      // CAS → TAS at this altitude: start from the CAS asked for, as spawnInAir takes a true speed.
      const v0 = m.telemetry.tas;
      level(m, alt + 50, MIL_DETENT, 2);
      const v1 = m.telemetry.tas;
      const ps = (v0 * (v1 - v0)) / 2 / 9.80665;
      out.push(`${cas} kt ${ps.toFixed(0)}`);
    }
    rows.push([`climb at military, ${alt} m (true kt: m/s)`, out.join(', ')]);
  }
  // Roll rate at full stick at 350 kt, 3 km.
  {
    const m = make();
    spawnInAir(m, r, end, 3000, 350 * KNOT);
    const ctl = neutralControls();
    ctl.gearDown = false;
    ctl.throttle = MIL_DETENT;
    ctl.roll = 1;
    let p = 0;
    for (let i = 0; i < 2 / FLIGHT_STEP; i++) {
      m.step(ctl, ground);
      p = Math.max(p, Math.abs(m.omega.x));
    }
    rows.push(['roll rate, full stick, 350 kt', `${(p / DEG).toFixed(0)}°/s`]);
  }
  // Load at full aft stick at 450 kt, 3 km.
  {
    const m = make();
    spawnInAir(m, r, end, 3000, 450 * KNOT);
    const ctl = neutralControls();
    ctl.gearDown = false;
    ctl.throttle = full;
    ctl.pitch = 1;
    let n = 0;
    for (let i = 0; i < 2 / FLIGHT_STEP; i++) {
      m.step(ctl, ground);
      n = Math.max(n, m.telemetry.load);
    }
    rows.push(['load, full aft stick, 450 kt', `${n.toFixed(1)} g`]);
  }
  // Level flight at 300 KCAS: trim, then 60 s hands off.
  {
    const m = make();
    spawnInAir(m, r, end, 1500, 300 * KNOT);
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
    const a0 = m.telemetry.altitude;
    const c0 = m.telemetry.cas;
    let da = 0;
    let dc = 0;
    for (let i = 0; i < 60 / FLIGHT_STEP; i++) {
      m.step(hands, ground);
      da = Math.max(da, Math.abs(m.telemetry.altitude - a0));
      dc = Math.max(dc, Math.abs(m.telemetry.cas - c0));
    }
    rows.push([
      'level at 300 KCAS, 60 s hands off',
      `lever ${hands.throttle.toFixed(3)}, ±${da.toFixed(1)} m, ±${(dc / KNOT).toFixed(1)} kt, α ${(m.telemetry.alpha / DEG).toFixed(1)}°`,
    ]);
  }
  console.log(
    `\n${TYPE} flight figures\n` + rows.map(([k, v]) => `  ${k.padEnd(48)} ${v}`).join('\n'),
  );
});
