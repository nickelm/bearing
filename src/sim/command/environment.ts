/**
 * What the air tasking order knows of the sky (roadmap R2.1): daylight from the
 * sun's position, which is exact at any time, and the weather as a persistence
 * forecast, the latest hour's fields held for the whole order. A revision sees
 * the newer weather; commitment checks the weather of its hour again.
 *
 * Minimums belong to the mission plug-ins (missions/plugin.ts); this module
 * evaluates them. Without a weather model (tests, a planner run by hand) the
 * sky is clear and calm.
 */
import { sunDirection } from '../../core/calendar';
import type { CampaignCalendar, OrbitParams } from '../../core/calendar';
import { dot } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { DEG, MINUTE } from '../../core/units';
import type { GameTime, Meters } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import type { Wind } from '../weather/frame';
import type { WeatherModel } from '../weather/model';

/** Sky at a place, as far as a planner cares. */
export interface Sky {
  /** Base of a broken or overcast layer above the ground (m), Infinity if none. */
  ceiling: Meters;
  visibility: Meters;
  /** Thunderstorm intensity 0..1. */
  storm: number;
  /** Surface wind speed (m/s). */
  wind: number;
}

/** Weather and light a mission type needs (a plug-in's minimums). */
export interface Minimums {
  /** 'day': time on target with the sun above DAYLIGHT_ELEVATION at the target. */
  daylight: 'day' | 'any';
  /** At the target or station (airlift: the destination). */
  target: { ceiling: Meters; visibility: Meters };
}

/** Least weather at the home base for any takeoff and landing. */
export const BASE_MINIMUMS = { ceiling: 150, visibility: 1600, storm: 0.5, wind: 20 } as const;
/** Helicopters' base minimums. */
export const HELICOPTER_BASE_MINIMUMS = {
  ceiling: 100,
  visibility: 800,
  storm: 0.5,
  wind: 20,
} as const;
/** The sun's elevation above which it is day for planning (civil twilight counts as day). */
export const DAYLIGHT_ELEVATION = -6 * DEG;
/** Step of the daylight search (s). */
export const DAYLIGHT_STEP = 10 * MINUTE;

const CLEAR: Sky = { ceiling: Infinity, visibility: 50e3, storm: 0, wind: 0 };

export class PlanningEnvironment {
  private readonly v = new Vec3d();
  private readonly sun = new Vec3d();

  constructor(
    private readonly weather: WeatherModel | null,
    private readonly orbit: OrbitParams | null,
    private readonly calendar: CampaignCalendar | null,
    /** The time the forecast is taken at (the planning time). */
    public now: GameTime = 0,
  ) {}

  /** Sun elevation at `d` and time `t` (rad); noon everywhere without a calendar. */
  sunElevation(d: Readonly<Dir>, t: GameTime): number {
    if (!this.orbit || !this.calendar) return Math.PI / 2;
    const s = sunDirection(t, this.orbit, this.calendar, this.sun);
    return Math.asin(Math.max(-1, Math.min(1, dot(d, [s.x, s.y, s.z]))));
  }

  isDay(d: Readonly<Dir>, t: GameTime): boolean {
    return this.sunElevation(d, t) >= DAYLIGHT_ELEVATION;
  }

  /**
   * The longest span of day (or of night) at `d` between `from` and `to`, found
   * in DAYLIGHT_STEP steps, or null if there is none.
   */
  window(d: Readonly<Dir>, from: GameTime, to: GameTime, day = true): [GameTime, GameTime] | null {
    let best: [GameTime, GameTime] | null = null;
    let start: GameTime | null = null;
    for (let t = from; ; t = Math.min(to, t + DAYLIGHT_STEP)) {
      const inside = this.isDay(d, t) === day;
      if (inside && start === null) start = t;
      if ((!inside || t >= to) && start !== null) {
        const end = inside ? t : t - DAYLIGHT_STEP / 2;
        if (end > start && (!best || end - start > best[1] - best[0])) best = [start, end];
        start = null;
      }
      if (t >= to) break;
    }
    return best;
  }

  /** The forecast sky at `d`: the weather at the planning time, held. */
  sky(d: Readonly<Dir>): Sky {
    if (!this.weather) return CLEAR;
    const view = this.weather.view();
    if (!view.ready) return CLEAR;
    this.v.set(d[0], d[1], d[2]);
    const r = view.report(this.v, this.now);
    const w = view.wind(this.v, 10, this.now);
    return {
      ceiling: r.ceiling,
      visibility: r.visibility,
      storm: r.storm,
      wind: Math.hypot(w.east, w.north),
    };
  }

  /** The forecast wind at `d` and an altitude above sea level, or null in calm air. */
  windAloft(d: Readonly<Dir>, altitude: Meters, out: Wind = { east: 0, north: 0 }): Wind | null {
    if (!this.weather) return null;
    const view = this.weather.view();
    if (!view.ready) return null;
    this.v.set(d[0], d[1], d[2]);
    return view.wind(this.v, altitude, this.now, out);
  }

  /**
   * Why a mission may not fly to `target` from `base` with time on target
   * `tot` under `min`, or null if it may.
   */
  refusal(
    min: Minimums,
    helicopter: boolean,
    base: Readonly<Dir>,
    target: Readonly<Dir>,
    tot: GameTime,
  ): string | null {
    if (min.daylight === 'day' && !this.isDay(target, tot)) return 'night';
    const b = this.sky(base);
    const bm = helicopter ? HELICOPTER_BASE_MINIMUMS : BASE_MINIMUMS;
    if (b.ceiling < bm.ceiling || b.visibility < bm.visibility) return 'base weather';
    if (b.storm > bm.storm) return 'storm at base';
    if (b.wind > bm.wind) return 'wind at base';
    const s = this.sky(target);
    if (s.ceiling < min.target.ceiling || s.visibility < min.target.visibility) {
      return 'target weather';
    }
    if (s.storm > bm.storm) return 'storm at target';
    return null;
  }
}
