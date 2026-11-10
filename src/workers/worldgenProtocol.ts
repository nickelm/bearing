/** Messages between the main thread and the world-generation worker. */
import type { SeedSummary, StrategicWorld } from '../worldgen/campaignWorld';
import type { FinishInput, FinishResult } from '../worldgen/finishWorld';
import type { PlanetParams } from '../worldgen/params';
import type { WorldInfo, WorldMaps } from '../worldgen/pipeline';

export interface GenerateRequest {
  type: 'generate';
  id: number;
  params: PlanetParams;
  resolution: number;
}

/** CPU stages after GPU erosion: drainage, rivers, biomes, display maps. */
export interface FinishRequest {
  type: 'finish';
  id: number;
  input: FinishInput;
}

/** Seed browser: the coarse pass and casting for each seed, one row at a time. */
export interface ScanRequest {
  type: 'scan';
  id: number;
  params: PlanetParams;
  seeds: string[];
}

export type ToWorldgenWorker = GenerateRequest | FinishRequest | ScanRequest;

export interface ScanRowMessage {
  type: 'scanRow';
  id: number;
  row: SeedSummary;
}

export interface ScanDoneMessage {
  type: 'scanDone';
  id: number;
}

export interface ProgressMessage {
  type: 'progress';
  id: number;
  stage: string;
  fraction: number;
}

export interface ResultMessage {
  type: 'result';
  id: number;
  maps: WorldMaps;
  info: WorldInfo;
  /** Graph and campaign from the coarse pass; the maps use its seed. */
  strategic: StrategicWorld;
}

export interface ErrorMessage {
  type: 'error';
  id: number;
  message: string;
}

export interface FinishResultMessage {
  type: 'finished';
  id: number;
  result: FinishResult;
}

export type FromWorldgenWorker =
  | ProgressMessage
  | ResultMessage
  | FinishResultMessage
  | ScanRowMessage
  | ScanDoneMessage
  | ErrorMessage;
