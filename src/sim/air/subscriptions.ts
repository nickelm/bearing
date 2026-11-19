/**
 * Mission subscriptions (roadmap R1.4): a saved query plus a phase. When a
 * mission that matches reaches the phase, AirOps schedules a flagged event at
 * that moment, so the host's auto-slowdown drops the clock to 1× and the player
 * is offered the mission. Subscribing is a player input to the campaign (rule
 * 19): it arrives through the event log, and the list is saved with the state.
 */
import type { Side } from '../../campaign/cast';
import type { Stateful } from '../simulation';
import type { StateHasher } from '../stateHash';
import type { Mission, MissionPhase, MissionType } from './mission';

/** Event kind of a subscription's flagged event (data: SubscriptionHit). */
export const SUBSCRIPTION_EVENT = 'air:subscription';

/** Which missions a query takes; an absent or empty list takes all. */
export interface MissionQuery {
  side?: Side;
  types?: MissionType[];
  /** Aircraft type ids. */
  aircraft?: string[];
  /** Cast theater indices. */
  theaters?: number[];
}

export interface Subscription {
  id: number;
  query: MissionQuery;
  phase: MissionPhase;
  /** What the player called it ("CAS over the front"). */
  label: string;
}

/** The data of a subscription's flagged event. */
export interface SubscriptionHit {
  subscription: number;
  mission: number;
  phase: MissionPhase;
}

const has = <T>(list: readonly T[] | undefined, x: T) =>
  !list || list.length === 0 || list.includes(x);

export function matchesQuery(m: Mission, q: MissionQuery): boolean {
  return (
    (q.side === undefined || m.side === q.side) &&
    has(q.types, m.type) &&
    has(q.aircraft, m.aircraftType) &&
    has(q.theaters, m.theater)
  );
}

export class Subscriptions implements Stateful {
  private list: Subscription[] = [];

  get all(): readonly Subscription[] {
    return this.list;
  }

  /** Adds or replaces (by id) a subscription. */
  add(s: Subscription): void {
    this.list = [...this.list.filter((x) => x.id !== s.id), structuredClone(s)].sort(
      (a, b) => a.id - b.id,
    );
  }

  remove(id: number): void {
    this.list = this.list.filter((x) => x.id !== id);
  }

  /** The subscriptions a mission reaching `phase` triggers, in id order. */
  matching(m: Mission, phase: MissionPhase): Subscription[] {
    return this.list.filter((s) => s.phase === phase && matchesQuery(m, s.query));
  }

  save(): Subscription[] {
    return structuredClone(this.list);
  }

  load(state: unknown): void {
    this.list = structuredClone(state as Subscription[]);
  }

  hash(h: StateHasher): void {
    h.number(this.list.length);
    for (const s of this.list) h.string(JSON.stringify(s));
  }
}
