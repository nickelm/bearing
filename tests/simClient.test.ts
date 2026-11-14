/**
 * The main thread's side of the sim worker, on a stand-in worker: what a seek
 * does to the display clock, and when the app is told that the weather of the
 * new time has arrived (it settles the ground's wetness on it then).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { WeatherState } from '../src/render/sim/weather/weatherState';
import { Channel, MM_PER_HOUR, newFrameData } from '../src/sim/weather/frame';
import { WeatherGrid } from '../src/sim/weather/grid';
import { SNAPSHOT_FIELDS, SnapshotField } from '../src/workers/protocol';
import type { FromSimWorker, ToSimWorker } from '../src/workers/protocol';
import { SimClient } from '../src/workers/simClient';
import { syntheticConfig } from './helpers/weatherWorld';

/** A worker that records what it is sent and answers when the test says so. */
class FakeWorker {
  static last: FakeWorker;
  onmessage: ((e: { data: FromSimWorker }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly sent: ToSimWorker[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(msg: ToSimWorker): void {
    this.sent.push(msg);
  }
  /**
   * A snapshot as the worker posts it: `forced` ones (a seek, a rate change) carry a hash.
   * `rain` is the precipitation of the frames it brings, everywhere (mm/h).
   */
  snapshot(session: number, time: number, hours: number[], forced: boolean, rain = 0): void {
    const header = new Float64Array(SNAPSHOT_FIELDS);
    header[SnapshotField.Time] = time;
    const grid = new WeatherGrid();
    const frame = (hour: number) => {
      const data = newFrameData(grid);
      data.fill(40_000, Channel.Visibility * grid.count, (Channel.Visibility + 1) * grid.count);
      data.fill(
        rain * MM_PER_HOUR,
        Channel.Precipitation * grid.count,
        (Channel.Precipitation + 1) * grid.count,
      );
      return { hour, data };
    };
    this.onmessage!({
      data: {
        type: 'snapshot',
        session,
        header,
        weather: hours.map(frame),
        flagged: [],
        slowed: false,
        hash: forced ? 'h' : undefined,
      },
    });
  }
}

describe('SimClient', () => {
  beforeEach(() => vi.stubGlobal('Worker', FakeWorker));
  afterEach(() => vi.unstubAllGlobals());

  const started = () => {
    const sim = new SimClient();
    const worker = FakeWorker.last;
    const config = syntheticConfig();
    sim.init(String(config.seed), config.radius, config.orbit, config.calendar, config.climate);
    worker.snapshot(1, 0, [0, 1], true);
    return { sim, worker };
  };

  it('jumps the display time at once on a seek, ahead of the weather', () => {
    const { sim, worker } = started();
    expect(sim.weather.frames.map((f) => f?.hour)).toEqual([0, 1]);
    sim.seek(50 * HOUR);
    expect(sim.displayTime(performance.now())).toBe(50 * HOUR);
    // The frames are still those of the old time until the worker answers.
    expect(sim.weather.frames.map((f) => f?.hour)).toEqual([0, 1]);
    expect(worker.sent.at(-1)).toEqual({ type: 'seek', time: 50 * HOUR });
  });

  it('reports the seek as answered once the frames of the new time are in', () => {
    const { sim, worker } = started();
    const order: string[] = [];
    sim.onWeather = () => order.push(`weather ${sim.weather.frames.map((f) => f?.hour).join(',')}`);
    sim.onSeeked = () => order.push('seeked');
    sim.seek(50 * HOUR);
    expect(order).toEqual([]);
    // A step's snapshot that was on its way, and the answer to a rate change at the old time:
    // neither is the seek's answer.
    worker.snapshot(1, 0.5 * HOUR, [], false);
    worker.snapshot(1, 0.5 * HOUR, [], true);
    expect(order).toEqual([]);
    worker.snapshot(1, 50 * HOUR, [49, 50], true);
    expect(order).toEqual(['weather 49,50', 'seeked']);
    // Later snapshots do not report it again.
    worker.snapshot(1, 50 * HOUR + 10, [], true);
    expect(order).toHaveLength(2);
  });

  it('waits for the answer to the latest of several seeks', () => {
    const { sim, worker } = started();
    let seeked = 0;
    sim.onSeeked = () => seeked++;
    sim.seek(10 * HOUR);
    sim.seek(20 * HOUR);
    worker.snapshot(1, 10 * HOUR, [9, 10], true);
    expect(seeked).toBe(0);
    worker.snapshot(1, 20 * HOUR, [19, 20], true);
    expect(seeked).toBe(1);
  });

  it('lets the ground take its wetness from the weather of the new time (as main.ts wires it)', () => {
    const { sim, worker } = started();
    const state = new WeatherState();
    const here = new Vec3d(0, 0, 1);
    const frame = () =>
      state.update(sim.weather.ready ? sim.weather : null, here, 0, sim.displayTime(0), 1 / 60);
    // Rain at the start: the ground is wet.
    worker.snapshot(1, 0, [0, 1], true, 8);
    frame();
    expect(state.wetness.value).toBe(1);
    // A seek to a dry time. The app resets at once (the sun has jumped); the frames are still
    // the rainy ones, so the ground stays wet.
    sim.onSeeked = () => state.reset();
    sim.seek(50 * HOUR);
    state.reset();
    frame();
    expect(state.wetness.value).toBe(1);
    // The worker's answer brings the dry frames: the ground is dry on the next frame, where
    // without the second reset it would dry over minutes.
    worker.snapshot(1, 50 * HOUR, [49, 50], true, 0);
    frame();
    expect(state.rain.value).toBe(0);
    expect(state.wetness.value).toBe(0);
  });

  it('drops answers of an earlier session', () => {
    const { sim, worker } = started();
    let seeked = 0;
    sim.onSeeked = () => seeked++;
    sim.seek(10 * HOUR);
    worker.snapshot(0, 10 * HOUR, [9, 10], true);
    expect(seeked).toBe(0);
    expect(sim.weather.frames.map((f) => f?.hour)).toEqual([0, 1]);
  });
});
