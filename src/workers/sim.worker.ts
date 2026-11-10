/**
 * Simulation worker (decision 67). Owns the game clock: a timer steps the
 * `SimHost` by the real time elapsed, at the current rate, and posts a
 * snapshot whenever anything changed. Weather frames for the current hour
 * bracket go out once each, as transferred buffers.
 */
import { rng } from '../core/rng';
import { SimHost } from '../sim/host';
import { createSimWorld, scheduleAlarm } from '../sim/world';
import type { SimWorld } from '../sim/world';
import type { FromSimWorker, InitMessage, ToSimWorker } from './protocol';
import { PING_STREAM, SNAPSHOT_FIELDS, SnapshotField } from './protocol';

// The DOM lib types `self` as Window; narrow it to the worker API we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ToSimWorker>) => void) | null;
  postMessage(message: FromSimWorker, transfer?: Transferable[]): void;
};

/** Worker steps per real second. */
const STEP_HZ = 30;

let host: SimHost<SimWorld> | null = null;
let session = 0;
let lastReal = 0;
let lastSentTime = NaN;
let lastSentRate = NaN;
/** Weather hours already sent this session. */
let sentHours = new Set<number>();
let timer: ReturnType<typeof setTimeout> | null = null;

function init(msg: InitMessage): void {
  session = msg.session;
  const config = {
    seed: msg.seed,
    radius: msg.radius,
    orbit: msg.orbit,
    calendar: msg.calendar,
    climate: msg.climate,
  };
  const autoSlowdown = host?.autoSlowdown ?? true;
  host = new SimHost(() => createSimWorld(config));
  host.autoSlowdown = autoSlowdown;
  sentHours = new Set();
  lastSentTime = NaN;
  post([], false, true);
  lastReal = performance.now();
  if (timer === null) loop();
}

function loop(): void {
  timer = setTimeout(loop, 1000 / STEP_HZ);
  if (!host) return;
  const now = performance.now();
  const real = (now - lastReal) / 1000;
  lastReal = now;
  try {
    const t0 = performance.now();
    const step = host.step(real);
    const flagged = step.flagged.map((e) => ({ time: e.time, label: e.flag ?? e.kind }));
    post(flagged, step.slowed, false, performance.now() - t0);
  } catch (err) {
    ctx.postMessage({ type: 'error', session, message: String(err) });
    host = null;
  }
}

/** Posts a snapshot if anything changed (or `force`), with any weather frames not yet sent. */
function post(
  flagged: { time: number; label: string }[],
  slowed: boolean,
  force: boolean,
  stepMs = 0,
): void {
  if (!host) return;
  const world = host.world;
  const time = host.time;
  const available = world.weather.availableHours();
  const weather = available.filter((h) => !sentHours.has(h)).map((h) => world.weather.frame(h));
  const unchanged = time === lastSentTime && host.rate === lastSentRate;
  if (!force && weather.length === 0 && flagged.length === 0 && unchanged) return;
  sentHours = new Set(available);
  const header = new Float64Array(SNAPSHOT_FIELDS);
  const stats = world.sim.stats;
  header[SnapshotField.Time] = time;
  header[SnapshotField.Rate] = host.rate;
  header[SnapshotField.Events] = stats.events;
  header[SnapshotField.Ticks] = stats.ticks;
  header[SnapshotField.Pending] = stats.pending;
  header[SnapshotField.WeatherSystems] = world.weather.systems.length;
  header[SnapshotField.StepMs] = stepMs;
  lastSentTime = time;
  lastSentRate = host.rate;
  ctx.postMessage(
    {
      type: 'snapshot',
      session,
      header,
      weather,
      flagged,
      slowed,
      hash: force ? world.sim.hash() : undefined,
    },
    [header.buffer, ...weather.map((f) => f.data.buffer)],
  );
}

ctx.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'ping':
      ctx.postMessage({ type: 'pong', value: rng(msg.seed, PING_STREAM).nextUint32() });
      break;
    case 'init':
      init(msg);
      break;
    case 'setRate':
      if (host) host.rate = msg.rate;
      post([], false, true);
      break;
    case 'seek':
      if (host) {
        try {
          // Backward seeks rebuild the world: send its frames again.
          if (msg.time < host.time) sentHours = new Set();
          host.seek(msg.time);
          post([], false, true);
        } catch (err) {
          ctx.postMessage({ type: 'error', session, message: String(err) });
        }
      }
      break;
    case 'alarm':
      if (host) scheduleAlarm(host.world, msg.at, msg.label);
      break;
    case 'autoSlowdown':
      if (host) host.autoSlowdown = msg.enabled;
      break;
  }
};
