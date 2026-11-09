/** Messages between the main thread and the world-generation worker. */
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

export type ToWorldgenWorker = GenerateRequest | FinishRequest;

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
  ProgressMessage | ResultMessage | FinishResultMessage | ErrorMessage;
