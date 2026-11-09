/**
 * Simulation worker entry point. For now this is only a ping/pong stub proving
 * that worker bundling works and that seeded streams agree across contexts.
 * Milestone 6 moves the simulation (src/sim) in here.
 */
import { rng } from '../core/rng';
import type { FromSimWorker, ToSimWorker } from './protocol';
import { PING_STREAM } from './protocol';

// The DOM lib types `self` as Window; narrow it to the worker API we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ToSimWorker>) => void) | null;
  postMessage(message: FromSimWorker): void;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'ping':
      ctx.postMessage({ type: 'pong', value: rng(msg.seed, PING_STREAM).nextUint32() });
      break;
  }
};
