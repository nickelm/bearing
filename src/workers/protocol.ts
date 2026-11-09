/** Messages between the main thread and the simulation worker. */

export interface PingMessage {
  type: 'ping';
  seed: string;
}

export interface PongMessage {
  type: 'pong';
  /** First value of rng(seed, PING_STREAM), so the main thread can confirm cross-context determinism. */
  value: number;
}

export type ToSimWorker = PingMessage;
export type FromSimWorker = PongMessage;

export const PING_STREAM = 'worker-ping';
