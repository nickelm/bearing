/**
 * Flight-model figures for tuning (decision 134): measures the Kestrel's
 * plausibility targets the way tests/flightModel.test.ts checks them, and
 * prints the numbers.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/flight.preview.ts
 */
import { test } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { neutralControls } from '../src/sim/flight/controlLaws';
import { FlightDirector, speedForAlpha } from '../src/sim/flight/flightDirector';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import { runwayEnds, runwayFrame, toRunway } from '../src/sim/flight/runway';
import { spawnInAir, spawnOnRunway } from '../src/sim/flight/spawn';
import { flatGround, kestrel, RADIUS, testRunway } from '../tests/helpers/flight';

test('flight figures', () => {
  const r = testRunway();
  const ground = flatGround(r);
  const end = runwayEnds(r)[0];
  const rows: [string, string][] = [];

  // Takeoff: full aft stick from brake release, then about 10° of pitch.
  {
    const m = kestrel();
    spawnOnRunway(m, r, end);
    const ctl = neutralControls();
    ctl.throttle = 1;
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
    rows.push(['takeoff mass', `${m.mass.toFixed(0)} kg`]);
    rows.push(['rotation (nosewheel off, full aft stick)', `${(rotate / KNOT).toFixed(0)} KCAS`]);
    rows.push(['liftoff', `${(lift / KNOT).toFixed(0)} KCAS after ${dist.toFixed(0)} m`]);
    rows.push([
      'approach speed at 13° (this mass, gear down)',
      `${(speedForAlpha(m, 13 * DEG) / KNOT).toFixed(0)} KCAS`,
    ]);
  }
  // Stall in the landing configuration at 1,000 kg of fuel.
  {
    const m = kestrel();
    m.fuel = 1000;
    spawnInAir(m, r, end, 1500, 200 * KNOT);
    m.gear = 1;
    const ctl = neutralControls();
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
    rows.push(['stall, landing configuration, 10.8 t', `${(stall / KNOT).toFixed(0)} KCAS`]);
  }
  // Top speed at 300 m in afterburner.
  {
    const m = kestrel();
    spawnInAir(m, r, end, 300, 650 * KNOT);
    const ctl = neutralControls();
    ctl.gearDown = false;
    ctl.throttle = 1;
    const fd = new FlightDirector();
    for (let i = 0; i < 150 / FLIGHT_STEP; i++) {
      const t = m.telemetry;
      const gamma = Math.max(-0.02, Math.min(0.02, (r.elevation + 300 - t.altitude) * 0.0005));
      fd.fly(m, { course: end.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
    }
    rows.push(['top speed at 300 m, afterburner', `Mach ${m.telemetry.mach.toFixed(3)}`]);
  }
  // Level flight at 300 KCAS: trim, then 60 s hands off.
  {
    const m = kestrel();
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
    '\nKestrel flight figures\n' + rows.map(([k, v]) => `  ${k.padEnd(48)} ${v}`).join('\n'),
  );
});
