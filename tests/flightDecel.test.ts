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
import { approachEnergy, approachSpeed, distanceToSlow } from '../src/sim/flight/energy';
import { aoaBracket, buildHudFrame } from '../src/ui/flight/hudFrame';
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

describe('the straight-in approach at Free Flight weight (decision 207)', () => {
  it('makes the same gates at 13.3 t, with full fuel as unlimited fuel keeps it', () => {
    const a = straightInApproach(3200);
    expect(a.crashed).toBeNull();
    expect(a.below300At!).toBeGreaterThan(12_000);
    const s = a.at5km!;
    expect(s.alpha / DEG).toBeGreaterThan(11.5);
    expect(s.alpha / DEG).toBeLessThan(14.5);
    expect(Math.abs(s.cas - s.approachSpeed) / KNOT).toBeLessThan(5);
    expect(s.deviationSpread).toBeLessThan(15);
    const td = a.touchdown!;
    expect(td.inZone).toBe(true);
    expect(td.sinkRate).toBeLessThan(2);
    expect(a.phase).toBe('stopped');
  });
});

describe('approach cues (decision 207)', () => {
  it('puts the approach bug at the speed of 13° in the landing configuration at this weight', () => {
    const { m } = levelStart(150 * KNOT, H, { gear: true, speedbrake: false });
    expect(approachSpeed(m.spec, m.mass)).toBeCloseTo(speedForAlpha(m, 13 * DEG), 9);
    // Heavier is faster: by the square root of the weight.
    const ratio = approachSpeed(m.spec, 1.2 * m.mass) / approachSpeed(m.spec, m.mass);
    expect(ratio).toBeCloseTo(Math.sqrt(1.2), 9);
  });

  it("predicts the distance to slow within 10% of the model's own deceleration", () => {
    // 300 → 170 KIAS level at idle with gear down and the speedbrake at 43°: the cue's own
    // procedure below the gear limit, flown.
    const { m, ctl } = levelStart(300 * KNOT, H, { gear: true, speedbrake: true });
    const fd = new FlightDirector();
    const start = m.pos.clone();
    while (m.telemetry.cas > 170 * KNOT || m.telemetry.cas === 0) levelStep(m, ctl, fd, H);
    const flown = m.pos.distanceTo(start);
    const predicted = distanceToSlow(m.spec, m.mass, H, 300 * KNOT, 170 * KNOT);
    expect(Math.abs(predicted / flown - 1)).toBeLessThan(0.1);
  });

  it('reads green far out, then amber, then red as the runway nears at 400 KIAS', () => {
    const { m } = levelStart(400 * KNOT, H, { gear: false, speedbrake: false });
    const states: string[] = [];
    for (let toAim = 50_000; toAim >= 6000; toAim -= 250) {
      const e = approachEnergy(m.spec, m.mass, 0, 400 * KNOT, toAim, 1000);
      if (states[states.length - 1] !== e.state) states.push(e.state);
    }
    expect(states).toEqual(['ok', 'marginal', 'short']);
    // Already on speed: nothing to slow.
    const v = approachSpeed(m.spec, m.mass);
    expect(approachEnergy(m.spec, m.mass, 0, v, 8000, 400).state).toBe('ok');
  });

  it("predicts the straight-in approach's slowing within a fifth, and reads it as making the gate", () => {
    const { m } = levelStart(450 * KNOT, 1500, { gear: false, speedbrake: false });
    // The acceptance test's start: 25 km before the threshold, 1,500 m up, 450 KIAS.
    const e = approachEnergy(m.spec, m.mass, 120, 450 * KNOT, 25_300, 1500);
    expect(e.state).not.toBe('short');
    const flown = straightInApproach();
    const slowed = 25_000 - flown.onSpeedAt!;
    expect(Math.abs(e.needed / slowed - 1)).toBeLessThan(0.2);
  });

  it('draws the trend 10 s ahead from the filtered rate of the airspeed', () => {
    const { m, ctl } = levelStart(350 * KNOT, H, { gear: false, speedbrake: true });
    const fd = new FlightDirector();
    for (let i = 0; i < 4 / FLIGHT_STEP; i++) levelStep(m, ctl, fd, H);
    const cas0 = m.telemetry.cas;
    const rate = m.telemetry.casRate;
    expect(rate).toBeLessThan(-2 * KNOT);
    for (let i = 0; i < 1 / FLIGHT_STEP; i++) levelStep(m, ctl, fd, H);
    // The rate is the airspeed's slope (within 10% over a second of steady deceleration).
    expect((m.telemetry.cas - cas0) / rate).toBeGreaterThan(0.9);
    expect((m.telemetry.cas - cas0) / rate).toBeLessThan(1.1);
    const frame = buildHudFrame(m, ctl, { aid: null, mode: 'direct', control: null, timing: null });
    const q = frame.speedCues!;
    expect(q.gearLimit / KNOT).toBeCloseTo(300, 0);
    expect(q.approach).toBeCloseTo(approachSpeed(m.spec, m.mass), 9);
    expect(q.trend).toBeCloseTo(m.telemetry.cas + 10 * m.telemetry.casRate, 9);
    expect(q.trend).toBeLessThan(m.telemetry.cas - 20 * KNOT);
    expect(frame.speedbrakeAngle! / DEG).toBeCloseTo(60, 6);
  });
});

describe('the angle-of-attack bracket (decision 208)', () => {
  const angle = (a: readonly number[], b: readonly number[]) =>
    Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));

  it('puts the flight path marker in the bracket on the final, near its center', () => {
    const seen: number[] = [];
    straightInApproach(undefined, undefined, undefined, undefined, (m, ctl, before) => {
      if (before > 5000 || before < 2000) return;
      const b = aoaBracket(m, ctl.gearDown)!;
      const v = m.vel.clone().normalize();
      const fpm = [v.x, v.y, v.z];
      // The bracket spans 4°, the marker inside it, as far from its center as α is from 13°.
      expect(angle(b.top, b.bottom) / DEG).toBeCloseTo(4, 6);
      expect(angle(b.center, fpm) / DEG).toBeCloseTo(Math.abs(m.telemetry.alpha / DEG - 13), 6);
      expect(angle(b.top, fpm) + angle(fpm, b.bottom)).toBeCloseTo(angle(b.top, b.bottom), 6);
      seen.push(angle(b.center, fpm) / DEG);
    });
    expect(seen.length).toBeGreaterThan(100);
    expect(Math.max(...seen)).toBeLessThan(1);
  });

  it('sits above the marker when slow and below it when fast, and only with the gear down', () => {
    const slow = levelStart(140 * KNOT, H, { gear: true, speedbrake: false });
    const fd = new FlightDirector();
    for (let i = 0; i < 3 / FLIGHT_STEP; i++) levelStep(slow.m, slow.ctl, fd, H);
    const up = slow.m.pos.clone().normalize();
    const v = slow.m.vel.clone().normalize();
    const height = (d: readonly number[]) => d[0]! * up.x + d[1]! * up.y + d[2]! * up.z;
    const b = aoaBracket(slow.m, true)!;
    expect(slow.m.telemetry.alpha / DEG).toBeGreaterThan(14);
    // Slow: the marker sinks toward the bracket's bottom; the center is above it.
    expect(height(b.center)).toBeGreaterThan(height([v.x, v.y, v.z]));
    const fast = levelStart(200 * KNOT, H, { gear: true, speedbrake: false });
    for (let i = 0; i < 3 / FLIGHT_STEP; i++) levelStep(fast.m, fast.ctl, fd, H);
    const vf = fast.m.vel.clone().normalize();
    const bf = aoaBracket(fast.m, true)!;
    expect(height(bf.center)).toBeLessThan(height([vf.x, vf.y, vf.z]));
    expect(aoaBracket(fast.m, false)).toBeNull();
  });
});
