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
 * - **Saving** (R1.2): `save()` returns the whole state as structured-cloneable
 *   data (clock, counters, pending entries with their sequence numbers, every
 *   stateful part and the event log), and `load()` puts it into a simulation
 *   built from the same configuration. Handlers and processes are code, so
 *   they are registered again by building the world, never saved.
 */
import type { GameTime, Seconds } from '../core/units';
import { EventLog } from './eventLog';
import type { LogEntry } from './eventLog';
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

/** Part of the sim's state that can be saved and restored (R1.2). */
export interface Stateful {
  /** The part's mutable state as structured-cloneable data. */
  save(): unknown;
  /** Restores a state `save()` returned, into a part built from the same configuration. */
  load(state: unknown): void;
  /** Adds the part's state to a determinism hash (processes hash through TickProcess.hash). */
  hash?(h: StateHasher): void;
}

/** A process stepped at a fixed period of game time. */
export interface TickProcess extends Partial<Stateful> {
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

/** Format of `SimState`; bump it when the saved layout changes. */
export const SIM_STATE_FORMAT = 1;

/** A saved simulation (R1.2): structured-cloneable, independent of the live one. */
export interface SimState {
  format: number;
  time: GameTime;
  eventsRun: number;
  ticksRun: number;
  queue: {
    nextSeq: number;
    entries: {
      time: GameTime;
      priority: number;
      seq: number;
      /** A tick names its process; an event carries its kind, data and flag. */
      tick?: { process: string; k: number };
      event?: { kind: string; data?: unknown; flag?: string };
    }[];
  };
  /** Each stateful part's `save()`, by name: processes by their name, others by `addState`'s. */
  parts: Record<string, unknown>;
  log: LogEntry[];
}

/** Ticks sort before events at the same time: priorities below EVENT_PRIORITY_BASE. */
const EVENT_PRIORITY_BASE = 1_000_000;

export class Simulation {
  private clock: GameTime;
  private readonly queue = new EventQueue<Entry>();
  private readonly processes: TickProcess[] = [];
  private readonly handlers = new Map<string, EventHandler>();
  private readonly parts = new Map<string, Stateful>();
  /** Player inputs and campaign decisions (rule 19). */
  readonly log = new EventLog();
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
    if (this.processes.some((q) => q.name === p.name)) {
      throw new Error(`A process named "${p.name}" already exists`);
    }
    const index = this.processes.length;
    this.processes.push(p);
    if (p.save && p.load) this.addState(p.name, p as Stateful);
    const offset = p.offset ?? 0;
    const k = Math.ceil((this.clock - offset) / p.period);
    this.queue.push(offset + k * p.period, index, { type: 'tick', process: index, k });
  }

  /** Registers a stateful part that is not a process (e.g. AirOps) under a unique name. */
  addState(name: string, part: Stateful): void {
    if (this.parts.has(name)) throw new Error(`A stateful part "${name}" already exists`);
    this.parts.set(name, part);
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
   * `target`. With `stopOnFlag`, stops at the first flagged event's time, once
   * every entry at that time has run, with the clock at that time. Finishing
   * the time keeps a stopped simulation in a state that `advanceTo(time)`
   * reaches too, so a player input there replays exactly (R1.2).
   */
  advanceTo(target: GameTime, stopOnFlag = false): AdvanceResult {
    if (target < this.clock) throw new RangeError(`Cannot go back from ${this.clock} to ${target}`);
    const flagged: SimEvent[] = [];
    let stopAt: GameTime | null = null;
    for (;;) {
      const next = this.queue.peek();
      if (stopAt !== null && (!next || next.time > stopAt)) {
        this.clock = stopAt;
        return { flagged, stopped: true };
      }
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
          if (stopOnFlag) stopAt ??= next.time;
        }
      }
    }
    this.clock = target;
    return { flagged, stopped: false };
  }

  /** The whole state, copied: later changes to the simulation do not reach it. */
  save(): SimState {
    const saved = this.queue.save();
    const parts: Record<string, unknown> = {};
    for (const [name, part] of this.parts) parts[name] = part.save();
    return structuredClone({
      format: SIM_STATE_FORMAT,
      time: this.clock,
      eventsRun: this.eventsRun,
      ticksRun: this.ticksRun,
      queue: {
        nextSeq: saved.nextSeq,
        entries: saved.entries.map((e) => ({
          time: e.time,
          priority: e.priority,
          seq: e.seq,
          ...(e.item.type === 'tick'
            ? { tick: { process: this.processes[e.item.process]!.name, k: e.item.k } }
            : { event: { kind: e.item.kind, data: e.item.data, flag: e.item.flag } }),
        })),
      },
      parts,
      log: this.log.save(),
    });
  }

  /**
   * Restores a saved state. The simulation must be built from the same
   * configuration (the same processes, parts and handlers); its own pending
   * entries are replaced. The state is copied, so it can be loaded again.
   */
  load(state: SimState): void {
    if (state.format !== SIM_STATE_FORMAT) {
      throw new Error(`Saved state format ${state.format}, expected ${SIM_STATE_FORMAT}`);
    }
    const s = structuredClone(state);
    const index = new Map(this.processes.map((p, i) => [p.name, i]));
    const entries = s.queue.entries.map((e) => {
      let item: Entry;
      if (e.tick) {
        const process = index.get(e.tick.process);
        if (process === undefined)
          throw new Error(`Saved tick of unknown process "${e.tick.process}"`);
        item = { type: 'tick', process, k: e.tick.k };
      } else if (e.event) {
        item = { type: 'event', kind: e.event.kind, data: e.event.data, flag: e.event.flag };
      } else throw new Error(`Saved entry ${e.seq} is neither a tick nor an event`);
      return { time: e.time, priority: e.priority, seq: e.seq, item };
    });
    for (const name of this.parts.keys()) {
      if (!(name in s.parts)) throw new Error(`Saved state lacks part "${name}"`);
    }
    for (const name of Object.keys(s.parts)) {
      if (!this.parts.has(name)) throw new Error(`Saved state has unknown part "${name}"`);
    }
    this.queue.load({ nextSeq: s.queue.nextSeq, entries });
    this.clock = s.time;
    this.eventsRun = s.eventsRun;
    this.ticksRun = s.ticksRun;
    for (const [name, part] of this.parts) part.load(s.parts[name]);
    this.log.load(s.log);
  }

  /** Hash of the clock, the counters, pending events, every process's state and the log. */
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
    const processes = new Set<Stateful>(this.processes as Stateful[]);
    for (const [name, part] of this.parts) {
      if (processes.has(part)) continue;
      h.string(name);
      part.hash?.(h);
    }
    this.log.hash(h);
    return h.digest();
  }
}
