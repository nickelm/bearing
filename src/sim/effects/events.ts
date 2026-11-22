/**
 * The effect events (Proposal 0011, decision 326): what the simulation tells the renderer
 * happened, so it can draw smoke, fire and explosions. Plain, serializable records
 * (positions as world-frame tuples in meters, times in game seconds), so they can cross
 * from the worker in a message as well as be made on the main thread.
 *
 * Effects are cosmetic. Nothing that consumes these events may change simulation state,
 * and nothing in the simulation may depend on whether they were consumed. A long-lived
 * fire is keyed, so the renderer can draw it again after the camera has left and come back;
 * the game layer's damage states stay the source of truth (`fire-started` is a hint that
 * one began, and `EffectsSystem.setColumns` takes the whole set).
 */

/** A world-frame position or direction (m), planet-centered (rule 3). */
export type Vec3Tuple = readonly [number, number, number];

/**
 * A missile's motor, named in its weapon's specification: it decides how visible the
 * launch and the flight are. `sam` is a large surface-to-air motor: a white column at the
 * launcher, then a thick trail.
 */
export type MotorKind = 'solid' | 'reduced-smoke' | 'sam' | 'none';

/** Where a blast happens: in the air, on the ground, on water, or a fuel or ammunition store. */
export type ExplosionKind = 'air' | 'ground' | 'water' | 'fuel';

/** What burns for a long time. */
export type FireKind = 'fuel' | 'target' | 'building' | 'ship';

/** An aircraft's smoke state. */
export type AircraftSmoke = 'none' | 'damaged' | 'burning';

export type EffectEvent =
  | {
      type: 'launch';
      time: number;
      /** The weapon's store id. */
      weapon: string;
      motor: MotorKind;
      at: Vec3Tuple;
      /** Unit direction of flight at launch. */
      dir: Vec3Tuple;
      /** From a launcher on the ground (a SAM) rather than a rail. */
      fromGround: boolean;
    }
  | {
      type: 'hit';
      time: number;
      at: Vec3Tuple;
      target: 'aircraft' | 'ground' | 'ship';
    }
  | {
      type: 'explosion';
      time: number;
      at: Vec3Tuple;
      /** Explosive mass (kg): the blast's size goes with its cube root. */
      explosive: number;
      kind: ExplosionKind;
    }
  | {
      type: 'fire-started';
      time: number;
      /** Stable key of what burns (a target site, a building, a ship). */
      key: string;
      at: Vec3Tuple;
      kind: FireKind;
      /** 0..1: how hard it burns. */
      intensity: number;
    }
  | { type: 'fire-extinguished'; time: number; key: string }
  | {
      type: 'aircraft-smoke';
      time: number;
      /** Stable key of the aircraft. */
      key: string;
      state: AircraftSmoke;
    };

/** Whatever takes effect events: the renderer's effects system, a queue, a test. */
export interface EffectSink {
  handle(event: EffectEvent): void;
}

/**
 * A queue of effect events: the producer pushes, the consumer drains once a frame. Holds
 * at most `capacity` events, dropping the oldest, so a paused consumer never grows it.
 */
export class EffectQueue implements EffectSink {
  private readonly events: EffectEvent[] = [];

  constructor(readonly capacity = 1024) {}

  handle(event: EffectEvent): void {
    if (this.events.length >= this.capacity) this.events.shift();
    this.events.push(event);
  }

  get length(): number {
    return this.events.length;
  }

  /** Hands every queued event to `sink`, oldest first, and empties the queue. */
  drain(sink: EffectSink): number {
    const n = this.events.length;
    for (const e of this.events.splice(0)) sink.handle(e);
    return n;
  }
}

/** A long-lived column the game layer knows of: what burns where, how hard. */
export interface FireColumn {
  key: string;
  at: Vec3Tuple;
  kind: FireKind;
  /** 0..1. */
  intensity: number;
}
