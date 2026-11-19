/**
 * The helicopters' flight model and control layer (track H1, Proposal 0004,
 * Verification): the spec, the thrust disc's physics against published
 * figures, and maneuvers flown through the Assisted preset as a pilot would.
 */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { DEG, KNOT } from '../src/core/units';
import { FlightSpecError } from '../src/sim/flight/flightSpec';
import { FlightMonitor } from '../src/sim/flight/outcomes';
import { FLIGHT_STEP } from '../src/sim/flight/rigidBody';
import { runwayEnds, runwayFrame, runwayPoint } from '../src/sim/flight/runway';
import { assistsFor, PRESETS } from '../src/sim/flight/rotor/assists';
import { HeloLaws, invertMonotone, neutralCommand } from '../src/sim/flight/rotor/heloLaws';
import type { HeloCommand } from '../src/sim/flight/rotor/heloLaws';
import { groundEffect } from '../src/sim/flight/rotor/rotorAero';
import { neutralRotorControls } from '../src/sim/flight/rotor/rotorcraftModel';
import type { RotorcraftModel } from '../src/sim/flight/rotor/rotorcraftModel';
import { parseRotorcraftSpec, solidity } from '../src/sim/flight/rotor/rotorSpec';
import { sinkWarning } from '../src/ui/flight/hud';
import scoutJson from '../src/data/models/aircraft/alliance-scout-helo.json';
import { flatGround, RADIUS, testRunway } from './helpers/flight';
import { scout, scoutSpec, utility, utilitySpec } from './helpers/rotor';

const runway = testRunway();
const ground = flatGround(runway);
const end = runwayEnds(runway)[0];
const frame = runwayFrame(runway);

/** On the ground 100 m beside the runway's middle, or `height` m above it. */
function spawn(m: RotorcraftModel, height: number | null): void {
  const h = height ?? m.gearHeight - 0.02;
  m.place(runwayPoint(runway, frame, 0, 100, h, RADIUS), new Vec3d(), end.heading, 0);
  m.updateAttitude(ground);
}

/** A control layer reset for `m`, standing on its gear when it was spawned there. */
function lawsFor(m: RotorcraftModel, grounded: boolean): HeloLaws {
  const laws = new HeloLaws();
  laws.reset(m, grounded);
  return laws;
}

/** Flies `seconds` with `script` setting the command before each step. */
function fly(
  m: RotorcraftModel,
  laws: HeloLaws,
  seconds: number,
  script: (t: number, cmd: HeloCommand) => void,
  each?: (t: number) => void,
  monitor?: FlightMonitor,
): string[] {
  const a = assistsFor('assisted');
  const cmd = neutralCommand();
  const ctl = neutralRotorControls();
  const events: string[] = [];
  for (let i = 0; i < seconds / FLIGHT_STEP && !m.crashed; i++) {
    const t = i * FLIGHT_STEP;
    Object.assign(cmd, neutralCommand());
    script(t, cmd);
    laws.update(m, cmd, a, FLIGHT_STEP, ctl);
    m.step(ctl, ground);
    if (monitor) for (const e of monitor.update(m, FLIGHT_STEP)) events.push(e.kind);
    each?.(t);
  }
  return events;
}

describe('rotorcraft spec', () => {
  it('parses both H1 types into SI', () => {
    const s = scoutSpec();
    expect(s.main.radius).toBeCloseTo(4.02, 6);
    expect(s.main.shaftTilt).toBeCloseTo(4 * DEG, 12);
    expect(solidity(s.main)).toBeCloseTo(0.068, 3);
    const u = utilitySpec();
    expect(solidity(u.main)).toBeCloseTo(0.082, 3);
    expect(u.gear.kind).toBe('wheels');
    expect(u.tail.axis[1]).toBeCloseTo(Math.sin(20 * DEG), 2);
  });

  it('rejects a broken block with a path', () => {
    const raw = structuredClone((scoutJson as { flight: Record<string, unknown> }).flight);
    (raw.main as Record<string, unknown>).hub = 'flexible';
    expect(() => parseRotorcraftSpec(raw, 'x')).toThrow(FlightSpecError);
    expect(() => parseRotorcraftSpec(raw, 'x')).toThrow(/main\.hub/);
    const t = structuredClone((scoutJson as { flight: Record<string, unknown> }).flight);
    (t.main as Record<string, unknown>).hub = 'teetering';
    expect(() => parseRotorcraftSpec(t, 'x')).toThrow(/hubStiffness/);
  });
});

describe('thrust disc', () => {
  it('needs hover power near the published figures, out of ground effect', () => {
    // Scout: about 190 kW at 1,300 kg (momentum theory with a figure of merit of 0.65 and
    // the tail rotor); utility: 1.4–1.6 MW at 7.3 t (NASA and Army figures).
    for (const [make, lo, hi] of [
      [scout, 170e3, 240e3],
      [utility, 1.25e6, 1.6e6],
    ] as const) {
      const m = make();
      spawn(m, 300);
      const laws = lawsFor(m, false);
      let p = 0;
      fly(
        m,
        laws,
        40,
        () => {},
        (t) => {
          if (t > 30) p = m.telemetry.powerRequired;
        },
      );
      expect(m.telemetry.groundSpeed).toBeLessThan(1.5);
      expect(p).toBeGreaterThan(lo);
      expect(p).toBeLessThan(hi);
    }
  });

  it('gains translational lift between 15 and 25 kt', () => {
    // The real model at the hover's collective, held in place while the air moves past it:
    // the induced inflow per unit of thrust has fallen by under a tenth at 10 kt and by over
    // a fifth at 25 kt (momentum theory: about 0.7 there), and the thrust has risen.
    for (const make of [scout, utility]) {
      const m = make();
      spawn(m, 300);
      const laws = lawsFor(m, false);
      fly(m, laws, 15, () => {});
      const collective = laws.collective;
      const p0 = m.pos.clone();
      const q0 = m.q.clone();
      const fwd = m.bodyAxis(0);
      const at = (knots: number) => {
        const ctl = neutralRotorControls();
        ctl.collective = collective;
        for (let i = 0; i < 6 / FLIGHT_STEP; i++) {
          m.pos.copy(p0);
          m.vel.set(0, 0, 0);
          m.q.copy(q0);
          m.omega.set(0, 0, 0);
          m.wind.copy(fwd).scale(-knots * KNOT);
          m.step(ctl, ground);
        }
        return { inflow: m.inflow, thrust: m.telemetry.thrust };
      };
      const h = at(0);
      const ten = at(10);
      const etl = at(25);
      // Per unit of thrust, since the thrust rises with the moving air at a fixed collective.
      const per = (x: { inflow: number; thrust: number }) => x.inflow / x.thrust;
      expect(per(ten) / per(h)).toBeGreaterThan(0.85);
      expect(per(etl) / per(h)).toBeLessThan(0.8);
      expect(etl.thrust).toBeGreaterThan(1.05 * h.thrust);
    }
  });

  it('cushions the hover in ground effect', () => {
    expect(groundEffect(5, 2.5, 0, 0.05)).toBeCloseTo(1 - (5 / 10) ** 2, 9);
    expect(groundEffect(5, 50, 0, 0.05)).toBeGreaterThan(0.995);
    // Swept away with speed.
    expect(groundEffect(5, 2.5, 0.3, 0.05)).toBeGreaterThan(0.98);
    // A low hover needs less power than a high one.
    // Skids 0.3 m up (the hub at about three quarters of a radius) against 80 m.
    const power = (height: number) => {
      const m = scout();
      spawn(m, height);
      const laws = lawsFor(m, false);
      let p = 0;
      fly(
        m,
        laws,
        30,
        () => {},
        (t) => {
          if (t > 25) p = m.telemetry.powerRequired;
        },
      );
      expect(m.crashed).toBeNull();
      expect(m.onGround).toBe(false);
      return p;
    };
    expect(power(scout().gearHeight + 0.3)).toBeLessThan(0.93 * power(80));
  });

  it('gives identical states for identical inputs', () => {
    const run = () => {
      const m = utility();
      spawn(m, null);
      const laws = lawsFor(m, true);
      fly(m, laws, 25, (t, c) => {
        c.collective = t > 1 && t < 6 ? 1 : 0;
        c.mousePitch = t > 8 && t < 9 ? -0.2 * FLIGHT_STEP : 0;
        c.mouseTurn = t > 12 && t < 13 ? 0.3 * FLIGHT_STEP : 0;
        c.pedals = t > 16 && t < 17 ? 0.5 : 0;
      });
      return [m.pos.x, m.pos.y, m.pos.z, m.vel.x, m.q.w, m.q.y, m.omega.z, m.rotorOmega, m.time];
    };
    expect(run()).toEqual(run());
  });

  it('inverts a monotone function by bisection', () => {
    expect(invertMonotone((x) => x * x, 0.25, 0, 1)).toBeCloseTo(0.5, 6);
    expect(invertMonotone((x) => -x, -0.3, 0, 1)).toBeCloseTo(0.3, 6);
    expect(invertMonotone((x) => x, 2, 0, 1)).toBe(1);
  });
});

describe('flown through the Assisted preset', () => {
  it('rests on its skids and its wheels without creeping', () => {
    for (const make of [scout, utility]) {
      const m = make();
      spawn(m, null);
      const laws = lawsFor(m, true);
      fly(m, laws, 5, (_t, c) => (c.parkingBrake = true));
      const p0 = m.pos.clone();
      fly(m, laws, 30, (_t, c) => (c.parkingBrake = true));
      expect(m.onGround).toBe(true);
      expect(m.pos.distanceTo(p0)).toBeLessThan(0.01);
      expect(m.crashed).toBeNull();
    }
  });

  it('holds a hover in ground effect for 60 s within a meter', () => {
    for (const make of [scout, utility]) {
      const m = make();
      spawn(m, 3);
      const laws = lawsFor(m, false);
      fly(m, laws, 20, (t, c) => (c.toggleHover = t === 0));
      expect(laws.hoverHold).toBe(true);
      const p0 = m.pos.clone();
      let worst = 0;
      fly(
        m,
        laws,
        60,
        () => {},
        () => (worst = Math.max(worst, m.pos.distanceTo(p0))),
      );
      expect(worst).toBeLessThan(1);
    }
  });

  it('turns a full circle on the pedals in the hover within the type time', () => {
    for (const [make, most] of [
      [scout, 9],
      [utility, 13],
    ] as const) {
      const m = make();
      spawn(m, 20);
      const laws = lawsFor(m, false);
      fly(m, laws, 10, () => {});
      let turned = 0;
      let last = m.telemetry.heading;
      let t360 = Infinity;
      fly(
        m,
        laws,
        25,
        (_t, c) => (c.pedals = turned < 2 * Math.PI ? 1 : 0),
        (t) => {
          const h = m.telemetry.heading;
          turned += Math.atan2(Math.sin(h - last), Math.cos(h - last));
          last = h;
          if (turned >= 2 * Math.PI && t360 === Infinity) t360 = t;
        },
      );
      expect(t360).toBeLessThan(most);
      expect(m.crashed).toBeNull();
    }
  });

  it('takes off, flies a short circuit and lands softly', () => {
    for (const make of [scout, utility]) {
      const m = make();
      spawn(m, null);
      const laws = lawsFor(m, true);
      const monitor = new FlightMonitor([runway], RADIUS);
      let leveled = false;
      const events = fly(
        m,
        laws,
        180,
        (t, c) => {
          const ra = m.telemetry.radarAltitude;
          // Up to 30 m, nose down to about 60 kt, a turn, back, slow to a hover, down.
          // Down once slow (the Assisted preset eases to a hover below 20 kt).
          c.collective = t < 12 && ra < 30 ? 1 : t > 90 && m.telemetry.groundSpeed < 4 ? -1 : 0;
          if (t > 12 && t < 13) c.mousePitch = -10 * DEG * FLIGHT_STEP;
          if (t > 30 && t < 31) c.mouseTurn = 25 * DEG * FLIGHT_STEP;
          if (t > 42 && t < 43) c.mouseTurn = -25 * DEG * FLIGHT_STEP;
          if (t > 55 && t < 56) c.mousePitch = 18 * DEG * FLIGHT_STEP;
          // Level the nose once slow, as a pilot does: the hover then settles by itself.
          if (t > 56 && !leveled && m.telemetry.groundSpeed < 8) {
            leveled = true;
            c.mousePitch = m.spec.main.shaftTilt - laws.pitchTarget;
          }
        },
        undefined,
        monitor,
      );
      expect(m.crashed).toBeNull();
      expect(events).toContain('liftoff');
      expect(events).toContain('touchdown');
      expect(monitor.lastTouchdown!.sinkRate).toBeLessThan(1.5);
      expect(m.onGround).toBe(true);
    }
  }, 60_000);

  /** Hover at `height` m, then fly at `pitch` (rad of mouse) until `knots`. */
  function cruise(
    make: () => RotorcraftModel,
    knots: number,
  ): { m: RotorcraftModel; laws: HeloLaws } {
    const m = make();
    spawn(m, 150);
    const laws = lawsFor(m, false);
    let pushed = false;
    fly(m, laws, 120, (_t, c) => {
      if (!pushed) {
        c.mousePitch = -8 * DEG;
        pushed = true;
      }
      // Ease back to hold the speed once reached.
      const kt = m.telemetry.groundSpeed / KNOT;
      if (kt > knots && laws.pitchTarget < 0) c.mousePitch = 0.2 * DEG * FLIGHT_STEP * 60;
    });
    return { m, laws };
  }

  it('holds a 45° turn at cruise without running away (review of decision 159)', () => {
    for (const make of [scout, utility]) {
      const { m, laws } = cruise(make, 90);
      expect(m.telemetry.groundSpeed / KNOT).toBeGreaterThan(70);
      const alt = m.telemetry.altitude;
      let worstBank = 0;
      let lost = 0;
      fly(
        m,
        laws,
        25,
        (t, c) => (c.mouseTurn = t < 1 ? 45 * DEG * FLIGHT_STEP : 0),
        (t) => {
          if (t > 4) worstBank = Math.max(worstBank, Math.abs(m.telemetry.bank / DEG - 45));
          lost = Math.max(lost, alt - m.telemetry.altitude);
        },
      );
      expect(m.crashed).toBeNull();
      expect(worstBank).toBeLessThan(6);
      expect(lost).toBeLessThan(12);
    }
  }, 60_000);

  it('flies straight at cruise with the controls let go', () => {
    for (const make of [scout, utility]) {
      const { m, laws } = cruise(make, 90);
      const h0 = m.telemetry.heading;
      fly(m, laws, 120, () => {});
      const turned = Math.atan2(
        Math.sin(m.telemetry.heading - h0),
        Math.cos(m.telemetry.heading - h0),
      );
      expect(Math.abs(turned / DEG)).toBeLessThan(3);
    }
  }, 60_000);

  it('flies backward at 20 kt without swapping its tail', () => {
    for (const make of [scout, utility]) {
      const m = make();
      spawn(m, 60);
      const laws = lawsFor(m, false);
      const h0 = m.telemetry.heading;
      let worst = 0;
      fly(
        m,
        laws,
        40,
        (t, c) => (c.mousePitch = t < 1 ? 12 * DEG * FLIGHT_STEP : 0),
        () => {
          const d = Math.atan2(
            Math.sin(m.telemetry.heading - h0),
            Math.cos(m.telemetry.heading - h0),
          );
          worst = Math.max(worst, Math.abs(d / DEG));
        },
      );
      expect(m.crashed).toBeNull();
      expect(worst).toBeLessThan(20);
    }
  }, 60_000);

  it('starts hovering in the air without a sag or a drooping rotor', () => {
    for (const make of [scout, utility]) {
      const m = make();
      spawn(m, 150);
      const laws = lawsFor(m, false);
      const h0 = m.telemetry.radarAltitude;
      let lowest = h0;
      let rpm = 1;
      fly(
        m,
        laws,
        10,
        () => {},
        () => {
          lowest = Math.min(lowest, m.telemetry.radarAltitude);
          rpm = Math.min(rpm, m.telemetry.rotorSpeed);
        },
      );
      expect(h0 - lowest).toBeLessThan(1);
      expect(rpm).toBeGreaterThan(0.97);
    }
  });

  it('keeps the rotor out of overspeed in a quick stop, with the collective in its range', () => {
    for (const make of [scout, utility]) {
      const { m, laws } = cruise(make, 90);
      let rpm = 0;
      let lo = 1;
      let hi = 0;
      fly(
        m,
        laws,
        20,
        (t, c) => (c.mousePitch = t < 1 ? 25 * DEG * FLIGHT_STEP : 0),
        () => {
          rpm = Math.max(rpm, m.telemetry.rotorSpeed);
          lo = Math.min(lo, laws.collective);
          hi = Math.max(hi, laws.collective);
        },
      );
      expect(rpm).toBeLessThan(1.12);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  it('keeps the presets in their places', () => {
    expect(PRESETS.assisted.collective).toBe('climb-rate');
    expect(PRESETS.standard.autoHoverHold).toBe(false);
    expect(PRESETS.expert.protection).toBe('off');
    expect(PRESETS.expert.maxBank).toBeNull();
  });
});

describe('the HUD sink warning against the flown descent (decision 160)', () => {
  /** Holds S from a hover at `h0` m until the gear touches; seconds of warning and the touchdown sink. */
  function descend(make: () => RotorcraftModel, landingAid: boolean, h0: number) {
    const m = make();
    spawn(m, h0);
    const laws = lawsFor(m, false);
    const a = { ...assistsFor('assisted'), landingAid };
    const cmd = neutralCommand();
    const ctl = neutralRotorControls();
    let warned = 0;
    let touchdown = 0;
    for (let i = 0; i < 90 / FLIGHT_STEP; i++) {
      Object.assign(cmd, neutralCommand());
      if (i * FLIGHT_STEP > 3) cmd.collective = -1;
      laws.update(m, cmd, a, FLIGHT_STEP, ctl);
      m.step(ctl, ground);
      if (m.onGround) {
        touchdown = -m.telemetry.verticalSpeed;
        break;
      }
      if (sinkWarning(m.telemetry.verticalSpeed, m.telemetry.radarAltitude)) warned += FLIGHT_STEP;
    }
    return { warned, touchdown };
  }

  it('stays quiet through the landing aid and warns well before a hard landing without it', () => {
    for (const make of [scout, utility])
      for (const h0 of [20, 80, 150]) {
        const eased = descend(make, true, h0);
        expect(eased.warned, `aid, ${h0} m`).toBe(0);
        expect(eased.touchdown).toBeLessThan(1);
        const hard = descend(make, false, h0);
        expect(hard.touchdown, `no aid, ${h0} m`).toBeGreaterThan(5);
        expect(hard.warned, `no aid, ${h0} m`).toBeGreaterThan(1);
      }
  });
});
