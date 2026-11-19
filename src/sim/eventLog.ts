/**
 * The campaign's event log (rule 19, decision 230; roadmap R1.2): every player
 * input to the campaign and every campaign-level decision, typed and
 * timestamped, in the order it happened.
 *
 * - **Inputs** come from the player (through the host): `SimHost` applies them
 *   and records them, and replays them after restoring a saved state, so a
 *   backward seek or a load reaches the same state as the straight run.
 * - **Decisions** are what the campaign decides itself (a mission launched, from
 *   R2 an order revised or a target damaged). Replaying the inputs makes them
 *   again, so they are recorded, not replayed: a replay that records a
 *   different decision has diverged, and the log says where.
 *
 * The log is part of the saved state and of the state hash. Entries are plain,
 * structured-cloneable data.
 */
import type { Side } from '../campaign/cast';
import type { GameTime } from '../core/units';
import type { Subscription } from './air/subscriptions';
import type { StateHasher } from './stateHash';

/** A player input to the campaign. Later phases add their kinds here. */
export type CampaignInputEvent =
  | {
      kind: 'alarm';
      /** Game time the alarm goes off, and its label. */
      at: GameTime;
      label: string;
    }
  /** The side the player flies for (R1.4): logged; the UI shows that side's missions. */
  | { kind: 'side'; side: Side }
  /** A mission subscription (R1.4), added or replaced by id, or removed. */
  | { kind: 'subscribe'; subscription: Subscription }
  | { kind: 'unsubscribe'; id: number };

/** A campaign-level decision. Later phases add their kinds here. */
export type CampaignDecision =
  | {
      kind: 'mission-launched';
      mission: number;
      side: string;
      type: string;
      squadron: number;
      aircraft: number;
    }
  /** A side's air tasking order issued (revision 0) or revised (R2.1): sorties kept, added, cancelled. */
  | {
      kind: 'ato-revised';
      side: string;
      day: number;
      revision: number;
      kept: number;
      added: number;
      cancelled: number;
    }
  /** Aircraft of a flight lost (R2.2): to what, and how many crew ejected or were killed. */
  | {
      kind: 'aircraft-lost';
      mission: number;
      side: string;
      type: string;
      aircraft: number;
      cause: string;
      ejected: number;
      killed: number;
    }
  /** A flight turned home early (R2.2), and why. */
  | { kind: 'mission-aborted'; mission: number; side: string; type: string; reason: string }
  /** A mission's outcome as its resolver judged it (R2.2). */
  | {
      kind: 'mission-resolved';
      mission: number;
      side: string;
      type: string;
      success: boolean;
      effect: number;
      kills: number;
      losses: number;
    }
  /** A planned sortie cancelled when it was due to be committed (R2.1), and why. */
  | { kind: 'sortie-cancelled'; side: string; sortie: string; type: string; reason: string };

export type LogEntry =
  | ({ source: 'input'; time: GameTime; seq: number } & CampaignInputEvent)
  | ({ source: 'decision'; time: GameTime; seq: number } & CampaignDecision);

export class EventLog {
  private list: LogEntry[] = [];

  get entries(): readonly LogEntry[] {
    return this.list;
  }

  get size(): number {
    return this.list.length;
  }

  input(time: GameTime, e: CampaignInputEvent): LogEntry {
    const entry: LogEntry = { source: 'input', time, seq: this.list.length, ...e };
    this.list.push(entry);
    return entry;
  }

  decision(time: GameTime, e: CampaignDecision): LogEntry {
    const entry: LogEntry = { source: 'decision', time, seq: this.list.length, ...e };
    this.list.push(entry);
    return entry;
  }

  save(): LogEntry[] {
    return this.list.map((e) => ({ ...e }));
  }

  load(entries: readonly LogEntry[]): void {
    this.list = entries.map((e) => ({ ...e }));
  }

  hash(h: StateHasher): void {
    h.number(this.list.length);
    for (const e of this.list) h.string(JSON.stringify(e));
  }
}
