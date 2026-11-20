/**
 * Messages of the settlement worker (decision 266): plans and their urban ground
 * fields, built off the main thread from the global grid's heights and lakes.
 */
import type { WorldSeed } from '../core/rng';
import type { PackedPlan } from '../worldgen/settlements/pack';
import type { SettlementInput } from '../worldgen/settlements/types';

/** An input without its ground: the worker builds the ground from its maps. */
export type PlanRequestInput = Omit<SettlementInput, 'ground'>;

export type ToCityWorker =
  | {
      type: 'init';
      height: Float32Array;
      lake: Float32Array;
      n: number;
      radius: number;
      seed: WorldSeed;
      fieldSeed: number;
    }
  | { type: 'plan'; id: number; input: PlanRequestInput }
  | { type: 'field'; id: number; key: string; ci: number; cj: number };

export type FromCityWorker =
  | { type: 'plan'; id: number; plan: PackedPlan; ms: number }
  | { type: 'field'; id: number; key: string; ci: number; cj: number; data: Uint32Array }
  | { type: 'error'; id: number; message: string };
