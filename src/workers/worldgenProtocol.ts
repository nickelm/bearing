/** Messages between the main thread and the world-generation worker. */
import type { PlanetParams } from '../worldgen/params';
import type { WorldInfo, WorldMaps } from '../worldgen/pipeline';

export interface GenerateRequest {
  type: 'generate';
  id: number;
  params: PlanetParams;
  resolution: number;
}

export type ToWorldgenWorker = GenerateRequest;

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

export type FromWorldgenWorker = ProgressMessage | ResultMessage | ErrorMessage;
