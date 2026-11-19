/**
 * Time acceleration, auto-slowdown, player inputs and seeking on top of a
 * `Simulation` (decision 67; R1.2). Free of DOM and worker APIs, so tests drive
 * it with any real-time steps; `workers/sim.worker.ts` drives it from a timer.
 *
 * - **Inputs.** Player inputs to the campaign go through `input()`: the host
 *   records them in the simulation's event log and keeps them on its own
 *   timeline, so it can apply them again after restoring a saved state.
 * - **Checkpoints.** The host saves the simulation at campaign start and
 *   whenever the clock reaches a multiple of CHECKPOINT_PERIOD, keeping at
 *   most MAX_CHECKPOINTS (older ones thinned, the start always kept).
 * - **Seeking back** restores the latest checkpoint at or before the target
 *   and replays the timeline's inputs from there. A seek moves along one
 *   timeline and does not branch it: inputs made after the target stay on the
 *   timeline and apply again when the clock passes their time. An input made
 *   after a backward seek joins the timeline in time order and drops the
 *   checkpoints after it, which no longer describe the future.
 */
import type { GameTime, Seconds } from '../core/units';
import { HOUR } from '../core/units';
import type { CampaignInputEvent } from './eventLog';
import type { SimEvent, SimState, Simulation } from './simulation';

/** Clock rates offered to the player: paused, then game seconds per real second. */
export const TIME_RATES = [0, 1, 4, 16, 64, 256] as const;

/** Longest real-time step taken at once (s): a stalled tab does not leap ahead. */
export const MAX_REAL_STEP: Seconds = 0.25;

/** Game time between checkpoints. */
export const CHECKPOINT_PERIOD: Seconds = 6 * HOUR;

/** Checkpoints kept; beyond this, every second one after the start is dropped. */
export const MAX_CHECKPOINTS = 64;

export interface HostStep {
  time: GameTime;
  rate: number;
  /** Flagged events that ran in this step. */
  flagged: SimEvent[];
  /** True if auto-slowdown changed the rate in this step. */
  slowed: boolean;
}

/** A player input on the host's timeline. */
interface TimedInput {
  time: GameTime;
  input: CampaignInputEvent;
}

interface Checkpoint {
  time: GameTime;
  /** Timeline inputs applied when it was taken. */
  inputs: number;
  state: SimState;
}

/** A whole campaign as the host holds it: the simulation's state and the input timeline. */
export interface HostState {
  sim: SimState;
  /** Every input on the timeline, applied or not, in time order. */
  inputs: TimedInput[];
  /** How many of them the saved state has applied. */
  applied: number;
}

/** Applies a player input to a world. */
export type InputHandler<W> = (world: W, input: CampaignInputEvent) => void;

export class SimHost<W extends { readonly sim: Simulation }> {
  /** Game seconds per real second (0 = paused). */
  rate = 0;
  /** Drop to 1× when a flagged event runs. */
  autoSlowdown = true;
  private current: W;
  private timeline: TimedInput[] = [];
  /** Timeline inputs applied to the current world. */
  private applied = 0;
  private checkpoints: Checkpoint[] = [];

  /**
   * `create()` builds the world at campaign start (and the empty world a
   * saved state loads into); `apply` carries out a player input.
   */
  constructor(
    private readonly create: () => W,
    private readonly apply: InputHandler<W> = () => {},
  ) {
    this.current = create();
    this.checkpoint();
  }

  get world(): W {
    return this.current;
  }

  get time(): GameTime {
    return this.current.sim.time;
  }

  /** Checkpoint times, oldest first (for tests and the debug panel). */
  get checkpointTimes(): GameTime[] {
    return this.checkpoints.map((c) => c.time);
  }

  /** Advances by `realDt` real seconds at the current rate. */
  step(realDt: Seconds): HostStep {
    const dt = Math.min(Math.max(realDt, 0), MAX_REAL_STEP);
    const sim = this.current.sim;
    let flagged: SimEvent[] = [];
    let slowed = false;
    if (this.rate > 0 && dt > 0) {
      flagged = this.advance(sim.time + this.rate * dt, this.autoSlowdown);
      if (this.autoSlowdown && flagged.length > 0 && this.rate > 1) {
        this.rate = 1;
        slowed = true;
      }
    }
    return { time: sim.time, rate: this.rate, flagged, slowed };
  }

  /** A player input now: logged, applied, and kept for replay. */
  input(input: CampaignInputEvent): void {
    const time = this.time;
    // Inputs after this one on the timeline (left by a backward seek) stay after it.
    this.timeline.splice(this.applied, 0, { time, input });
    this.checkpoints = this.checkpoints.filter((c) => c.time <= time && c.inputs <= this.applied);
    this.applyNext();
  }

  /**
   * Jumps to game time `t`. Forward runs every event, tick and timeline input
   * on the way; backward restores the latest checkpoint at or before `t` and
   * replays from there. Flagged events on the way do not stop a seek.
   */
  seek(t: GameTime): void {
    if (t < this.time) {
      let cp = this.checkpoints[0]!;
      for (const c of this.checkpoints) if (c.time <= t) cp = c;
      this.restore(cp.state, cp.inputs);
    }
    this.advance(Math.max(t, this.time), false);
  }

  /** The whole campaign, for saving (R5) or comparing; independent of the live one. */
  save(): HostState {
    return {
      sim: this.current.sim.save(),
      inputs: structuredClone(this.timeline),
      applied: this.applied,
    };
  }

  /** Replaces the campaign with a saved one; its checkpoints start from the saved time, so seeks stop there. */
  load(state: HostState): void {
    this.timeline = structuredClone(state.inputs);
    this.checkpoints = [];
    this.restore(state.sim, state.applied);
    this.checkpoint();
  }

  /** Runs to `target`, applying timeline inputs at their times and taking checkpoints. */
  private advance(target: GameTime, stopOnFlag: boolean): SimEvent[] {
    const flagged: SimEvent[] = [];
    for (;;) {
      const sim = this.current.sim;
      const nextInput = this.timeline[this.applied]?.time ?? Infinity;
      const last = this.checkpoints[this.checkpoints.length - 1]!.time;
      const nextCheckpoint = (Math.floor(last / CHECKPOINT_PERIOD) + 1) * CHECKPOINT_PERIOD;
      const to = Math.min(target, nextInput, nextCheckpoint);
      const r = sim.advanceTo(Math.max(to, sim.time), stopOnFlag);
      flagged.push(...r.flagged);
      if (r.stopped) return flagged;
      if (sim.time === nextInput) {
        while (this.timeline[this.applied]?.time === sim.time) this.applyNext();
      }
      if (sim.time >= nextCheckpoint) this.checkpoint();
      if (sim.time >= target && (this.timeline[this.applied]?.time ?? Infinity) > target) {
        return flagged;
      }
    }
  }

  private applyNext(): void {
    const { time, input } = this.timeline[this.applied]!;
    this.current.sim.log.input(time, input);
    this.apply(this.current, input);
    this.applied++;
  }

  private restore(state: SimState, applied: number): void {
    const w = this.create();
    w.sim.load(state);
    this.current = w;
    this.applied = applied;
  }

  private checkpoint(): void {
    const time = this.time;
    if (
      this.checkpoints.length > 0 &&
      this.checkpoints[this.checkpoints.length - 1]!.time >= time
    ) {
      return;
    }
    this.checkpoints.push({ time, inputs: this.applied, state: this.current.sim.save() });
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.checkpoints = this.checkpoints.filter((_, i) => i === 0 || i % 2 === 1);
    }
  }
}
