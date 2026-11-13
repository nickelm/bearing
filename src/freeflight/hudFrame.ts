/**
 * What the Free Flight HUD shows each frame (decision 134), from the flight
 * model, the controls and the runways: the HudFrame the Canvas HUD draws, and
 * the landing aid for the destination runway. No DOM and no three.js, so the
 * preview tool builds the same frames headlessly.
 */
import { DEG } from '../core/units';
import type { Vec3d } from '../core/vec3d';
import type { FlightControls } from '../sim/flight/controlLaws';
import type { FlightModel } from '../sim/flight/flightModel';
import { flightWarnings } from '../sim/flight/outcomes';
import {
  AIM_POINT,
  endFor,
  GLIDE_PATH,
  headingOf,
  nearestRunway,
  pastThreshold,
  runwayFrame,
  runwayPoint,
  toRunway,
} from '../sim/flight/runway';
import type { Runway, RunwayEnd } from '../sim/flight/runway';
import type { HudFrame, HudLandingAid } from '../ui/flight/hud';

/** Range of the landing aid (m): the nearest runway within it is the destination. */
export const AID_RANGE = 80_000;

/** The destination runway: the nearest within range, and the end being approached. */
export function destination(
  m: FlightModel,
  runways: readonly Runway[],
): { runway: Runway; end: RunwayEnd } | null {
  const up = m.pos.clone().normalize();
  const n = nearestRunway(runways, up, m.radius);
  if (!n || n.distance > AID_RANGE) return null;
  const r = n.runway;
  const toCenter = r.center.clone().sub(up);
  // Far out, the end that faces the aircraft; close in and moving, the end it is lined up on.
  const heading =
    n.distance > 4000 || m.telemetry.groundSpeed < 20
      ? headingOf(up, toCenter)
      : m.telemetry.heading;
  return { runway: r, end: endFor(r, heading) };
}

/**
 * The landing aid for the destination runway: distance and bearing to the
 * threshold, localizer deviation (full scale ±2.5° from an antenna 300 m past
 * the far end) and glideslope deviation (full scale ±0.7° about the 3° path to
 * the aim point), and the runway's outline relative to `eye` for the HUD.
 */
export function landingAid(
  m: FlightModel,
  runways: readonly Runway[],
  eye: Readonly<Vec3d>,
): HudLandingAid | null {
  const d = destination(m, runways);
  if (!d) return null;
  const { runway: r, end } = d;
  const R = m.radius;
  const f = runwayFrame(r);
  const c = toRunway(r, f, m.pos, R);
  const t = pastThreshold(end, c.along);
  const lateral = c.across * end.sign;
  const height = c.height - m.gearHeightNow();
  const loc = Math.atan2(lateral, Math.max(1, r.length + 300 - t));
  const gsDist = AIM_POINT - t;
  const gs = Math.atan2(height, Math.max(1, gsDist)) - GLIDE_PATH;
  const threshold = runwayPoint(r, f, end.threshold, 0, 0, R);
  const up = m.pos.clone().normalize();
  const toThr = threshold.clone().sub(m.pos);
  const rel = (along: number, across: number): [number, number, number] => {
    const p = runwayPoint(r, f, along, across, 0, R).sub(eye);
    return [p.x, p.y, p.z];
  };
  const hw = r.width / 2;
  return {
    name: r.name,
    designator: end.designator,
    distance: toThr.length(),
    bearing: headingOf(up, toThr),
    // Needles point the way to fly: right of the centerline → fly left (negative).
    localizer: -(loc / (2.5 * DEG)),
    glideslope: gsDist > 0 ? -(gs / (0.7 * DEG)) : 0,
    corners: [
      rel(-r.length / 2, -hw),
      rel(r.length / 2, -hw),
      rel(r.length / 2, hw),
      rel(-r.length / 2, hw),
    ],
    aim: rel(end.threshold + end.sign * AIM_POINT, 0),
  };
}

export function buildHudFrame(
  m: FlightModel,
  c: Readonly<FlightControls>,
  opts: {
    aid: HudLandingAid | null;
    mode: string;
    aim: { x: number; y: number } | null;
    timing: { frameMs: number; physicsMs: number; steps: number } | null;
  },
): HudFrame {
  const tel = m.telemetry;
  const bx = m.bodyAxis(0);
  return {
    cas: tel.cas,
    mach: tel.mach,
    altitude: tel.altitude,
    radarAltitude: tel.radarAltitude,
    verticalSpeed: tel.verticalSpeed,
    heading: tel.heading,
    pitch: tel.pitch,
    bank: tel.bank,
    alpha: tel.alpha,
    beta: tel.beta,
    load: tel.load,
    throttle: c.throttle,
    power: m.power,
    afterburner: m.afterburner,
    fuel: m.fuel,
    unlimitedFuel: m.unlimitedFuel,
    gear: m.gear,
    gearDown: c.gearDown,
    speedbrake: m.speedbrake,
    brakes: c.brakeLeft > 0 || c.brakeRight > 0,
    parkingBrake: c.parkingBrake,
    onGround: m.onGround,
    velocity: [m.vel.x, m.vel.y, m.vel.z],
    boresight: [bx.x, bx.y, bx.z],
    warnings: flightWarnings(m),
    aid: opts.aid,
    mode: opts.mode,
    aim: opts.aim,
    debug: opts.timing
      ? {
          cl: tel.cl,
          cd: tel.cd,
          thrust: tel.thrust,
          qbar: tel.qbar,
          aero: [tel.aero.x, tel.aero.y, tel.aero.z],
          gear: [tel.gearForce.x, tel.gearForce.y, tel.gearForce.z],
          gravity: [tel.gravity.x, tel.gravity.y, tel.gravity.z],
          blend: tel.laws.blend,
          ...opts.timing,
        }
      : null,
  };
}
