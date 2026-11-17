/**
 * Deceleration fixtures for the Kestrel (tests/flightDecel.test.ts and tools/decel.preview.ts):
 * air starts at a calibrated airspeed and configuration, level flight through the flight
 * director with the throttle left to the caller, and the drag and thrust at a moment.
 */
import { DEG, KNOT } from '../../src/core/units';
import { calibratedAirspeed, standardAtmosphere } from '../../src/sim/flight/atmosphere';
import { neutralControls } from '../../src/sim/flight/controlLaws';
import type { FlightControls } from '../../src/sim/flight/controlLaws';
import { FlightDirector, speedForAlpha } from '../../src/sim/flight/flightDirector';
import { FlightMonitor } from '../../src/sim/flight/outcomes';
import type { Touchdown } from '../../src/sim/flight/outcomes';
import { TestPilot } from '../../src/sim/flight/testPilot';
import { FLIGHT_STEP } from '../../src/sim/flight/flightModel';
import type { FlightModel, GroundQuery } from '../../src/sim/flight/flightModel';
import { lookup, lookup2 } from '../../src/sim/flight/flightSpec';
import {
  AIM_POINT,
  GLIDE_PATH,
  headingVector,
  runwayEnds,
  runwayFrame,
  runwayPoint,
} from '../../src/sim/flight/runway';
import type { Runway, RunwayEnd } from '../../src/sim/flight/runway';
import { flatGround, kestrel, testRunway } from './flight';

/** Landing weight: internal fuel down to 1,000 kg, no stores beyond the spec's payload. */
export const LANDING_FUEL = 1000;

/** A runway at sea level, so altitudes above it are altitudes above sea level. */
export const SEA_RUNWAY: Runway = testRunway(0);
export const SEA_GROUND: GroundQuery = flatGround(SEA_RUNWAY);
export const SEA_END: RunwayEnd = runwayEnds(SEA_RUNWAY)[0];

/** True airspeed (m/s) for calibrated airspeed `cas` (m/s) at altitude `h` (m), by bisection. */
export function tasFor(cas: number, h: number): number {
  const air = standardAtmosphere(h);
  let lo = cas * 0.5;
  let hi = cas * 3;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (calibratedAirspeed(mid, air) < cas) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export interface Configuration {
  gear: boolean;
  speedbrake: boolean;
}

/**
 * A Kestrel at landing weight, level at `h` m above sea level and `cas` (m/s) along the
 * runway's heading, in configuration `cfg` already reached (gear and speedbrake at their
 * stops), engine at idle, pitched to about the 1-g angle of attack.
 */
export function levelStart(
  cas: number,
  h: number,
  cfg: Configuration,
  fuel = LANDING_FUEL,
  path = 0,
): { m: FlightModel; ctl: FlightControls } {
  const m = kestrel();
  m.fuel = fuel;
  const tas = tasFor(cas, h);
  const air = standardAtmosphere(h);
  const cl = (m.mass * 9.80665) / (0.5 * air.density * tas * tas * m.spec.wing.area);
  // The angle of attack for that CL from the lift table, below the stall.
  let alpha = 0;
  for (let a = -5 * DEG; a < 25 * DEG; a += 0.05 * DEG) {
    const c = lookup(m.spec.aero.cl, a) + (cfg.gear ? m.spec.aero.flapCl : 0);
    if (c >= cl) {
      alpha = a;
      break;
    }
  }
  const frame = runwayFrame(SEA_RUNWAY);
  const pos = runwayPoint(SEA_RUNWAY, frame, SEA_END.threshold - 40_000, 0, h, m.radius);
  const up = pos.clone().normalize();
  const vel = headingVector(up, SEA_END.heading)
    .scale(tas * Math.cos(path))
    .addScaled(up, tas * Math.sin(path));
  m.place(pos, vel, SEA_END.heading, alpha + path, 0);
  m.gear = cfg.gear ? 1 : 0;
  m.speedbrake = cfg.speedbrake ? 1 : 0;
  m.power = 0;
  m.afterburner = 0;
  m.lawState.airborne = 30;
  m.unlimitedFuel = true;
  const ctl = neutralControls();
  ctl.gearDown = cfg.gear;
  ctl.speedbrake = cfg.speedbrake;
  ctl.throttle = 0;
  return { m, ctl };
}

/**
 * Holds altitude `h` through the flight director for one step, or flies flight path `path`
 * (rad) if given; the throttle stays the caller's.
 */
export function levelStep(
  m: FlightModel,
  ctl: FlightControls,
  fd: FlightDirector,
  h: number,
  ground: GroundQuery = SEA_GROUND,
  path: number | null = null,
): void {
  const t = m.telemetry;
  const gamma = path ?? Math.max(-0.05, Math.min(0.05, (h - t.altitude) * 0.003));
  const throttle = ctl.throttle;
  fd.fly(m, { course: SEA_END.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
  ctl.throttle = throttle;
  m.step(ctl, ground);
}

export interface DragSnapshot {
  cas: number;
  qbar: number;
  alpha: number;
  cl: number;
  cd: number;
  terms: FlightModel['telemetry']['drag'];
  drag: number;
  thrust: number;
  /** Deceleration along the path (m/s², + slowing), from the calibrated airspeed's change. */
  decel: number;
}

/**
 * Flies level (or along flight path `path`, rad) at idle from a start `margin` m/s above
 * `cas` until the calibrated airspeed falls through `cas`, and returns the drag and thrust there; the deceleration is the change
 * of calibrated airspeed over the second around it.
 */
export function snapshotAt(
  cas: number,
  h: number,
  cfg: Configuration,
  margin = 12 * KNOT,
  path: number | null = null,
  fuel = LANDING_FUEL,
) {
  const { m, ctl } = levelStart(cas + margin, h, cfg, fuel, path ?? 0);
  const fd = new FlightDirector();
  const history: number[] = [];
  const half = Math.round(0.5 / FLIGHT_STEP);
  let snap: DragSnapshot | null = null;
  let at = -1;
  for (let i = 0; i < 120 / FLIGHT_STEP; i++) {
    levelStep(m, ctl, fd, h, SEA_GROUND, path);
    const t = m.telemetry;
    history.push(t.cas);
    if (!snap && t.cas <= cas && i > half) {
      at = i;
      snap = {
        cas: t.cas,
        qbar: t.qbar,
        alpha: t.alpha,
        cl: t.cl,
        cd: t.cd,
        terms: { ...t.drag },
        drag: t.qbar * m.spec.wing.area * t.cd,
        thrust: t.thrust,
        decel: 0,
      };
    }
    if (snap && i === at + half) {
      snap.decel = (history[at - half]! - history[at + half]!) / (2 * half * FLIGHT_STEP);
      break;
    }
  }
  return { snap, m };
}

/**
 * Seconds of level flight at idle from `from` to `to` (calibrated m/s) at `h` m in
 * configuration `cfg`; `Infinity` if it never gets there in `limit` s.
 */
export function decelTime(from: number, to: number, h: number, cfg: Configuration, limit = 300) {
  const { m, ctl } = levelStart(from, h, cfg);
  const fd = new FlightDirector();
  for (let i = 0; i < limit / FLIGHT_STEP; i++) {
    levelStep(m, ctl, fd, h);
    if (m.telemetry.cas <= to) return { seconds: (i + 1) * FLIGHT_STEP, m };
  }
  return { seconds: Infinity, m };
}

/** Steady lift over drag (aerodynamic, no thrust) at the moment. */
export function liftOverDrag(m: FlightModel): number {
  return m.telemetry.cl / m.telemetry.cd;
}

/**
 * Flies level at 1,500 m with the flight director and, after `settle` s, moves the
 * throttle from `from` to `to` and returns the seconds until the thrust is within 5% of
 * the span from its final value (95% of the change), and the thrusts before and after.
 */
export function spoolTime(from: number, to: number, cas = 250 * KNOT, h = 1500) {
  const { m, ctl } = levelStart(cas, h, { gear: false, speedbrake: false });
  const fd = new FlightDirector();
  ctl.throttle = from;
  m.power = Math.min(1, from / 0.8);
  for (let i = 0; i < 20 / FLIGHT_STEP; i++) levelStep(m, ctl, fd, h);
  const before = m.telemetry.thrust;
  ctl.throttle = to;
  const series: number[] = [];
  for (let i = 0; i < 20 / FLIGHT_STEP; i++) {
    levelStep(m, ctl, fd, h);
    series.push(m.telemetry.thrust);
  }
  const after = series[series.length - 1]!;
  const span = Math.abs(after - before);
  let k = series.length - 1;
  while (k > 0 && Math.abs(series[k - 1]! - after) <= 0.05 * span) k--;
  return { seconds: (k + 1) * FLIGHT_STEP, before, after };
}

/**
 * Flies on-speed angle of attack `alpha` with the gear down and the speedbrake `sb`
 * (0..1 of its travel; the model may limit it) down a `gamma` path (rad, + climbing)
 * with the throttle held by a PI loop on angle of attack, from `h` m; returns the
 * steady state after `seconds`.
 */
export function onSpeedPath(gamma: number, alpha = 13 * DEG, sb = true, h = 1500, seconds = 60) {
  const { m, ctl } = levelStart(150 * KNOT, h, { gear: true, speedbrake: sb });
  const fd = new FlightDirector();
  let integ = 0.3;
  let thrust = 0;
  let lever = 0;
  let cas = 0;
  let ld = 0;
  let a = 0;
  let n = 0;
  const steps = seconds / FLIGHT_STEP;
  for (let i = 0; i < steps; i++) {
    const t = m.telemetry;
    // Too slow (α high): more throttle.
    const e = t.alpha - alpha;
    integ = Math.max(0, Math.min(0.8, integ + 0.4 * e * FLIGHT_STEP));
    ctl.throttle = Math.max(0, Math.min(0.8, integ + 3 * e));
    fd.fly(m, { course: SEA_END.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
    ctl.throttle = Math.max(0, Math.min(0.8, integ + 3 * e));
    m.step(ctl, SEA_GROUND);
    if (i > steps * 0.6) {
      thrust += t.thrust;
      lever += ctl.throttle;
      cas += t.cas;
      ld += t.cl / t.cd;
      a += t.alpha;
      n++;
    }
  }
  return {
    thrust: thrust / n,
    lever: lever / n,
    cas: cas / n,
    ld: ld / n,
    alpha: a / n,
    idleThrust: idleThrustAt(m),
    m,
  };
}

/** The idle thrust at the model's present altitude and Mach number (N). */
export function idleThrustAt(m: FlightModel): number {
  const th = m.spec.engine.thrust;
  const air = standardAtmosphere(m.telemetry.altitude);
  return lookup2(
    th.altitude,
    th.mach,
    th.idle,
    m.telemetry.altitude,
    m.telemetry.tas / air.speedOfSound,
  );
}

/**
 * The idle glide at on-speed angle of attack with the gear down: the flight path angle the
 * director must fly to hold `alpha` at idle (rad, negative descending), steady after `seconds`.
 */
export function idleGlide(alpha = 13 * DEG, sb = false, h = 3000, seconds = 90) {
  const { m, ctl } = levelStart(150 * KNOT, h, { gear: true, speedbrake: sb });
  const fd = new FlightDirector();
  let gamma = -5 * DEG;
  let sum = 0;
  let n = 0;
  const steps = seconds / FLIGHT_STEP;
  for (let i = 0; i < steps; i++) {
    const t = m.telemetry;
    // Slow (α high): steepen the path.
    gamma = Math.max(-25 * DEG, Math.min(0, gamma - 0.6 * (t.alpha - alpha) * FLIGHT_STEP));
    ctl.throttle = 0;
    fd.fly(m, { course: SEA_END.heading, gamma, speed: null }, ctl, FLIGHT_STEP);
    ctl.throttle = 0;
    m.step(ctl, SEA_GROUND);
    if (i > steps * 0.6) {
      sum += t.gamma;
      n++;
    }
  }
  return { gamma: sum / n, alpha: m.telemetry.alpha, cas: m.telemetry.cas, m };
}

export interface ApproachLog {
  /** Distance before the threshold (m) where the speed first fell below 300 KIAS, and the gear came down. */
  below300At: number | null;
  gearDownAt: number | null;
  /** The state 5 km before the threshold. */
  at5km: {
    cas: number;
    alpha: number;
    /** Height above the glide path (m) and the sink rate (m/s). */
    deviation: number;
    sink: number;
    /** Largest |α − on-speed| and glide-path deviation over the 5–2 km stretch. */
    alphaSpread: number;
    deviationSpread: number;
    approachSpeed: number;
  } | null;
  /** Distance (m) where the pilot went on to the final (on speed). */
  onSpeedAt: number | null;
  touchdown: Touchdown | null;
  crashed: string | null;
  phase: string;
  /** Peak speedbrake travel with the gear down (0..1 of 60°). */
  sbWithGear: number;
  /** Samples every km: distance (km), KIAS, height above runway (m), α (°), throttle, gear. */
  track: [number, number, number, number, number, number][];
}

/**
 * The straight-in approach of the acceptance test (decision 207): `distance` m before the
 * threshold on the extended centerline, `height` m above the runway, `kias` knots, gear up;
 * the test pilot idles, opens the speedbrake, lowers the gear under 300 KIAS, captures the
 * 3° glide path, flies the final at on-speed angle of attack with the throttle and lands.
 */
export function straightInApproach(
  fuel = LANDING_FUEL,
  distance = 25_000,
  height = 1500,
  kias = 450,
  onStep?: (m: FlightModel, ctl: FlightControls, before: number, runway: Runway) => void,
): ApproachLog {
  const runway = testRunway();
  const ground = flatGround(runway);
  const end = runwayEnds(runway)[0];
  const frame = runwayFrame(runway);
  const m = kestrel();
  m.fuel = fuel;
  m.unlimitedFuel = true;
  const along = end.threshold - end.sign * distance;
  const pos = runwayPoint(runway, frame, along, 0, height, m.radius);
  const tas = tasFor(kias * KNOT, runway.elevation + height);
  const vel = headingVector(pos.clone().normalize(), end.heading).scale(tas);
  m.place(pos, vel, end.heading, 1 * DEG, 0);
  m.gear = 0;
  m.speedbrake = 0;
  m.power = 0.6;
  m.afterburner = 0;
  m.lawState.airborne = 30;
  const ctl = neutralControls();
  ctl.gearDown = false;
  ctl.throttle = 0.6;
  const pilot = new TestPilot(runway, end, m.radius);
  pilot.straightIn();
  const monitor = new FlightMonitor([runway], m.radius);
  monitor.reset(true);
  const log: ApproachLog = {
    below300At: null,
    gearDownAt: null,
    at5km: null,
    onSpeedAt: null,
    touchdown: null,
    crashed: null,
    phase: '',
    sbWithGear: 0,
    track: [],
  };
  let nextKm = Math.floor(distance / 1000);
  let alphaSpread = 0;
  let devSpread = 0;
  const onSpeed = 13 * DEG;
  for (let i = 0; i < 400 / FLIGHT_STEP && !m.crashed && pilot.phase !== 'stopped'; i++) {
    pilot.fly(m, ctl, FLIGHT_STEP);
    m.step(ctl, ground);
    for (const e of monitor.update(m, FLIGHT_STEP))
      if (e.kind === 'touchdown' && !log.touchdown) log.touchdown = e.touchdown;
    const t = m.telemetry;
    const c = pilot.coords(m);
    const before = -c.t;
    onStep?.(m, ctl, before, runway);
    if (log.below300At === null && t.cas < 300 * KNOT) log.below300At = before;
    if (log.gearDownAt === null && m.gear >= 0.999) log.gearDownAt = before;
    if (log.onSpeedAt === null && pilot.phase === 'final') log.onSpeedAt = before;
    if (m.gear > 0.5) log.sbWithGear = Math.max(log.sbWithGear, m.speedbrake);
    const hGs = (AIM_POINT - c.t) * Math.tan(GLIDE_PATH);
    if (before <= 5000 && before >= 2000) {
      alphaSpread = Math.max(alphaSpread, Math.abs(t.alpha - onSpeed));
      devSpread = Math.max(devSpread, Math.abs(c.h - hGs));
    }
    if (log.at5km === null && before <= 5000) {
      log.at5km = {
        cas: t.cas,
        alpha: t.alpha,
        deviation: c.h - hGs,
        sink: -t.verticalSpeed,
        alphaSpread: 0,
        deviationSpread: 0,
        approachSpeed: speedForAlpha(m, onSpeed),
      };
    }
    if (before <= nextKm * 1000 && nextKm >= 0) {
      log.track.push([nextKm, t.cas / KNOT, c.h, t.alpha / DEG, ctl.throttle, m.gear]);
      nextKm--;
    }
  }
  if (log.at5km) {
    log.at5km.alphaSpread = alphaSpread;
    log.at5km.deviationSpread = devSpread;
  }
  log.crashed = m.crashed;
  log.phase = pilot.phase;
  return log;
}
