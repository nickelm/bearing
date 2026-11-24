/**
 * What a mission's resolution produces (roadmap R2.2): its outcome, the
 * changes to the world its plug-in names as consequences, and what a plug-in's
 * aggregate resolver reads. Types only; resolution.ts runs them and the mission
 * plug-ins (sim/command/missions/) define the resolvers and consequences.
 */
import type { Dir } from '../../core/greatCircle';
import type { Rng } from '../../core/rng';
import type { CampaignInput } from '../command/campaignInput';
import type { AirOps } from './airOps';
import type { BaseRef, Mission } from './mission';

/** What happened to a mission, as a resolver or a full-fidelity session reports it (R2.2, R2.5). */
export interface MissionOutcome {
  completed: boolean;
  aborted: boolean;
  /** Time held on station or over the target (s). */
  onStation: number;
  /** Effect on the target, 0..1 (a strike's damage, a CAS flight's attrition). */
  effect: number;
  /** Share of the cargo delivered, 0..1. */
  delivered: number;
  losses: number;
  kills: number;
  /** Survivors a rescue picked up (R2.9), by id. */
  rescued?: number[];
}

/** A change to the world a mission's outcome causes; resolution.ts applies them, R2.3 reads the ground ones. */
export type WorldEffect =
  | { kind: 'damage'; target: number; amount: number }
  | { kind: 'road'; edge: number; amount: number }
  | { kind: 'stocks'; base: BaseRef; fuel: number; munitions: number }
  | { kind: 'ground-attack'; theater: number; point: Dir; amount: number }
  | { kind: 'station-held'; key: string; seconds: number }
  /** A rescue picked survivors up (R2.9): aboard until it lands home. */
  | { kind: 'rescue'; survivors: number[] };

/** What an aggregate resolver may read. */
export interface ResolveContext {
  air: AirOps;
  input: CampaignInput;
  /** The time the mission is resolved (its egress, or its abort). */
  now: number;
  /** Draws for this mission's resolution. */
  rng: Rng;
  /** Time the flight has held its station or target so far (s). */
  onStation: number;
}

/** A plug-in's aggregate resolver (R2.2): the mission's outcome when no one watches. */
export interface AggregateResolver {
  resolve(m: Mission, ctx: ResolveContext): MissionOutcome;
}

/**
 * How a type's flights take part in engagements: a target enemy CAP intercepts,
 * an escort that fights for its package, defense suppression (also halves the
 * package's losses to point defenses), a CAP that intercepts, or none.
 */
export type Engagement = 'target' | 'escort' | 'suppression' | 'cap' | 'none';
