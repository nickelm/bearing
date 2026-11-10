/**
 * The simulation core (decision 67): one float64 game clock, a discrete-event
 * queue and fixed-tick processes, interleaved in time order.
 *
 * - **Events** are data, not closures: a kind, an optional structured-cloneable
 *   payload and an optional flag. Handlers are registered per kind, so pending
 *   events can be hashed, inspected and later saved.
 * - **Processes** tick at a fixed period of game time (weather hourly, ground
 *   combat each game minute from milestone 8). A tick is an entry in the same
 *   queue as the events, so ticks and events interleave exactly by time. Tick
 *   times are `offset + k · period` for integer k, so they never drift.
 * - **Order** at equal times: ticks before events, processes in registration
 *   order, events in scheduling order (see `EventQueue`).
 * - **Acceleration** only changes how far `advanceTo` goes per real second.
 *   Every entry runs at its own time, and nothing reads the size of the step,
 *   so the state at a given game time is the same at 1× and 256×.
 * - **Flags.** An event with a flag (a label for the player) can stop
 *   `advanceTo` right after it runs; the host then drops to 1× (auto-slowdown).
 */
import type { GameTime, Seconds } from '../core/units';
import { EventQueue } from './scheduler';
import { StateHasher } from './stateHash';

/** A scheduled event as handlers and observers see it. */
export interface SimEvent {
  readonly time: GameTime;
  readonly kind: string;
  readonly data?: unknown;
  /** Label shown to the player; flagged events can trigger auto-slowdown. */
  readonly flag?: string;
  /** Queue sequence number (unique per simulation). */
  readonly seq: number;
}

/** A process stepped at a fixed period of game time. */
export interface TickProcess {
  readonly name: string;
  readonly period: Seconds;
  /** Tick times are offset + k · period (default 0). */
  readonly offset?: Seconds;
  /** Runs the tick at game time `t` (= offset + k · period). */
  step(t: GameTime, k: number, sim: Simulation): void;
  /** Adds the process state to a determinism hash. */
  hash?(h: StateHasher): void;
}

export type EventHandler = (event: SimEvent, sim: Simulation) => void;

export interface ScheduleOptions {
  flag?: string;
  /** Among events at the same time, lower runs first (default 0; ticks always run first). */
  priority?: number;
}

export interface AdvanceResult {
  /** Flagged events that ran during this advance. */
  flagged: SimEvent[];
  /** True if the advance stopped early at a flagged event. */
  stopped: boolean;
}

type Entry =
  | { type: 'tick'; process: number; k: number }
  | { type: 'event'; kind: string; data?: unknown; flag?: string };

/** Ticks sort before events at the same time: priorities below EVENT_PRIORITY_BASE. */
const EVENT_PRIORITY_BASE = 1_000_000;

export class Simulation {
  private clock: GameTime;
  private readonly queue = new EventQueue<Entry>();
  private readonly processes: TickProcess[] = [];
  private readonly handlers = new Map<string, EventHandler>();
  private eventsRun = 0;
  private ticksRun = 0;

  constructor(startTime: GameTime = 0) {
    this.clock = startTime;
  }

  /** Current game time. During a handler or tick, the time of that entry. */
  get time(): GameTime {
    return this.clock;
  }

  get stats(): { events: number; ticks: number; pending: number } {
    return { events: this.eventsRun, ticks: this.ticksRun, pending: this.queue.size };
  }

  /** Registers a fixed-tick process. Its first tick is the first tick time at or after now. */
  addProcess(p: TickProcess): void {
    if (!(p.period > 0)) throw new RangeError(`Process ${p.name} needs a positive period`);
    const index = this.processes.length;
    this.processes.push(p);
    const offset = p.offset ?? 0;
    const k = Math.ceil((this.clock - offset) / p.period);
    this.queue.push(offset + k * p.period, index, { type: 'tick', process: index, k });
  }

  /** Registers the handler for an event kind (one per kind). */
  on(kind: string, handler: EventHandler): void {
    if (this.handlers.has(kind)) throw new Error(`A handler for "${kind}" already exists`);
    this.handlers.set(kind, handler);
  }

  /** Schedules an event at game time `time` (not before now) and returns its id. */
  schedule(time: GameTime, kind: string, data?: unknown, options: ScheduleOptions = {}): number {
    if (time < this.clock) {
      throw new RangeError(`Cannot schedule "${kind}" at ${time}, before now (${this.clock})`);
    }
    const priority = EVENT_PRIORITY_BASE + (options.priority ?? 0);
    return this.queue.push(time, priority, { type: 'event', kind, data, flag: options.flag });
  }

  cancel(id: number): void {
    this.queue.cancel(id);
  }

  /** Game time of the next entry, or Infinity. */
  nextTime(): GameTime {
    return this.queue.peek()?.time ?? Infinity;
  }

  /**
   * Runs every entry with time ≤ `target` in order and sets the clock to
   * `target`. With `stopOnFlag`, returns right after the first flagged event,
   * with the clock at that event's time.
   */
  advanceTo(target: GameTime, stopOnFlag = false): AdvanceResult {
    if (target < this.clock) throw new RangeError(`Cannot go back from ${this.clock} to ${target}`);
    const flagged: SimEvent[] = [];
    for (;;) {
      const next = this.queue.peek();
      if (!next || next.time > target) break;
      this.queue.pop();
      this.clock = next.time;
      const e = next.item;
      if (e.type === 'tick') {
        const p = this.processes[e.process]!;
        p.step(next.time, e.k, this);
        this.ticksRun++;
        const k = e.k + 1;
        this.queue.push((p.offset ?? 0) + k * p.period, e.process, { ...e, k });
      } else {
        const event: SimEvent = {
          time: next.time,
          kind: e.kind,
          data: e.data,
          flag: e.flag,
          seq: next.seq,
        };
        this.handlers.get(e.kind)?.(event, this);
        this.eventsRun++;
        if (e.flag !== undefined) {
          flagged.push(event);
          if (stopOnFlag) return { flagged, stopped: true };
        }
      }
    }
    this.clock = target;
    return { flagged, stopped: false };
  }

  /** Hash of the clock, the counters, pending events and every process's state. */
  hash(): string {
    const h = new StateHasher();
    h.number(this.clock).number(this.eventsRun).number(this.ticksRun);
    for (const e of this.queue.entries()) {
      h.number(e.time).number(e.priority).number(e.seq);
      if (e.item.type === 'tick') h.string(this.processes[e.item.process]!.name).number(e.item.k);
      else h.string(e.item.kind).string(JSON.stringify(e.item.data ?? null));
    }
    for (const p of this.processes) {
      h.string(p.name);
      p.hash?.(h);
    }
    return h.digest();
  }
}
