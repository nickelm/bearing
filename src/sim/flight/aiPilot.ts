/**
 * The AI pilot of a promoted campaign flight (roadmap R2.5): it flies a reference
 * trajectory through the flight director and the flight model, as the player's
 * mouse aim does (rule 12). Nothing moves the aircraft but the model.
 *
 * Its orders are the mission's analytic route. A route is a function of time
 * (route.ts), and its legs, climbs, racetrack orbit, pass over the target and
 * the turn home (decision 255) are all in it, so one law flies every phase: the
 * lead keeps station on the point where its route says it should be now, and a
 * wingman keeps station on its formation slot beside the flown lead
 * (formation.ts, the slots R2.4 draws). Releasing weapons on the pass is R2.6's.
 *
 * The law (`TrackerGains`), in the reference's level frame at the aircraft:
 * - **along** the reference's track: ground speed is the reference's plus a share
 *   of the distance behind it (`along`, limited to ±`speedRange` of the speed), so
 *   the aircraft closes on the point at a rate it can damp with its throttle;
 * - **across**: the course is the reference's track a moment ahead (`feedForward`,
 *   which leads the roll into a turn) plus the angle to the reference over a
 *   look-ahead distance (`lookAhead` seconds of flight, at least `minLookAhead`);
 * - **vertical**: the flight path climbs at the reference's rate plus a share of
 *   the height error (`vertical`), within `maxClimb` and `maxDescent`.
 *
 * The ground speed becomes an airspeed by the aircraft's own difference between
 * the two (the wind along its track as it feels it now), then a calibrated one.
 * Speed comes first: as the airspeed falls short of the command, the climb gives
 * way (level at SPEED_MARGIN short) and the bank limit comes down to half, the bank
 * never asks more load than the airspeed gives at 8° of angle of attack, and below
 * the least speed (8° of angle of attack at 1 g) the nose goes down, so a
 * route that climbs faster than the type can is followed late, and a tight turn at
 * altitude wide, never at the stall. Far behind (`afterburnerBehind`) or short of
 * speed (AB_SHORT), the throttle may enter the afterburner.
 */
import { DEG } from '../../core/units';
import type { GameTime } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import type { AnalyticPose } from '../air/analyticPose';
import type { MissionPhase } from '../air/mission';
import { calibratedAirspeed, standardAtmosphere } from './atmosphere';
import type { FlightControls } from './controlLaws';
import { FlightDirector, speedForAlpha } from './flightDirector';
import type { FlightModel } from './flightModel';
import { headingOf } from './runway';

/** Where the reference is at a game time: position (world, m) and velocity (m/s), or null. */
export interface ReferencePoint {
  pos: Readonly<Vec3d>;
  vel: Readonly<Vec3d>;
}
export type Reference = (t: GameTime) => ReferencePoint | null;

/** Spacing of a sampled reference's samples (s). */
export const REFERENCE_SAMPLE = 0.25;

/**
 * A reference sampled every REFERENCE_SAMPLE seconds of game time and interpolated
 * linearly between samples, kept for the last few: a route's analytic pose costs
 * hundreds of route lookups, and the tracker asks for two a step at 120 Hz. Over a
 * quarter second the interpolation is off by centimeters in a turn.
 */
export function sampledReference(ref: Reference, step = REFERENCE_SAMPLE): Reference {
  const cache = new Map<number, ReferencePoint | null>();
  const at = (k: number): ReferencePoint | null => {
    let s = cache.get(k);
    if (s === undefined) {
      s = ref(k * step);
      cache.set(k, s);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
    }
    return s;
  };
  return (t) => {
    const k = Math.floor(t / step);
    const a = at(k);
    const b = at(k + 1);
    if (!a || !b) return a ?? b;
    const f = t / step - k;
    return {
      pos: a.pos
        .clone()
        .scale(1 - f)
        .addScaled(b.pos, f),
      vel: a.vel
        .clone()
        .scale(1 - f)
        .addScaled(b.vel, f),
    };
  };
}

export interface TrackerGains {
  /** Ground speed per meter behind the reference (1/s). */
  along: number;
  /** Most speed added or taken away, as a share of the reference's speed. */
  speedRange: number;
  /** Look-ahead of the cross-track correction (s of flight) and its least distance (m). */
  lookAhead: number;
  minLookAhead: number;
  /** How far ahead the reference's track is read (s): leads the roll into a turn. */
  feedForward: number;
  /** Climb rate per meter of height error (1/s), and the flight path's limits (rad). */
  vertical: number;
  maxClimb: number;
  maxDescent: number;
  /** Distance behind (m) beyond which the afterburner may be used. */
  afterburnerBehind: number;
  /** Bank limit (rad). */
  maxBank: number;
}

/** The lead on its route: gentle, since the route is a path to keep near, not a slot. */
export const ROUTE_GAINS: Readonly<TrackerGains> = {
  along: 0.02,
  speedRange: 0.25,
  lookAhead: 12,
  minLookAhead: 1500,
  feedForward: 3,
  vertical: 0.08,
  maxClimb: 25 * DEG,
  maxDescent: 15 * DEG,
  afterburnerBehind: 4000,
  maxBank: 60 * DEG,
};

/** A wingman on its slot: tighter, and on the lead's own track a moment ahead. */
export const FORMATION_GAINS: Readonly<TrackerGains> = {
  along: 0.06,
  speedRange: 0.3,
  lookAhead: 4,
  minLookAhead: 300,
  feedForward: 1.5,
  vertical: 0.25,
  maxClimb: 30 * DEG,
  maxDescent: 20 * DEG,
  afterburnerBehind: 1500,
  maxBank: 70 * DEG,
};

/** Airspeed short of the command (m/s, calibrated) at which the climb has given way entirely. */
export const SPEED_MARGIN = 30;
/** Airspeed short of the command (m/s) at which the afterburner may be used. */
export const AB_SHORT = 10;
/** The bank the speed envelope always allows (rad). */
export const MIN_BANK = 10 * DEG;
/** Flight path (rad, descending) below the least speed. */
export const UNLOAD = 3 * DEG;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** What the tracker read last step, for tests and the debug view. */
export interface TrackerState {
  /** Distance behind the reference along its track (m; negative: ahead), beside it (m, + right) and below it (m). */
  behind: number;
  aside: number;
  below: number;
  /** The course, flight path and calibrated airspeed asked of the director. */
  course: number;
  gamma: number;
  cas: number;
}

/** Flies an aircraft along a reference trajectory through the flight director. */
export class PoseTracker {
  readonly director = new FlightDirector();
  readonly state: TrackerState = {
    behind: 0,
    aside: 0,
    below: 0,
    course: 0,
    gamma: 0,
    cas: 0,
  };
  private readonly e = new Vec3d();
  private readonly a = new Vec3d();
  private readonly r = new Vec3d();

  constructor(
    public reference: Reference,
    public gains: Readonly<TrackerGains> = ROUTE_GAINS,
  ) {}

  /** Forgets the director's integrators (after a handback). */
  reset(): void {
    this.director.reset();
  }

  /** Writes the controls for one step of `dt` s at game time t; false when the reference is gone. */
  fly(model: FlightModel, t: GameTime, ctl: FlightControls, dt: number): boolean {
    const ref = this.reference(t);
    if (!ref) return false;
    const g = this.gains;
    const tel = model.telemetry;
    const up = model.pos.clone().normalize();
    // The reference's horizontal track, or the aircraft's while the reference stands still.
    const vUp = ref.vel.dot(up);
    const a = this.a.copy(ref.vel).addScaled(up, -vUp);
    let refSpeed = a.length();
    if (refSpeed < 1) {
      a.copy(model.vel).addScaled(up, -model.vel.dot(up));
      refSpeed = 0;
    }
    if (a.lengthSq() < 1e-6) a.set(1, 0, 0).addScaled(up, -up.x);
    a.normalize();
    // Right of the track: track × up.
    const r = this.r.copy(a).cross(up).normalize();
    const e = this.e.copy(ref.pos).sub(model.pos);
    const behind = e.dot(a);
    const aside = e.dot(r);
    const below = ref.pos.length() - model.pos.length();

    // Along: ground speed.
    const range = g.speedRange * Math.max(refSpeed, 100);
    const gs = Math.max(0, refSpeed + clamp(g.along * behind, -range, range));
    // Across: the reference's track a moment ahead, plus the angle to it over the look-ahead.
    const ahead = g.feedForward > 0 ? this.reference(t + g.feedForward) : null;
    let track = headingOf(up, a);
    if (ahead) {
      const av = ahead.vel.clone().addScaled(up, -ahead.vel.dot(up));
      if (av.lengthSq() > 1) track = headingOf(up, av);
    }
    const v = Math.max(tel.tas, 60);
    const look = Math.max(g.minLookAhead, v * g.lookAhead);
    const course = wrap(track + Math.atan2(aside, look));
    // Ground speed → airspeed by the wind the aircraft feels along its track, then calibrated.
    const windAlong = tel.groundSpeed - tel.tas * Math.cos(tel.gamma);
    const air = standardAtmosphere(model.pos.length() - model.radius);
    const least = speedForAlpha(model, 8 * DEG);
    const cas = Math.max(least, calibratedAirspeed(Math.max(0, gs - windAlong), air));

    // Vertical: the reference's climb plus a share of the height error, with speed first: as
    // the airspeed falls short of the command the climb gives way, level at SPEED_MARGIN short.
    // The same in a turn: the bank limit comes down to half, and never beyond the load the
    // airspeed gives at the least speed's angle of attack, n = (cas / least)²; below the least
    // speed the nose goes down to regain it.
    const short = clamp((cas - tel.cas) / SPEED_MARGIN, 0, 1);
    const climb = vUp + g.vertical * below;
    const ceiling = tel.cas < least ? -UNLOAD : g.maxClimb * (1 - short);
    const gamma = clamp(Math.atan2(climb, Math.max(gs, v)), -g.maxDescent, ceiling);
    this.director.fly(
      model,
      {
        course,
        gamma,
        speed: cas,
        maxBank: Math.max(
          MIN_BANK,
          Math.min(g.maxBank * (1 - 0.5 * short), Math.acos(clamp((least / tel.cas) ** 2, 0, 1))),
        ),
        afterburner: behind > g.afterburnerBehind || cas - tel.cas > AB_SHORT,
      },
      ctl,
      dt,
    );
    const s = this.state;
    s.behind = behind;
    s.aside = aside;
    s.below = below;
    s.course = course;
    s.gamma = gamma;
    s.cas = cas;
    return true;
  }
}

/**
 * The analytic pose of a flown aircraft (for the formation's slots around a flown
 * lead): its position, velocity, the nose along its flight path and the top banked
 * by its bank, as `analyticPose` describes a route's lead.
 */
export function poseOfAirframe(model: FlightModel, phase: MissionPhase): AnalyticPose {
  const tel = model.telemetry;
  const up = model.pos.clone().normalize();
  const vel = model.vel;
  const speed = tel.groundSpeed;
  const climb = vel.dot(up);
  const flying = !model.onGround && speed > 1;
  const fwd = flying ? vel.clone().normalize() : model.bodyAxis(0, new Vec3d());
  const top = model.bodyAxis(2, new Vec3d()).scale(-1);
  return {
    pos: [model.pos.x, model.pos.y, model.pos.z],
    forward: [fwd.x, fwd.y, fwd.z],
    up: [top.x, top.y, top.z],
    velocity: [vel.x, vel.y, vel.z],
    heading: flying ? headingOf(up, vel) : tel.heading,
    pitch: tel.gamma,
    bank: tel.bank,
    speed,
    altitude: model.pos.length() - model.radius,
    climb,
    airborne: flying,
    phase,
  };
}
