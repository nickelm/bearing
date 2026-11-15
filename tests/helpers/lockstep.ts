/**
 * Lockstep scenarios for the Kestrel (track H, step 0): a scripted circuit, air
 * maneuvers with every control, a braked stand and taxiing, a crosswind roll
 * with gusts, a gear-up landing, a hard landing, a ditching and a hill strike.
 * Each scenario hashes the aircraft's whole state after every step (positions,
 * velocities, attitude, rates, systems, telemetry, wheels, the laws' state and
 * the monitor's events), so two models that differ in one last bit at one step
 * give different digests. `tests/flightLockstep.test.ts` compares them with a
 * fixture recorded before the airframe split.
 */
import { rng } from '../../src/core/rng';
import { KNOT } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { MIL_DETENT, neutralControls } from '../../src/sim/flight/controlLaws';
import { along, FlightDirector } from '../../src/sim/flight/flightDirector';
import type { DirectorTarget } from '../../src/sim/flight/flightDirector';
import type { FlightControls } from '../../src/sim/flight/controlLaws';
import { FLIGHT_STEP } from '../../src/sim/flight/flightModel';
import type { FlightModel, GroundQuery } from '../../src/sim/flight/flightModel';
import { FlightMonitor } from '../../src/sim/flight/outcomes';
import type { FlightEvent } from '../../src/sim/flight/outcomes';
import {
  headingVector,
  onRunway,
  runwayEnds,
  runwayFrame,
  toRunway,
} from '../../src/sim/flight/runway';
import type { Runway, RunwayEnd } from '../../src/sim/flight/runway';
import { spawnInAir, spawnOnRunway } from '../../src/sim/flight/spawn';
import { TestPilot } from '../../src/sim/flight/testPilot';
import { flatGround, kestrel, RADIUS, testRunway } from './flight';

/** What a scenario needs from the flight code, so a frozen copy can stand in for it. */
export interface LockstepLib {
  make: () => FlightModel;
  spawnOnRunway: typeof spawnOnRunway;
  spawnInAir: typeof spawnInAir;
  pilot: (r: Runway, end: RunwayEnd) => { fly: TestPilot['fly']; phase: string };
  monitor: (runways: Runway[]) => { update: FlightMonitor['update'] };
  director: () => { fly: FlightDirector['fly'] };
  along: typeof along;
}

export const LIB: LockstepLib = {
  make: kestrel,
  spawnOnRunway,
  spawnInAir,
  pilot: (r, end) => new TestPilot(r, end, RADIUS),
  monitor: (runways) => new FlightMonitor(runways, RADIUS),
  director: () => new FlightDirector(),
  along,
};

export interface Digest {
  /** Hash of every step's state, as 16 hex digits. */
  hash: string;
  steps: number;
  /** A few named quantities every 5 s, to tell where two runs part. */
  samples: number[][];
  crashed: string | null;
  events: string[];
}

const NAMES = [
  'pos.x',
  'pos.y',
  'pos.z',
  'vel.x',
  'vel.y',
  'vel.z',
  'q.w',
  'q.x',
  'q.y',
  'q.z',
  'omega.x',
  'omega.y',
  'omega.z',
  'time',
] as const;
export const SAMPLE_NAMES: readonly string[] = NAMES;

/** Every number of the aircraft's state, in a fixed order. */
function stateNumbers(m: FlightModel, out: number[]): void {
  out.length = 0;
  const v3 = (v: Readonly<Vec3d>) => out.push(v.x, v.y, v.z);
  v3(m.pos);
  v3(m.vel);
  out.push(m.q.w, m.q.x, m.q.y, m.q.z);
  v3(m.omega);
  v3(m.wind);
  out.push(m.time, m.power, m.afterburner, m.fuel, m.gear, m.speedbrake, m.mass);
  const t = m.telemetry;
  out.push(
    t.alpha,
    t.beta,
    t.tas,
    t.cas,
    t.mach,
    t.qbar,
    t.cl,
    t.cd,
    t.thrust,
    t.load,
    t.normalLoad,
    t.altitude,
    t.verticalSpeed,
    t.radarAltitude,
    t.groundSpeed,
    t.heading,
    t.pitch,
    t.bank,
    t.gamma,
    t.wow,
    t.fuelFlow,
  );
  v3(t.aero);
  v3(t.gearForce);
  v3(t.gravity);
  out.push(t.air.temperature, t.air.pressure, t.air.density, t.air.speedOfSound);
  const l = t.laws;
  out.push(
    l.mx,
    l.my,
    l.mz,
    l.elevator,
    l.aileron,
    l.rudder,
    l.steer,
    l.loadCommand,
    l.pitchRateCommand,
    l.blend,
  );
  const li = t.lawInput;
  if (li) {
    for (const k of Object.keys(li).sort()) {
      const x = (li as unknown as Record<string, unknown>)[k];
      if (typeof x === 'number') out.push(x);
    }
  }
  const s = m.lawState;
  out.push(
    s.pitchI,
    s.airborne,
    s.landed ? 1 : 0,
    s.pedalsFree,
    s.holdSettles ? 1 : 0,
    s.holdTime,
    s.holdTurned,
    s.holdDrift,
  );
  for (const w of m.wheels) {
    out.push(w.compression, w.load, w.steer);
    if (w.anchor) v3(w.anchor);
    else out.push(-1, -1, -1);
    out.push(w.surface === null ? -1 : ['runway', 'field', 'land', 'water'].indexOf(w.surface));
  }
  out.push(m.onGround ? 1 : 0, m.gearHeightNow());
}

class Hasher {
  private a = 0x811c9dc5 | 0;
  private b = 0x01000193 | 0;
  private readonly f = new Float64Array(1);
  private readonly u = new Uint32Array(this.f.buffer);

  number(x: number): void {
    this.f[0] = x;
    this.word(this.u[0]!);
    this.word(this.u[1]!);
  }

  text(s: string): void {
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
  }

  private word(w: number): void {
    this.a = Math.imul(this.a ^ w, 0x01000193);
    this.b = Math.imul(this.b ^ w, 0x5bd1e995) ^ (this.a >>> 13);
  }

  hex(): string {
    return (
      (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0')
    );
  }
}

function describeEvent(e: FlightEvent): string {
  switch (e.kind) {
    case 'touchdown':
      return `touchdown ${e.touchdown.time} ${e.touchdown.sinkRate} ${e.touchdown.grade}`;
    case 'crash':
      return `crash ${e.time} ${e.reason}`;
    default:
      return `${e.kind} ${e.time}`;
  }
}

interface Run {
  m: FlightModel;
  ground: GroundQuery;
  runways: Runway[];
  seconds: number;
  /** Sets the controls (and the wind) before step `i`; returns false to stop. */
  control: (i: number, ctl: FlightControls) => boolean | void;
}

/** Called after every step with the model, the step's index and the events it gave (preview tools). */
export type StepHook = (m: FlightModel, i: number, events: readonly FlightEvent[]) => void;

function record(lib: LockstepLib, run: Run, hook?: StepHook): Digest {
  const { m, ground } = run;
  const ctl = neutralControls();
  const mon = lib.monitor(run.runways);
  const h = new Hasher();
  const nums: number[] = [];
  const samples: number[][] = [];
  const events: string[] = [];
  const n = Math.round(run.seconds / FLIGHT_STEP);
  let i = 0;
  for (; i < n && !m.crashed; i++) {
    if (run.control(i, ctl) === false) break;
    m.step(ctl, ground);
    const stepEvents = mon.update(m, FLIGHT_STEP);
    for (const e of stepEvents) {
      const d = describeEvent(e);
      events.push(d);
      h.text(d);
    }
    hook?.(m, i, stepEvents);
    stateNumbers(m, nums);
    for (const x of nums) h.number(x);
    if (i % 600 === 0) {
      samples.push([
        m.pos.x,
        m.pos.y,
        m.pos.z,
        m.vel.x,
        m.vel.y,
        m.vel.z,
        m.q.w,
        m.q.x,
        m.q.y,
        m.q.z,
        m.omega.x,
        m.omega.y,
        m.omega.z,
        m.time,
      ]);
    }
  }
  h.text(m.crashed ?? 'flying');
  return { hash: h.hex(), steps: i, samples, crashed: m.crashed, events };
}

/**
 * Rolling ground off the runway with water beyond 6 km past its center along
 * its axis, and, with `hill`, a 600 m hill 4 km out on the extended centerline.
 */
function mixedGround(r: Runway, hill = false): GroundQuery {
  const frame = runwayFrame(r);
  const local = (d: Readonly<Vec3d>) =>
    toRunway(r, frame, d.clone().scale(RADIUS + r.elevation), RADIUS);
  return {
    height: (d) => {
      const c = local(d);
      const dx = c.along - 4000;
      const dy = c.across;
      const bump = hill ? 600 * Math.exp(-(dx * dx + dy * dy) / (2 * 1500 * 1500)) : 0;
      const roll = 4 * Math.sin(c.along / 37) * Math.cos(c.across / 53);
      return c.along > 6000 ? 0 : r.elevation + bump + (onRunway(r, c.along, c.across) ? 0 : roll);
    },
    surface: (d) => {
      const c = local(d);
      if (c.along > 6000) return 'water';
      return onRunway(r, c.along, c.across) ? 'runway' : 'field';
    },
  };
}

/** A steady wind with a gust that varies in position and time (no random numbers). */
function gustyWind(m: FlightModel, base: Readonly<Vec3d>, t: number): void {
  const p = m.pos;
  m.wind
    .copy(base)
    .add(
      new Vec3d(
        1.5 * Math.sin(p.x / 97 + t * 0.7),
        1.5 * Math.cos(p.y / 113 - t * 0.5),
        1.5 * Math.sin(p.z / 89 + t * 1.1),
      ),
    );
}

export type ScenarioName =
  | 'circuit'
  | 'maneuvers'
  | 'stand-and-taxi'
  | 'crosswind-roll'
  | 'gear-up'
  | 'hard-landing'
  | 'ditching'
  | 'hill'
  | 'respawn'
  | 'tail-slide'
  | 'mouse-aim'
  | 'free-pedal-roll'
  | 'belly-ditching'
  | 'excursion'
  | 'stand-gale';

export const SCENARIOS: readonly ScenarioName[] = [
  'circuit',
  'maneuvers',
  'stand-and-taxi',
  'crosswind-roll',
  'gear-up',
  'hard-landing',
  'ditching',
  'hill',
  'respawn',
  'tail-slide',
  'mouse-aim',
  'free-pedal-roll',
  'belly-ditching',
  'excursion',
  'stand-gale',
];

export function runScenario(name: ScenarioName, lib: LockstepLib = LIB, hook?: StepHook): Digest {
  const runway = testRunway();
  const [end, other] = runwayEnds(runway);
  const flat = flatGround(runway);
  const m = lib.make();
  switch (name) {
    case 'circuit': {
      lib.spawnOnRunway(m, runway, end);
      const pilot = lib.pilot(runway, end);
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 900,
          control: (_i, ctl) => {
            if (pilot.phase === 'stopped') return false;
            pilot.fly(m, ctl, FLIGHT_STEP);
          },
        },
        hook,
      );
    }
    case 'maneuvers': {
      lib.spawnInAir(m, runway, end, 7000, 300 * KNOT);
      const r = rng(7, 'lockstep-maneuvers');
      return record(
        lib,
        {
          m,
          ground: mixedGround(runway),
          runways: [runway],
          seconds: 150,
          control: (i, ctl) => {
            const t = i * FLIGHT_STEP;
            if (i % 30 === 0) {
              ctl.pitch = r.range(-1, 1);
              ctl.roll = r.range(-1, 1);
              ctl.yaw = r.range(-1, 1);
            }
            if (i % 240 === 0) {
              ctl.throttle = t < 40 ? 1 : r.range(0, 1);
              ctl.speedbrake = r.range(0, 1) > 0.6;
              ctl.gearDown = t > 60 && t < 75;
            }
            // Keep it high: wings level and pull when low or diving.
            if (m.telemetry.radarAltitude < 3500 || m.telemetry.gamma < -0.6) {
              ctl.roll =
                -0.8 * Math.sign(m.telemetry.bank) * Math.min(1, Math.abs(m.telemetry.bank));
              ctl.pitch = Math.abs(m.telemetry.bank) < 1.2 ? 0.7 : 0;
            }
          },
        },
        hook,
      );
    }
    case 'stand-and-taxi': {
      lib.spawnOnRunway(m, runway, end);
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 90,
          control: (i, ctl) => {
            const t = i * FLIGHT_STEP;
            ctl.parkingBrake = t < 30;
            ctl.throttle = t < 5 ? MIL_DETENT : t < 30 ? 0 : t < 48 ? 0.2 : 0;
            ctl.yaw = t > 38 && t < 40 ? 0.15 : t > 43 && t < 45 ? -0.15 : 0;
            ctl.brakeLeft = t > 52 && t < 60 ? 0.6 : 0;
            ctl.brakeRight = t > 56 ? 1 : 0;
          },
        },
        hook,
      );
    }
    case 'crosswind-roll': {
      lib.spawnOnRunway(m, runway, end);
      const up = m.pos.clone().normalize();
      const cross = headingVector(up, end.heading + Math.PI / 2).scale(7);
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 45,
          control: (i, ctl) => {
            const t = i * FLIGHT_STEP;
            gustyWind(m, cross, t);
            ctl.throttle = 1;
            ctl.yaw = t > 8 && t < 8.5 ? 0.3 : 0;
            ctl.pitch = m.telemetry.cas > 150 * KNOT ? 0.6 : 0;
            ctl.gearDown = t < 30;
          },
        },
        hook,
      );
    }
    case 'gear-up': {
      lib.spawnInAir(m, runway, end, 150, 200 * KNOT);
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 60,
          control: (_i, ctl) => {
            ctl.gearDown = false;
            ctl.throttle = 0;
            ctl.pitch = m.telemetry.gamma > -3 * (Math.PI / 180) ? -0.2 : 0.05;
          },
        },
        hook,
      );
    }
    case 'hard-landing': {
      lib.spawnInAir(m, runway, other, 60, 170 * KNOT);
      m.gear = 1;
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 40,
          control: (_i, ctl) => {
            ctl.gearDown = true;
            ctl.throttle = 0;
            ctl.pitch = m.telemetry.verticalSpeed > -7 ? -0.35 : 0;
          },
        },
        hook,
      );
    }
    case 'ditching': {
      lib.spawnInAir(m, runway, end, 400, 250 * KNOT);
      return record(
        lib,
        {
          m,
          ground: mixedGround(runway),
          runways: [runway],
          seconds: 120,
          control: (i, ctl) => {
            ctl.throttle = 0.5;
            ctl.gearDown = i * FLIGHT_STEP > 20;
            ctl.pitch = m.telemetry.gamma > -2 * (Math.PI / 180) ? -0.15 : 0.02;
          },
        },
        hook,
      );
    }
    case 'hill': {
      lib.spawnInAir(m, runway, end, 300, 280 * KNOT);
      return record(
        lib,
        {
          m,
          ground: mixedGround(runway, true),
          runways: [runway],
          seconds: 120,
          control: (_i, ctl) => {
            // Straight and level into the hill on the extended centerline.
            ctl.throttle = 0.7;
            ctl.gearDown = false;
            ctl.roll = -0.5 * m.telemetry.bank;
            ctl.pitch = m.telemetry.verticalSpeed < 0 ? 0.1 : 0;
          },
        },
        hook,
      );
    }
    case 'respawn': {
      // A used model: rolled in a gusty crosswind, crashed, placed on the other end, flown again.
      lib.spawnOnRunway(m, runway, end);
      const up = m.pos.clone().normalize();
      const cross = headingVector(up, end.heading + Math.PI / 2).scale(7);
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 30,
          control: (i, ctl) => {
            const t = i * FLIGHT_STEP;
            if (i === 1200) {
              m.crash('respawn');
              lib.spawnOnRunway(m, runway, other);
            }
            gustyWind(m, cross, t);
            ctl.parkingBrake = t > 10 && t < 12;
            ctl.throttle = t < 10 ? 1 : t < 12 ? 0 : MIL_DETENT;
            ctl.yaw = t > 4 && t < 4.6 ? 0.2 : 0;
          },
        },
        hook,
      );
    }
    case 'tail-slide': {
      // Straight up at 120 m/s at idle with the stick let go (as in flightWind.test.ts).
      lib.spawnInAir(m, runway, end, 6000, 250 * KNOT);
      const up = m.pos.clone().normalize();
      const pitch = 88 * (Math.PI / 180);
      const nose = headingVector(up, end.heading)
        .scale(Math.cos(pitch))
        .addScaled(up, Math.sin(pitch));
      m.place(m.pos.clone(), nose.scale(120), end.heading, pitch);
      m.lawState.airborne = 30;
      m.gear = 0;
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 40,
          control: (_i, ctl) => {
            ctl.gearDown = false;
            ctl.throttle = 0;
          },
        },
        hook,
      );
    }
    case 'mouse-aim': {
      // The flight director toward directions that change every 4 s, as mouse aim drives it.
      lib.spawnInAir(m, runway, end, 4000, 350 * KNOT);
      const director = lib.director();
      const r = rng(11, 'lockstep-mouse-aim');
      const dir = new Vec3d();
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 90,
          control: (i, ctl) => {
            if (i % 480 === 0) {
              const up = m.pos.clone().normalize();
              const course = r.range(0, 2 * Math.PI);
              const climb = r.range(-0.3, 0.3);
              dir
                .copy(headingVector(up, course))
                .scale(Math.cos(climb))
                .addScaled(up, Math.sin(climb));
              ctl.throttle = r.range(0.4, 1);
            }
            const a = lib.along(m, dir);
            const target: DirectorTarget = {
              course: a.course,
              gamma: a.gamma,
              speed: null,
              maxBank: 80 * (Math.PI / 180),
              maxTurnRate: 20 * (Math.PI / 180),
              maxLoadDelta: 4,
            };
            director.fly(m, target, ctl, FLIGHT_STEP);
            ctl.gearDown = false;
          },
        },
        hook,
      );
    }
    case 'free-pedal-roll': {
      // A takeoff roll in a gusty crosswind with the pedals never touched: the track hold steers.
      lib.spawnOnRunway(m, runway, end);
      const up = m.pos.clone().normalize();
      const cross = headingVector(up, end.heading - Math.PI / 2).scale(6);
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 25,
          control: (i, ctl) => {
            gustyWind(m, cross, i * FLIGHT_STEP);
            ctl.throttle = 0.6;
          },
        },
        hook,
      );
    }
    case 'belly-ditching': {
      // Gear up, gliding into the water: a hard point, not a wheel, finds it.
      lib.spawnInAir(m, runway, end, 250, 220 * KNOT);
      return record(
        lib,
        {
          m,
          ground: mixedGround(runway),
          runways: [runway],
          seconds: 120,
          control: (_i, ctl) => {
            ctl.gearDown = false;
            ctl.throttle = 0.45;
            ctl.pitch = m.telemetry.gamma > -1.5 * (Math.PI / 180) ? -0.12 : 0.03;
          },
        },
        hook,
      );
    }
    case 'excursion': {
      // Full power with a pedal held in a crosswind: off the side of the runway at speed.
      lib.spawnOnRunway(m, runway, end);
      const up = m.pos.clone().normalize();
      const cross = headingVector(up, end.heading + Math.PI / 2).scale(8);
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 40,
          control: (i, ctl) => {
            const t = i * FLIGHT_STEP;
            gustyWind(m, cross, t);
            ctl.throttle = MIL_DETENT;
            ctl.yaw = t > 6 ? 0.5 : 0;
          },
        },
        hook,
      );
    }
    case 'stand-gale': {
      // Parked with the brake set at military power, then in a side gale that rises past its grip.
      lib.spawnOnRunway(m, runway, end);
      const up = m.pos.clone().normalize();
      const side = headingVector(up, end.heading + Math.PI / 2);
      return record(
        lib,
        {
          m,
          ground: flat,
          runways: [runway],
          seconds: 40,
          control: (i, ctl) => {
            const t = i * FLIGHT_STEP;
            ctl.parkingBrake = true;
            ctl.throttle = t < 10 ? MIL_DETENT : 0;
            m.wind.copy(side).scale(t < 10 ? 0 : Math.min(60, 15 + 2 * (t - 10)));
          },
        },
        hook,
      );
    }
  }
}
