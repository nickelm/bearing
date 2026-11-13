/**
 * Outcomes of a Free Flight sortie (decision 134): liftoff, touchdown with its
 * sink rate, speed and distance from the threshold, a full stop, hard landings
 * and crashes, plus the warnings the HUD shows. A `FlightMonitor` watches the
 * flight model after every step; it may crash the aircraft (a landing above
 * 6 m/s, wheels on open ground) but never moves it.
 */
import { DEG } from '../../core/units';
import type { FlightModel } from './flightModel';
import {
  endFor,
  nearestRunway,
  pastThreshold,
  runwayFrame,
  toRunway,
  TOUCHDOWN_ZONE,
} from './runway';
import type { Runway, RunwayEnd } from './runway';

/** Sink rates (m/s) above which a landing is hard, and a crash. */
export const HARD_LANDING = 3;
export const CRASH_LANDING = 6;
/** Ground speed (m/s) above which leaving the pavement for the graded field is a crash. */
export const EXCURSION_SPEED = 25;

export type LandingGrade = 'smooth' | 'good' | 'firm' | 'hard';

export interface Touchdown {
  time: number;
  /** Sink rate at first contact (m/s, positive down). */
  sinkRate: number;
  /** Calibrated airspeed and ground speed (m/s). */
  speed: number;
  groundSpeed: number;
  runway: Runway | null;
  end: RunwayEnd | null;
  /** Distance past the threshold (m) and from the centerline (m, + right), on a runway. */
  distance: number | null;
  offset: number | null;
  inZone: boolean;
  grade: LandingGrade;
}

export type FlightEvent =
  | { kind: 'liftoff'; time: number; runway: Runway | null }
  | { kind: 'touchdown'; touchdown: Touchdown }
  | { kind: 'stopped'; time: number; runway: Runway | null; landing: Touchdown | null }
  | { kind: 'crash'; time: number; reason: string };

export type FlightWarning = 'gear-speed' | 'stall' | 'pull-up' | 'tail-strike';

/**
 * Tail-strike warning (decision 136): with weight on the wheels, when the pitch
 * half a second ahead (pitch + 0.5 s × pitch rate) passes this; the tail touches
 * near 13.5°. A normal flare or rotation stays under it; a fast rotation past 10°
 * does not.
 */
export const TAIL_WARNING_PITCH = 12.5 * DEG;

export function gradeLanding(sinkRate: number): LandingGrade {
  if (sinkRate < 1) return 'smooth';
  if (sinkRate < 2) return 'good';
  if (sinkRate < HARD_LANDING) return 'firm';
  return 'hard';
}

export class FlightMonitor {
  /** True from liftoff until the next touchdown. */
  airborne = false;
  lastTouchdown: Touchdown | null = null;
  /** Ground speed (m/s) reached since the last stop, to tell a stop from standing. */
  private movedSince = false;
  private airTime = 0;
  private stillTime = 0;
  private lastVs: number | null = null;
  private crashReported = false;
  private stopReported = false;

  constructor(
    private readonly runways: readonly Runway[],
    private readonly radius: number,
  ) {}

  /** Starts over, e.g. after a respawn; `airborne` for an air start. */
  reset(airborne: boolean): void {
    this.airborne = airborne;
    this.lastTouchdown = null;
    this.movedSince = false;
    this.airTime = 0;
    this.stillTime = 0;
    this.lastVs = null;
    this.crashReported = false;
    this.stopReported = false;
  }

  /** Checks the model after a step of `dt` s; returns the events of this step. */
  update(model: FlightModel, dt: number): FlightEvent[] {
    const out: FlightEvent[] = [];
    const t = model.telemetry;
    if (model.crashed) {
      if (!this.crashReported) {
        this.crashReported = true;
        out.push({ kind: 'crash', time: model.time, reason: model.crashed });
      }
      return out;
    }
    const loaded = model.wheels.filter((w) => w.load > 0);
    const onGround = loaded.length > 0;
    if (!onGround) {
      this.lastVs = t.verticalSpeed;
      this.airTime += dt;
      if (!this.airborne && this.airTime > 0.5 && t.radarAltitude > 1) {
        this.airborne = true;
        this.stopReported = false;
        out.push({ kind: 'liftoff', time: model.time, runway: this.runwayUnder(model) });
      }
    } else {
      this.airTime = 0;
      if (this.airborne) {
        this.airborne = false;
        const td = this.touchdown(model, -(this.lastVs ?? t.verticalSpeed));
        this.lastTouchdown = td;
        this.stopReported = false;
        out.push({ kind: 'touchdown', touchdown: td });
        if (td.sinkRate > CRASH_LANDING) {
          model.crash(`Crashed on landing: sink rate ${td.sinkRate.toFixed(1)} m/s`);
        } else if (loaded.some((w) => w.surface === 'land')) {
          model.crash('Touched down away from a runway');
        }
      } else if (loaded.some((w) => w.surface === 'land') && t.groundSpeed > 2) {
        model.crash('Ran off the paved field');
      } else if (loaded.some((w) => w.surface === 'field') && t.groundSpeed > EXCURSION_SPEED) {
        model.crash('Ran off the runway');
      }
      if (model.crashed) {
        this.crashReported = true;
        out.push({ kind: 'crash', time: model.time, reason: model.crashed });
        return out;
      }
    }
    if (t.groundSpeed > 15) this.movedSince = true;
    if (onGround && t.groundSpeed < 0.5) this.stillTime += dt;
    else this.stillTime = 0;
    if (this.movedSince && !this.stopReported && this.stillTime > 1) {
      this.stopReported = true;
      this.movedSince = false;
      out.push({
        kind: 'stopped',
        time: model.time,
        runway: this.runwayUnder(model),
        landing: this.lastTouchdown,
      });
    }
    return out;
  }

  /** The runway under the aircraft (on its pavement or overruns), or null. */
  runwayUnder(model: FlightModel): Runway | null {
    const n = nearestRunway(this.runways, model.pos.clone().normalize(), this.radius);
    if (!n || n.distance > n.runway.length) return null;
    const c = toRunway(n.runway, runwayFrame(n.runway), model.pos, this.radius);
    return Math.abs(c.along) <= n.runway.length / 2 + 200 && Math.abs(c.across) <= 40
      ? n.runway
      : null;
  }

  private touchdown(model: FlightModel, sinkRate: number): Touchdown {
    const t = model.telemetry;
    const runway = this.runwayUnder(model);
    let end: RunwayEnd | null = null;
    let distance: number | null = null;
    let offset: number | null = null;
    if (runway) {
      end = endFor(runway, t.heading);
      const c = toRunway(runway, runwayFrame(runway), model.pos, this.radius);
      distance = pastThreshold(end, c.along);
      offset = c.across * end.sign;
    }
    const inZone =
      distance !== null && distance >= TOUCHDOWN_ZONE[0] && distance <= TOUCHDOWN_ZONE[1];
    return {
      time: model.time,
      sinkRate,
      speed: t.cas,
      groundSpeed: t.groundSpeed,
      runway,
      end,
      distance,
      offset,
      inZone,
      grade: gradeLanding(sinkRate),
    };
  }
}

/** The warnings that apply now. */
export function flightWarnings(model: FlightModel): FlightWarning[] {
  const t = model.telemetry;
  const out: FlightWarning[] = [];
  if (model.crashed) return out;
  if (model.gear > 0.01 && t.cas > model.spec.gear.maxSpeed) out.push('gear-speed');
  if (model.onGround && t.pitch + 0.5 * model.omega.y > TAIL_WARNING_PITCH) out.push('tail-strike');
  const airborne = !model.onGround && t.radarAltitude > 3;
  if (airborne && t.alpha > model.spec.controls.maxAlpha - 1.5 * DEG && t.cas < 100)
    out.push('stall');
  // Pull up: under 5 s to ground impact at the present sink rate, low, not landing.
  const sink = -t.verticalSpeed;
  const landing = model.gear > 0.99 && sink < 8;
  if (airborne && sink > 1 && t.radarAltitude / sink < 5 && t.radarAltitude < 600 && !landing)
    out.push('pull-up');
  return out;
}
