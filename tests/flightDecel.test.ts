/**
 * The Kestrel slows down and lands straight in (decision 207): the drag polar's terms, idle
 * thrust and spool times, the speedbrake's travel and limit, the gear's overspeed (a warning,
 * then door damage, never a refusal), the deceleration and approach plausibility targets at
 * landing weight, and the scripted straight-in approach from 25 km at 450 KIAS.
 */
import { describe, expect, it } from 'vitest';
import { DEG, KNOT } from '../src/core/units';
import { speedForAlpha } from '../src/sim/flight/flightDirector';
import { FlightDirector } from '../src/sim/flight/flightDirector';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import { lookup, lookup2 } from '../src/sim/flight/flightSpec';
import { flightWarnings } from '../src/sim/flight/outcomes';
import { TOUCHDOWN_ZONE } from '../src/sim/flight/runway';
import { kestrelSpec } from './helpers/flight';
import {
  decelTime,
  idleGlide,
  levelStart,
  levelStep,
  onSpeedPath,
  SEA_GROUND,
  spoolTime,
  straightInApproach,
} from './helpers/decel';

const spec = kestrelSpec();
const H = 1500;

describe('drag polar and engine (decision 207)', () => {
  it('has the drag terms in their target ranges', () => {
    const a = spec.aero;
    for (const m of [0, 0.3, 0.6, 0.8]) {
      expect(lookup(a.cd0, m)).toBeGreaterThanOrEqual(0.02);
      expect(lookup(a.cd0, m)).toBeLessThanOrEqual(0.025);
    }
    // k = 1 / (π·AR·e) with the wing's aspect ratio near 3 and e between 0.7 and 0.8.
    const ar = spec.wing.span ** 2 / spec.wing.area;
    expect(ar).toBeGreaterThan(2.8);
    expect(ar).toBeLessThan(3.5);
    const e = 1 / (Math.PI * ar * a.induced);
    expect(e).toBeGreaterThanOrEqual(0.7);
    expect(e).toBeLessThanOrEqual(0.81);
    expect(a.cdGear).toBeGreaterThanOrEqual(0.015);
    expect(a.cdGear).toBeLessThanOrEqual(0.025);
    expect(a.cdSpeedbrake).toBeGreaterThanOrEqual(0.04);
    expect(a.cdSpeedbrake).toBeLessThanOrEqual(0.06);
    // Separated flow: nothing while attached, then steeply above 15°.
    expect(lookup(a.cdSeparated, 10 * DEG)).toBe(0);
    expect(lookup(a.cdSeparated, 13 * DEG)).toBe(0);
    expect(lookup(a.cdSeparated, 20 * DEG)).toBeGreaterThan(0.05);
    expect(lookup(a.cdSeparated, 25 * DEG)).toBeGreaterThan(0.15);
    expect(lookup(a.cdSeparated, 90 * DEG)).toBeGreaterThan(1);
  });

  it('idles at a few percent of military thrust when slow, and near zero by Mach 0.7', () => {
    const th = spec.engine.thrust;
    for (const h of th.altitude) {
      const idle = (m: number) => lookup2(th.altitude, th.mach, th.idle, h, m);
      const mil = (m: number) => lookup2(th.altitude, th.mach, th.military, h, m);
      expect(idle(0) / mil(0)).toBeGreaterThan(0.02);
      expect(idle(0) / mil(0)).toBeLessThan(0.08);
      expect(Math.abs(idle(0.7)) / mil(0.7)).toBeLessThan(0.01);
    }
  });

  it('spools down from military to idle in 2–4 s and up in 4–6 s', () => {
    const down = spoolTime(0.8, 0);
    expect(down.seconds).toBeGreaterThan(2);
    expect(down.seconds).toBeLessThan(4);
    const up = spoolTime(0, 0.8);
    expect(up.seconds).toBeGreaterThan(4);
    expect(up.seconds).toBeLessThan(6);
  });
});

describe('speedbrake (decision 207)', () => {
  it('opens to 60° in 1–2 s with the gear up, to 43° with the gear handle down', () => {
    const { m, ctl } = levelStart(300 * KNOT, H, { gear: false, speedbrake: false });
    const fd = new FlightDirector();
    ctl.speedbrake = true;
    let full = 0;
    for (let i = 1; i <= 4 / FLIGHT_STEP; i++) {
      levelStep(m, ctl, fd, H);
      if (!full && m.speedbrake >= 1) full = i * FLIGHT_STEP;
    }
    expect(full).toBeGreaterThanOrEqual(1);
    expect(full).toBeLessThanOrEqual(2);
    expect(m.speedbrakeDeflection / DEG).toBeCloseTo(60, 6);
    // Gear handle down: the panels close to 43°, and open no further.
    ctl.gearDown = true;
    for (let i = 0; i < 6 / FLIGHT_STEP; i++) levelStep(m, ctl, fd, H);
    expect(m.speedbrakeDeflection / DEG).toBeCloseTo(43, 6);
    // Drag by deflection: 43° gives sin²43° / sin²60° of the full increment.
    const share = Math.sin(43 * DEG) ** 2 / Math.sin(60 * DEG) ** 2;
    expect(m.telemetry.drag.speedbrake).toBeCloseTo(spec.aero.cdSpeedbrake * share, 9);
  });

  it('keeps the nose steady as it opens: the pitch law holds its pitch-up', () => {
    const { m, ctl } = levelStart(350 * KNOT, H, { gear: false, speedbrake: false });
    const fd = new FlightDirector();
    for (let i = 0; i < 5 / FLIGHT_STEP; i++) levelStep(m, ctl, fd, H);
    // Hands off: neutral stick, the load-factor law holds 1 g.
    const hands = { ...ctl, pitch: 0, roll: 0, yaw: 0, speedbrake: true };
    const gamma0 = m.telemetry.gamma;
    const alt0 = m.telemetry.altitude;
    let gammaDev = 0;
    let qMax = 0;
    for (let i = 0; i < 6 / FLIGHT_STEP; i++) {
      m.step(hands, SEA_GROUND);
      gammaDev = Math.max(gammaDev, Math.abs(m.telemetry.gamma - gamma0));
      qMax = Math.max(qMax, Math.abs(m.omega.y));
    }
    expect(gammaDev / DEG).toBeLessThan(0.5);
    expect(qMax / DEG).toBeLessThan(1);
    expect(Math.abs(m.telemetry.altitude - alt0)).toBeLessThan(15);
  });
});

describe('gear overspeed (decision 207)', () => {
  it('extends in 3–5 s, adding drag in proportion to its travel', () => {
    const { m, ctl } = levelStart(250 * KNOT, H, { gear: false, speedbrake: false });
    const fd = new FlightDirector();
    ctl.gearDown = true;
    let half = 0;
    let down = 0;
    for (let i = 1; i <= 8 / FLIGHT_STEP && !down; i++) {
      levelStep(m, ctl, fd, H);
      if (!half && m.gear >= 0.5) {
        half = i;
        expect(m.telemetry.drag.gear).toBeCloseTo(spec.aero.cdGear * m.gear, 9);
        expect(m.telemetry.drag.gear).toBeGreaterThan(0.4 * spec.aero.cdGear);
      }
      if (m.gear >= 1) down = i * FLIGHT_STEP;
    }
    expect(down).toBeGreaterThanOrEqual(3);
    expect(down).toBeLessThanOrEqual(5);
  });

  it('extends above the limit with GEAR SPEED, and a brief or small excess does no harm', () => {
    // 310 KIAS for 20 s, then 330 KIAS for 2 s: both under the damage rule.
    const { m, ctl } = levelStart(310 * KNOT, H, { gear: false, speedbrake: false });
    const fd = new FlightDirector();
    ctl.gearDown = true;
    ctl.throttle = 0.8;
    m.power = 1;
    for (let i = 0; i < 0.5 / FLIGHT_STEP; i++) levelStep(m, ctl, fd, H);
    expect(m.gear).toBeGreaterThan(0.1);
    expect(flightWarnings(m)).toContain('gear-speed');
    // Hold 310 KIAS with the director's autothrottle, level.
    let peak = 0;
    for (let i = 0; i < 20 / FLIGHT_STEP; i++) {
      const gamma = Math.max(-0.05, Math.min(0.05, (H - m.telemetry.altitude) * 0.003));
      fd.fly(m, { course: m.telemetry.heading, gamma, speed: 310 * KNOT }, ctl, FLIGHT_STEP);
      m.step(ctl, SEA_GROUND);
      if (i * FLIGHT_STEP > 5) peak = Math.max(peak, m.telemetry.cas);
    }
    expect(peak / KNOT).toBeGreaterThan(305);
    expect(peak / KNOT).toBeLessThan(318);
    expect(m.gear).toBe(1);
    expect(flightWarnings(m)).toContain('gear-speed');
    expect(m.gearDamaged).toBe(false);
    // Retracting is allowed too (with the warning): the gear comes up.
    ctl.gearDown = false;
    for (let i = 0; i < 6 / FLIGHT_STEP; i++) levelStep(m, ctl, fd, H);
    expect(m.gear).toBe(0);
    expect(m.gearDamaged).toBe(false);
    expect(flightWarnings(m)).not.toContain('gear-speed');
    // A brief excess: gear down at 335 KIAS, slowing at idle with the speedbrake, spends
    // under the damage time above 320 KIAS.
    const brief = levelStart(335 * KNOT, H, { gear: true, speedbrake: true });
    let over = 0;
    for (let i = 0; i < 10 / FLIGHT_STEP; i++) {
      levelStep(brief.m, brief.ctl, fd, H);
      if (brief.m.telemetry.cas > brief.m.spec.gear.maxSpeed + brief.m.spec.gear.damageMargin)
        over += FLIGHT_STEP;
    }
    expect(over).toBeGreaterThan(1);
    expect(brief.m.gearDamaged).toBe(false);
  });

  it('damages the gear doors after sustained flight 20 kt over the limit: gear stuck down, more drag', () => {
    const { m, ctl } = levelStart(380 * KNOT, H, { gear: false, speedbrake: false });
    const fd = new FlightDirector();
    ctl.throttle = 0.8;
    m.power = 1;
    ctl.gearDown = true;
    let damagedAt = 0;
    for (let i = 1; i <= 12 / FLIGHT_STEP && !damagedAt; i++) {
      levelStep(m, ctl, fd, H);
      if (m.gearDamaged) damagedAt = i * FLIGHT_STEP;
    }
    expect(damagedAt).toBeGreaterThan(3);
    expect(damagedAt).toBeLessThan(6);
    // The handle comes up; the gear stays down, with the doors' drag.
    ctl.gearDown = false;
    for (let i = 0; i < 6 / FLIGHT_STEP; i++) levelStep(m, ctl, fd, H);
    expect(m.gear).toBe(1);
    expect(m.telemetry.drag.gear).toBeCloseTo(spec.aero.cdGear + spec.aero.cdGearDamage, 9);
    // A new sortie repairs it.
    m.place(m.pos, m.vel, 0, 0);
    expect(m.gearDamaged).toBe(false);
  });
});

describe('plausibility of the approach (decision 207; landing weight, no added stores)', () => {
  it('decelerates level from 450 to 300 KIAS at idle with the speedbrake in 20–40 s', () => {
    const t = decelTime(450 * KNOT, 300 * KNOT, H, { gear: false, speedbrake: true }).seconds;
    expect(t).toBeGreaterThan(20);
    expect(t).toBeLessThan(40);
  });

  it('decelerates from 300 to 170 KIAS at idle, speedbrake 43°, gear down in 30–60 s', () => {
    const r = decelTime(300 * KNOT, 170 * KNOT, H, { gear: true, speedbrake: true });
    expect(r.m.speedbrakeDeflection / DEG).toBeCloseTo(43, 3);
    expect(r.seconds).toBeGreaterThan(30);
    expect(r.seconds).toBeLessThan(60);
  });

  it('has L/D of 5–8 at 13°, gear down, speedbrake 43°, and needs thrust well above idle on a 3° path', () => {
    const p = onSpeedPath(-3 * DEG);
    expect(p.m.speedbrakeDeflection / DEG).toBeCloseTo(43, 3);
    expect(Math.abs(p.alpha - 13 * DEG) / DEG).toBeLessThan(0.3);
    expect(p.ld).toBeGreaterThan(5);
    expect(p.ld).toBeLessThan(8);
    // A power-on approach: several times the idle thrust, with the lever well off idle.
    expect(p.thrust).toBeGreaterThan(3 * p.idleThrust);
    expect(p.lever).toBeGreaterThan(0.1);
  });

  it('glides at idle steeper than 5° at on-speed angle of attack with the gear down', () => {
    const g = idleGlide();
    expect(Math.abs(g.alpha - 13 * DEG) / DEG).toBeLessThan(0.5);
    expect(-g.gamma / DEG).toBeGreaterThan(5);
  });

  it('approaches on speed at 135–155 KIAS at landing weight', () => {
    const { m } = levelStart(150 * KNOT, H, { gear: true, speedbrake: false });
    const v = speedForAlpha(m, 13 * DEG) / KNOT;
    expect(v).toBeGreaterThan(135);
    expect(v).toBeLessThan(155);
  });
});

describe('the straight-in approach (decision 207, acceptance)', () => {
  it('from 25 km, 1,500 m and 450 KIAS: under 300 KIAS by 12 km, on speed by 5 km, lands in the zone', () => {
    const a = straightInApproach();
    expect(a.crashed).toBeNull();
    expect(a.below300At).not.toBeNull();
    expect(a.below300At!).toBeGreaterThan(12_000);
    expect(a.gearDownAt!).toBeGreaterThan(5_000);
    // The speedbrake stayed out at its gear-down limit.
    expect(a.sbWithGear * 60).toBeCloseTo(43, 3);
    // On speed and stable on the glide path from 5 km.
    const s = a.at5km!;
    expect(a.onSpeedAt!).toBeGreaterThan(5_000);
    expect(s.alpha / DEG).toBeGreaterThan(11.5);
    expect(s.alpha / DEG).toBeLessThan(14.5);
    expect(Math.abs(s.cas - s.approachSpeed) / KNOT).toBeLessThan(5);
    expect(s.alphaSpread / DEG).toBeLessThan(1.5);
    expect(s.deviationSpread).toBeLessThan(15);
    // And down in the touchdown zone, gently, to a stop.
    const td = a.touchdown!;
    expect(td).not.toBeNull();
    expect(td.inZone).toBe(true);
    expect(td.distance!).toBeGreaterThan(TOUCHDOWN_ZONE[0]);
    expect(td.distance!).toBeLessThan(TOUCHDOWN_ZONE[1]);
    expect(td.sinkRate).toBeLessThan(2);
    expect(a.phase).toBe('stopped');
  });
});
