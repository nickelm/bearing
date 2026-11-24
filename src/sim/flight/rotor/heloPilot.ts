/**
 * The AI helicopter pilot (roadmap R2.9; rule 12): flies a `RotorcraftModel`
 * through the rotary director (heloDirector.ts) and the Assisted laws, as the
 * player would fly it, with nothing moving the aircraft but the flight model.
 *
 * Its orders are a reference (the mission's analytic route, as aiPilot.ts's:
 * where the route says the helicopter should be at a game time) and, when the
 * mission calls for it, a landing task: a point on the ground, the heading to
 * land on, and how long to wait there. A small state machine flies them:
 *
 * - **track**: route following. The ground velocity is the reference's plus
 *   TRACK_GAIN times the horizontal distance to it (within the type's cruise
 *   limit); the altitude is the reference's, held at least TRACK_FLOOR above
 *   the ground under it and, with a `ground` to look at, above the ground up to
 *   25 s ahead (LOOK_TIMES), slowing where it could not climb in time. On the ground at the start with the reference still standing
 *   there, it waits on its gear; once the reference moves off, it takes off.
 * - **approach**: within APPROACH_RANGE of the landing point, a straight
 *   approach to it: the hover point's deceleration profile brings the speed down
 *   (from 60 m/s in 2 km), and the height comes down the APPROACH_ANGLE path to
 *   HOVER_HEIGHT over the point; inside HEADING_RANGE the nose turns to the
 *   landing heading.
 * - **hover** over the point at HOVER_HEIGHT until it has settled (HOVER_SETTLE),
 *   then **land**: down at the director's landing sink, which the landing aid
 *   eases to 0.5 m/s near the ground; on contact the collective goes down.
 * - **wait** on the gear until the task's `waitUntil` or `go()`.
 * - **takeoff**: straight up to TAKEOFF_HEIGHT over the spot, then **track**
 *   again, the landing task done.
 *
 * Deterministic: no random numbers; the same state and orders give the same
 * controls.
 */
import type { GameTime, Meters } from '../../../core/units';
import { DEG } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import type { Reference } from '../aiPilot';
import type { DirectorTarget } from '../director';
import type { GroundQuery } from '../contact';
import { HeloDirector } from './heloDirector';
import type { RotorControls, RotorcraftModel } from './rotorcraftModel';

export type HeloPilotState = 'track' | 'approach' | 'hover' | 'land' | 'wait' | 'takeoff';

/** Where and how to land. */
export interface LandingTask {
  /** The spot on the ground (planet-centered m): its height is the ground's there. */
  point: Readonly<Vec3d>;
  /** The heading to land on (rad, clockwise from north): into the wind. */
  heading: number;
  /** Game time to lift off again; absent: wait for `go()`. */
  waitUntil?: GameTime;
}

/** Ground speed per meter of horizontal distance to the route's point (1/s). */
export const TRACK_GAIN = 0.08;
/** Least height over the ground while tracking (m). */
export const TRACK_FLOOR: Meters = 30;
/** Distance to the landing point at which the approach starts (m). */
export const APPROACH_RANGE: Meters = 2000;
/** The approach path's angle above the point. */
export const APPROACH_ANGLE = 7 * DEG;
/** Height of the hover over the point before the landing (m), and the floor down the path until close. */
export const HOVER_HEIGHT: Meters = 10;
const APPROACH_FLOOR: Meters = 15;
/** Inside this the nose turns to the landing heading (m). */
export const HEADING_RANGE: Meters = 150;
/** Seconds the hover settles over the point before the landing, and the most it waits. */
export const HOVER_SETTLE = 4;
const HOVER_MOST = 15;
/** Height of the vertical takeoff before tracking again (m). */
export const TAKEOFF_HEIGHT: Meters = 20;
/** The reference counts as standing still under this ground speed (m/s). */
const STILL = 3;

export interface Touchdown {
  time: GameTime;
  /** Sink rate at contact (m/s) and the horizontal miss from the landing point (m). */
  sink: number;
  miss: Meters;
}

/** Seconds ahead along its way at which the tracking pilot looks at the ground (R2.9's review). */
export const LOOK_TIMES = [2, 4, 7, 10, 14, 19, 25] as const;

export class HeloPilot {
  readonly director = new HeloDirector();
  /** The ground it looks ahead over while tracking (with obstacles: buttes, pillars); null: none. */
  ground: GroundQuery | null = null;
  state: HeloPilotState = 'track';
  /** The landing task, until its takeoff is done. */
  landing: LandingTask | null = null;
  /** The last landing's touchdown. */
  touchdown: Touchdown | null = null;
  /** The target given to the director this step. */
  readonly target: DirectorTarget = { course: 0, gamma: 0, speed: null };
  private since = 0;
  private released = false;
  private readonly spot = new Vec3d();
  private lastSink = 0;
  private approachTop = 0;

  constructor(public reference: Reference) {}

  /** Gives it a landing task; it flies the approach once within APPROACH_RANGE. */
  land(task: LandingTask): void {
    this.landing = task;
    this.released = false;
    this.touchdown = null;
  }

  /** Lets it take off from the wait. */
  go(): void {
    this.released = true;
  }

  /** Drops the landing task: from the air it tracks again; on the ground it takes off. */
  cancelLanding(): void {
    this.landing = null;
    if (this.state === 'wait' || this.state === 'land') this.released = true;
    else if (this.state !== 'takeoff') this.state = 'track';
  }

  /** Forgets the director's state (a handback, a respawn). */
  reset(): void {
    this.director.reset();
  }

  /** Horizontal distance to the landing point (m), or Infinity without a task. */
  distanceToLanding(m: Readonly<RotorcraftModel>): Meters {
    if (!this.landing) return Infinity;
    return horizontal(this.landing.point, m.pos).length();
  }

  /** Decides this step's target at game time t and flies it into `ctl`. */
  step(m: RotorcraftModel, t: GameTime, ctl: RotorControls, dt: number): void {
    this.decide(m, t);
    this.director.fly(m, this.target, ctl, dt);
    this.lastSink = -m.telemetry.verticalSpeed;
  }

  private set(state: HeloPilotState, t: GameTime): void {
    this.state = state;
    this.since = t;
  }

  private decide(m: RotorcraftModel, t: GameTime): void {
    const tel = m.telemetry;
    const g = this.target;
    g.hoverPoint = undefined;
    g.groundVelocity = undefined;
    g.heading = undefined;
    g.height = undefined;
    g.speed = null;
    const task = this.landing;
    const ground = tel.altitude - tel.radarAltitude;
    const landed = m.onGround && this.director.laws.landed;

    if (this.state === 'track' && task && this.distanceToLanding(m) < APPROACH_RANGE) {
      this.set('approach', t);
      this.approachTop = Math.max(HOVER_HEIGHT, tel.altitude - altitudeOf(task.point, m.radius));
    }
    switch (this.state) {
      case 'track': {
        const ref = this.reference(t);
        if (!ref) {
          this.hold(m, m.pos, landed ? 0 : Math.max(tel.radarAltitude, TRACK_FLOOR), 'radar');
          return;
        }
        const up = m.pos.clone().normalize();
        const err = horizontal(ref.pos, m.pos);
        const refH = ref.vel.clone().addScaled(up, -ref.vel.dot(up));
        // On the ground with the route still standing there: wait on the gear. The laws'
        // landed state, not the gear's load, which is none before the first step.
        if (this.director.laws.landed && refH.length() < STILL && err.length() < 200) {
          this.hold(m, m.pos, 0, 'radar');
          return;
        }
        if (landed) {
          this.spot.copy(m.pos);
          this.set('takeoff', t);
          this.decide(m, t);
          return;
        }
        const v = refH.addScaled(err, TRACK_GAIN);
        const most = 0.8 * m.spec.limits.vne;
        if (v.length() > most) v.scale(most / v.length());
        let want = Math.max(altitudeOf(ref.pos, m.radius), ground + TRACK_FLOOR);
        // Terrain ahead: climb early for rising ground (a butte, a ridge) within LOOK_AHEAD
        // seconds on the way it flies, and slow down where the climb could not make it.
        if (this.ground && v.length() > 5) {
          const rate = 0.8 * m.spec.controls.maxClimbRate;
          let slow = 1;
          const p = new Vec3d();
          for (const tau of LOOK_TIMES) {
            p.copy(m.pos).addScaled(v, tau).normalize();
            const need = this.ground.height(p) + TRACK_FLOOR;
            want = Math.max(want, need);
            const climb = need - tel.altitude;
            if (climb > rate * tau) slow = Math.min(slow, Math.max(0.25, (rate * tau) / climb));
          }
          v.scale(slow);
        }
        this.velocity(m, v, ref.vel.dot(up));
        g.height = { reference: 'altitude', value: want };
        return;
      }
      case 'approach': {
        const p = task!.point;
        const d = this.distanceToLanding(m);
        const lz = altitudeOf(p, m.radius);
        const path = Math.min(
          this.approachTop,
          Math.max(HOVER_HEIGHT, d * Math.tan(APPROACH_ANGLE)),
        );
        g.hoverPoint = p;
        // Down the path, but not into rising ground short of the point.
        const floor = d > 300 ? ground + APPROACH_FLOOR : -Infinity;
        g.height = { reference: 'altitude', value: Math.max(lz + path, floor) };
        if (d < HEADING_RANGE) g.heading = task!.heading;
        if (d < 4 && tel.groundSpeed < 2 && Math.abs(tel.altitude - lz - HOVER_HEIGHT) < 3)
          this.set('hover', t);
        return;
      }
      case 'hover': {
        const p = task!.point;
        g.hoverPoint = p;
        g.heading = task!.heading;
        g.height = { reference: 'altitude', value: altitudeOf(p, m.radius) + HOVER_HEIGHT };
        const settled = this.distanceToLanding(m) < 2 && tel.groundSpeed < 0.7;
        if ((t - this.since > HOVER_SETTLE && settled) || t - this.since > HOVER_MOST)
          this.set('land', t);
        return;
      }
      case 'land': {
        const p = task!.point;
        g.hoverPoint = p;
        g.heading = task!.heading;
        g.height = { reference: 'radar', value: 0 };
        if (m.onGround && !this.touchdown) {
          this.touchdown = { time: t, sink: this.lastSink, miss: this.distanceToLanding(m) };
        }
        if (landed) this.set('wait', t);
        if (this.released) this.takeOff(m, t);
        return;
      }
      case 'wait': {
        this.hold(m, m.pos, 0, 'radar');
        const until = task?.waitUntil;
        if (this.released || (until !== undefined && t >= until) || !task) this.takeOff(m, t);
        return;
      }
      case 'takeoff': {
        this.hold(m, this.spot, TAKEOFF_HEIGHT, 'radar');
        if (tel.radarAltitude > TAKEOFF_HEIGHT - 5) {
          this.landing = null;
          this.released = false;
          this.set('track', t);
        }
        return;
      }
    }
  }

  private takeOff(m: RotorcraftModel, t: GameTime): void {
    this.spot.copy(m.pos);
    this.set('takeoff', t);
    this.hold(m, this.spot, TAKEOFF_HEIGHT, 'radar');
  }

  /** Holds a point at a height (0 by radar: on the ground). */
  private hold(
    m: RotorcraftModel,
    point: Readonly<Vec3d>,
    height: number,
    reference: 'radar' | 'altitude',
  ): void {
    const g = this.target;
    g.hoverPoint = point.clone();
    g.height = { reference, value: height };
    g.heading = this.landing && this.state !== 'track' ? this.landing.heading : m.telemetry.heading;
  }

  /** A horizontal world velocity as the director's ground velocity. */
  private velocity(m: RotorcraftModel, v: Readonly<Vec3d>, up: number): void {
    const u = m.pos.clone().normalize();
    const east = new Vec3d(0, 1, 0).cross(u);
    if (east.length() < 1e-9) east.set(1, 0, 0);
    east.normalize();
    const north = u.clone().cross(east);
    this.target.groundVelocity = { north: v.dot(north), east: v.dot(east), up };
  }
}

/** The horizontal part of `to − from` at `from` (m). */
function horizontal(to: Readonly<Vec3d>, from: Readonly<Vec3d>): Vec3d {
  const up = from.clone().normalize();
  const d = to.clone().sub(from);
  return d.addScaled(up, -d.dot(up));
}

/** Altitude above sea level (m) of a planet-centered point. */
function altitudeOf(p: Readonly<Vec3d>, radius: Meters): number {
  return p.length() - radius;
}
