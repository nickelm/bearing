/** The settlement worker (decision 266): see cityCore.ts. */
import { CityCore } from './cityCore';
import type { FromCityWorker, ToCityWorker } from './cityProtocol';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ToCityWorker>) => void) | null;
  postMessage(message: FromCityWorker, transfer?: Transferable[]): void;
};

const core = new CityCore();
ctx.onmessage = (e) => {
  const { reply, transfer } = core.handle(e.data);
  if (reply) ctx.postMessage(reply, transfer);
};
