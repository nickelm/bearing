/**
 * Time acceleration and auto-slowdown on top of a `Simulation` (decision 67).
 * Free of DOM and worker APIs, so tests drive it with any real-time steps;
 * `workers/sim.worker.ts` drives it from a timer.
 */
import type { GameTime, Seconds } from '../core/units';
import type { SimEvent, Simulation } from './simulation';

/** Clock rates offered to the player: paused, then game seconds per real second. */
export const TIME_RATES = [0, 1, 4, 16, 64, 256] as const;

/** Longest real-time step taken at once (s): a stalled tab does not leap ahead. */
export const MAX_REAL_STEP: Seconds = 0.25;

export interface HostStep {
  time: GameTime;
  rate: number;
  /** Flagged events that ran in this step. */
  flagged: SimEvent[];
  /** True if auto-slowdown changed the rate in this step. */
  slowed: boolean;
}

export class SimHost<W extends { readonly sim: Simulation }> {
  /** Game seconds per real second (0 = paused). */
  rate = 0;
  /** Drop to 1× when a flagged event runs. */
  autoSlowdown = true;
  private current: W;

  /** `create()` builds the simulation at campaign start; `seek` back in time rebuilds it. */
  constructor(private readonly create: () => W) {
    this.current = create();
  }

  get world(): W {
    return this.current;
  }

  get time(): GameTime {
    return this.current.sim.time;
  }

  /** Advances by `realDt` real seconds at the current rate. */
  step(realDt: Seconds): HostStep {
    const dt = Math.min(Math.max(realDt, 0), MAX_REAL_STEP);
    const sim = this.current.sim;
    let flagged: SimEvent[] = [];
    let slowed = false;
    if (this.rate > 0 && dt > 0) {
      const r = sim.advanceTo(sim.time + this.rate * dt, this.autoSlowdown);
      flagged = r.flagged;
      if (this.autoSlowdown && flagged.length > 0 && this.rate > 1) {
        this.rate = 1;
        slowed = true;
      }
    }
    return { time: sim.time, rate: this.rate, flagged, slowed };
  }

  /**
   * Jumps to game time `t`. Forward runs every event and tick on the way;
   * backward rebuilds the simulation from campaign start and replays to `t`
   * (deterministic, so the result is what a straight run would reach).
   * Flagged events on the way do not stop a seek.
   */
  seek(t: GameTime): void {
    if (t < this.current.sim.time) this.current = this.create();
    this.current.sim.advanceTo(Math.max(t, this.current.sim.time));
  }
}
