/**
 * The helicopters' flight director (Proposal 0004, Controls and Assists; rule 12;
 * roadmap R2.9): the rotary-wing side of the one director interface
 * (director.ts). It turns a `DirectorTarget` into a `HeloDirective` (a ground
 * velocity, a heading, a climb rate, whether to land) and hands it to the
 * helicopter's control layer, `HeloLaws.direct`, which flies it with the inner
 * loops the player's commands use. The AI pilot (heloPilot.ts), scripted tests
 * and later mouse aim fly helicopters through it; nothing here moves the
 * aircraft but the flight model.
 *
 * How it reads the target, in order of precedence:
 *
 * - **Horizontal.** A `hoverPoint` is flown to and held: toward it at the least of
 *   the speed limit (`speed`, or MAX_POINT_SPEED), the speed from which HOVER_DECEL
 *   stops it in the distance left, √(2·a·d), and POINT_GAIN times the distance,
 *   which the hover's velocity loop then damps (any `groundVelocity` adds its
 *   horizontal part, a moving point). Otherwise a `groundVelocity` is flown as it
 *   is; otherwise `course` at `speed` along `gamma`. The rotary director reads
 *   `speed` as the speed over the ground along the course: helicopters fly low
 *   and slow, where calibrated and true airspeed differ by a few percent, and the
 *   route the AI follows is a ground track.
 * - **Vertical.** A `height` is held by altitude above sea level or by radar
 *   altitude, at ALT_GAIN per meter with the ground velocity's `up` as feed-forward;
 *   a radar height of 0 or less lands: the climb rate is LAND_SINK down (the
 *   landing aid eases it near the ground) and on contact the collective goes down.
 *   Without a height the ground velocity's `up`, or `speed · sin(gamma)`.
 * - **Heading.** `heading` turns the nose in the hover's regime (pedal turns, a
 *   landing into the wind); at speed the nose follows the turn.
 */
import { Vec3d } from '../../../core/vec3d';
import type { Director, DirectorTarget } from '../director';
import { eastNorth } from '../runway';
import { assistsFor } from './assists';
import type { Assists } from './assists';
import { HeloLaws } from './heloLaws';
import type { HeloDirective } from './heloLaws';
import type { RotorControls, RotorcraftModel } from './rotorcraftModel';

/** Deceleration toward a hover point (m/s²): from 60 m/s it stops in 2 km. */
export const HOVER_DECEL = 0.9;
/** Speed per meter of distance to a hover point near it (1/s). */
export const POINT_GAIN = 0.4;
/** Most speed toward a hover point without a speed limit (m/s). */
export const MAX_POINT_SPEED = 60;
/** Climb rate per meter of height error (1/s). */
export const ALT_GAIN = 0.5;
/** Sink asked for when landing (m/s); the landing aid eases it to 0.5 m/s near the ground. */
export const LAND_SINK = 1.0;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export class HeloDirector implements Director<RotorcraftModel, RotorControls> {
  readonly laws = new HeloLaws();
  /** The assists it flies with: the AI flies with protection on (decision 149). */
  assists: Assists = assistsFor('assisted');
  /** The directive of the last step, for tools and the HUD. */
  readonly last: HeloDirective = {
    velocity: new Vec3d(),
    heading: null,
    climbRate: 0,
    land: false,
  };
  private primed = false;

  /** Forgets the laws' integrators and holds: they start again from the next step's state. */
  reset(): void {
    this.primed = false;
  }

  /**
   * Starts the laws now from the helicopter's state, `grounded` saying whether it stands on
   * its gear: before its first step the gear carries no load, so the next step's own start
   * would take a helicopter on the ground for one in the air and lift it off (R2.9's review).
   */
  start(m: RotorcraftModel, grounded: boolean): void {
    this.laws.reset(m, grounded);
    this.primed = true;
  }

  fly(m: RotorcraftModel, target: Readonly<DirectorTarget>, ctl: RotorControls, dt: number): void {
    if (!this.primed) {
      this.laws.reset(m);
      this.primed = true;
    }
    this.directive(m, target, this.last);
    this.laws.direct(m, this.last, this.assists, dt, ctl);
  }

  /** The directive for `target` at the helicopter's present state, into `out`. */
  directive(
    m: RotorcraftModel,
    target: Readonly<DirectorTarget>,
    out: HeloDirective,
  ): HeloDirective {
    const tel = m.telemetry;
    const up = m.pos.clone().normalize();
    const { east, north } = eastNorth(up);
    const v = (out.velocity as Vec3d).set(0, 0, 0);
    const gv = target.groundVelocity;
    let climb: number;
    if (target.hoverPoint) {
      const d = target.hoverPoint.clone().sub(m.pos);
      d.addScaled(up, -d.dot(up));
      const dist = d.length();
      const most = target.speed ?? MAX_POINT_SPEED;
      const speed = Math.min(most, Math.sqrt(2 * HOVER_DECEL * dist), POINT_GAIN * dist);
      if (dist > 1e-6) v.addScaled(d, speed / dist);
      if (gv) v.addScaled(north, gv.north).addScaled(east, gv.east);
      climb = gv?.up ?? 0;
    } else if (gv) {
      v.addScaled(north, gv.north).addScaled(east, gv.east);
      climb = gv.up;
    } else {
      const speed = target.speed ?? tel.groundSpeed;
      const h = speed * Math.cos(target.gamma);
      v.addScaled(north, h * Math.cos(target.course)).addScaled(east, h * Math.sin(target.course));
      climb = speed * Math.sin(target.gamma);
    }
    out.land = false;
    if (target.height) {
      const hh = target.height;
      if (hh.reference === 'radar' && hh.value <= 0) {
        out.land = true;
        climb = -LAND_SINK;
      } else {
        const now = hh.reference === 'radar' ? tel.radarAltitude : tel.altitude;
        const most = m.spec.controls.maxClimbRate;
        climb = clamp((gv?.up ?? 0) + ALT_GAIN * (hh.value - now), -most, most);
      }
    }
    out.climbRate = climb;
    out.heading = target.heading ?? null;
    return out;
  }
}
