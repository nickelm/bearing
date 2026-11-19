/**
 * What the Free Flight HUD shows each frame (decision 134), from the flight
 * model, the controls and the runways: the HudFrame the Canvas HUD draws, and
 * the landing aid for the destination runway. No DOM and no three.js, so the
 * preview tool builds the same frames headlessly.
 */
import { DEG } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import type { FlightControls } from '../../sim/flight/controlLaws';
import type { Airframe } from '../../sim/flight/airframe';
import { approachEnergy, approachSpeed, ON_SPEED_MARGIN } from '../../sim/flight/energy';
import type { FlightModel } from '../../sim/flight/flightModel';
import { flightWarnings } from '../../sim/flight/outcomes';
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
} from '../../sim/flight/runway';
import type { Runway, RunwayEnd } from '../../sim/flight/runway';
import type { ControlCursor } from './controlCursor';
import type { HoverHud, HudEnergy, HudFrame, HudLandingAid } from './hud';

/** The speed trend vector looks this far ahead (s). */
export const TREND_TIME = 10;

/**
 * The approach energy cue (decision 207) for a jet `toAim` m before the aim point and `height`
 * m above the runway (its gear's height over it, so the runway's elevation is the altitude
 * less that): shown in the air on the way in while faster than the approach speed.
 */
export function energyCue(m: FlightModel, toAim: number, height: number): HudEnergy | null {
  const t = m.telemetry;
  if (m.onGround || toAim <= 0 || t.cas <= approachSpeed(m.spec, m.mass) + ON_SPEED_MARGIN)
    return null;
  const e = approachEnergy(m.spec, m.mass, t.altitude - height, t.cas, toAim, height);
  return { needed: e.needed, available: e.available, state: e.state };
}

/** Range of the landing aid (m): the nearest runway within it is the destination. */
export const AID_RANGE = 80_000;

/** The destination runway: the nearest within range, and the end being approached. */
export function destination(
  m: Airframe,
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
  m: Airframe,
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
    energy: m.kind === 'fixed-wing' ? energyCue(m as FlightModel, gsDist, height) : null,
  };
}

/** The angle-of-attack bracket's top, center and bottom (rad): fast, on speed, slow (decision 208). */
export const BRACKET_ALPHA = { top: 11 * DEG, center: 13 * DEG, bottom: 15 * DEG } as const;

/**
 * The angle-of-attack bracket's world directions (decision 208): where the flight path
 * marker (the velocity's direction) would sit at the bracket's angles of attack, i.e. the
 * velocity turned about the body's lateral axis by α less that angle, toward the nose when
 * α is greater. With the gear handle down, in the air, moving; else null.
 */
export function aoaBracket(
  m: FlightModel,
  gearDown: boolean,
): NonNullable<HudFrame['aoaBracket']> | null {
  const t = m.telemetry;
  const speed = m.vel.length();
  if (!gearDown || m.onGround || speed < 20) return null;
  const v = m.vel.clone().scale(1 / speed);
  const k = m.bodyAxis(1);
  const kxv = k.clone().cross(v);
  const kv = k.dot(v);
  // Rodrigues: v cos φ + (k × v) sin φ + k (k·v)(1 − cos φ); +φ about body y is nose up.
  const turn = (phi: number): [number, number, number] => {
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const d = v
      .clone()
      .scale(c)
      .addScaled(kxv, s)
      .addScaled(k, kv * (1 - c))
      .normalize();
    return [d.x, d.y, d.z];
  };
  return {
    top: turn(t.alpha - BRACKET_ALPHA.top),
    center: turn(t.alpha - BRACKET_ALPHA.center),
    bottom: turn(t.alpha - BRACKET_ALPHA.bottom),
  };
}

export function buildHudFrame(
  m: FlightModel,
  c: Readonly<FlightControls>,
  opts: {
    aid: HudLandingAid | null;
    mode: string;
    control: ControlCursor | null;
    timing: { frameMs: number; physicsMs: number; steps: number } | null;
    hover?: HoverHud | null;
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
    gearDamaged: m.gearDamaged,
    speedbrake: m.speedbrake,
    speedbrakeAngle: m.speedbrakeDeflection,
    brakes: c.brakeLeft > 0 || c.brakeRight > 0,
    parkingBrake: c.parkingBrake,
    onGround: m.onGround,
    velocity: [m.vel.x, m.vel.y, m.vel.z],
    boresight: [bx.x, bx.y, bx.z],
    warnings: flightWarnings(m),
    aid: opts.aid,
    aoaBracket: aoaBracket(m, c.gearDown),
    speedCues: {
      gearLimit: m.gearSpeedLimit,
      approach: approachSpeed(m.spec, m.mass),
      trend: tel.cas + TREND_TIME * tel.casRate,
    },
    mode: opts.mode,
    control: opts.control,
    hover: opts.hover ?? null,
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

/**
 * The hover vector's scale (Proposal 0004, Hover Symbology): the velocity
 * vector reaches as far over the ground as the helicopter drifts in
 * `HOVER_VECTOR_TIME` seconds, approaching `HOVER_VECTOR_MAX` meters softly, so
 * a drift of 0.5 m/s still shows and a transition does not reach the horizon.
 */
export const HOVER_VECTOR_TIME = 2;
export const HOVER_VECTOR_MAX = 12;
/** The acceleration cue marks the velocity `HOVER_CUE_TIME` seconds ahead, on the same scale. */
export const HOVER_CUE_TIME = 1;

/** Plain inputs for the hover symbology: world frame, SI. */
export interface HoverInputs {
  /** Aircraft reference point (m), its nose axis (unit) and the camera eye (m). */
  pos: Readonly<Vec3d>;
  forward: Readonly<Vec3d>;
  eye: Readonly<Vec3d>;
  /** Planet radius and the ground's height under the aircraft (m). */
  radius: number;
  groundHeight: number;
  /** Height of the reference point above the skids or wheels (m), taken off the radar altitude. */
  gearHeight?: number;
  /** Velocity (m/s) and acceleration (m/s²). */
  velocity: Readonly<Vec3d>;
  accel: Readonly<Vec3d>;
  /** Fractions of maximum torque and governed rotor speed. */
  torque: number;
  rotorRpm: number;
  /** The landing zone's point on the ground (world, m), or null. */
  lz?: Readonly<Vec3d> | null;
  modes?: string[];
  hazards?: string[];
}

/** Length on the ground (m) of the hover vector for a horizontal speed (m/s). */
export function hoverVectorLength(speed: number): number {
  return HOVER_VECTOR_MAX * Math.tanh((speed * HOVER_VECTOR_TIME) / HOVER_VECTOR_MAX);
}

/**
 * The hover symbology from plain numbers. The heading frame is the nose axis
 * flattened onto the local horizontal; the ground point lies on the local
 * vertical at the ground's height; the velocity vector and the acceleration cue
 * lie on the tangent plane through it, scaled by `hoverVectorLength`. Points are
 * relative to `eye`, subtracted in float64 (rule 4). The LZ's distance is
 * horizontal, its bearing relative to the nose.
 */
export function hoverSymbols(i: HoverInputs): HoverHud {
  const up = i.pos.clone().normalize();
  const fwd = i.forward.clone().addScaled(up, -i.forward.dot(up));
  if (fwd.lengthSq() < 1e-12) {
    // Nose straight up or down: any horizontal direction will do.
    fwd.set(0, 1, 0).addScaled(up, -up.y);
    if (fwd.lengthSq() < 1e-12) fwd.set(1, 0, 0).addScaled(up, -up.x);
  }
  fwd.normalize();
  const right = fwd.clone().cross(up).normalize();
  const vf = i.velocity.dot(fwd);
  const vr = i.velocity.dot(right);
  const af = i.accel.dot(fwd);
  const ar = i.accel.dot(right);
  const ground = up.clone().scale(i.radius + i.groundHeight);
  const tip = (f: number, r: number): Vec3d => {
    const speed = Math.hypot(f, r);
    const k = speed > 1e-9 ? hoverVectorLength(speed) / speed : 0;
    return ground
      .clone()
      .addScaled(fwd, f * k)
      .addScaled(right, r * k)
      .sub(i.eye);
  };
  let lz: HoverHud['lz'] = null;
  if (i.lz) {
    const d = i.lz.clone().sub(i.pos);
    const df = d.dot(fwd);
    const dr = d.dot(right);
    lz = {
      distance: Math.hypot(df, dr),
      bearing: Math.atan2(dr, df),
      point: i.lz.clone().sub(i.eye),
    };
  }
  return {
    velocity: { forward: vf, right: vr },
    accel: { forward: af, right: ar },
    groundPoint: ground.clone().sub(i.eye),
    velocityTip: tip(vf, vr),
    accelTip: tip(vf + af * HOVER_CUE_TIME, vr + ar * HOVER_CUE_TIME),
    radarAltitude: Math.max(0, i.pos.length() - i.radius - i.groundHeight - (i.gearHeight ?? 0)),
    verticalSpeed: i.velocity.dot(up),
    torque: i.torque,
    rotorRpm: i.rotorRpm,
    lz,
    modes: i.modes ?? [],
    hazards: i.hazards ?? [],
  };
}
