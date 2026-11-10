import { describe, expect, it } from 'vitest';
import { rng } from '../src/core/rng';
import { HOUR, MINUTE } from '../src/core/units';
import { SimHost } from '../src/sim/host';
import { EventQueue } from '../src/sim/scheduler';
import { Simulation } from '../src/sim/simulation';
import type { TickProcess } from '../src/sim/simulation';
import { StateHasher } from '../src/sim/stateHash';
import { createSimWorld, scheduleAlarm } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { syntheticConfig } from './helpers/weatherWorld';

describe('EventQueue', () => {
  it('pops by time, then priority, then insertion order', () => {
    const q = new EventQueue<string>();
    q.push(5, 0, 'c');
    q.push(1, 2, 'b2');
    q.push(1, 1, 'a');
    q.push(1, 2, 'b2-later');
    q.push(0.5, 9, 'first');
    const out: string[] = [];
    for (let e = q.pop(); e; e = q.pop()) out.push(e.item);
    expect(out).toEqual(['first', 'a', 'b2', 'b2-later', 'c']);
  });

  it('skips cancelled entries', () => {
    const q = new EventQueue<number>();
    const ids = [3, 1, 2].map((t) => q.push(t, 0, t));
    q.cancel(ids[1]!);
    expect(q.size).toBe(2);
    expect([q.pop()?.item, q.pop()?.item, q.pop()]).toEqual([2, 3, undefined]);
  });
});

/** A minute-tick process whose state depends on the order of everything it sees. */
class Recorder implements TickProcess {
  readonly name = 'recorder';
  readonly period = MINUTE;
  readonly log: string[] = [];
  value = 1;
  step(t: number, k: number): void {
    this.value = (this.value * 31 + k) % 1_000_003;
    this.log.push(`tick ${t}`);
  }
  hash(h: StateHasher): void {
    h.number(this.value);
  }
}

/** A world with weather, a minute tick and a chain of events that schedule more events. */
function testWorld(): SimWorld & { recorder: Recorder } {
  const world = createSimWorld(syntheticConfig());
  const recorder = new Recorder();
  world.sim.addProcess(recorder);
  const delays = rng(1, 'test/sim-delays');
  world.sim.on('ping', (e, sim) => {
    recorder.value = (recorder.value * 7 + Number(e.data)) % 1_000_003;
    recorder.log.push(`ping ${e.time}`);
    // Delays from 0 (same instant) to 20 min, some exactly on minute ticks.
    const step = delays.int(4) === 0 ? 0 : delays.int(20) * MINUTE + delays.int(2) * 7.5;
    sim.schedule(e.time + step, 'ping', Number(e.data) + 1);
  });
  world.sim.schedule(0, 'ping', 0);
  return { ...world, recorder };
}

describe('Simulation', () => {
  it('interleaves ticks and events in time order, ticks first at equal times', () => {
    const sim = new Simulation();
    const r = new Recorder();
    sim.addProcess(r);
    sim.on('e', (e) => r.log.push(`event ${e.time}`));
    sim.schedule(60, 'e');
    sim.schedule(30, 'e');
    sim.advanceTo(120);
    expect(r.log).toEqual(['tick 0', 'event 30', 'tick 60', 'event 60', 'tick 120']);
    expect(sim.time).toBe(120);
    expect(() => sim.schedule(100, 'e')).toThrow();
  });

  it('stops at a flagged event when asked', () => {
    const sim = new Simulation();
    sim.on('alarm', () => {});
    sim.schedule(500, 'alarm', null, { flag: 'Alarm' });
    const r = sim.advanceTo(1000, true);
    expect(r.stopped).toBe(true);
    expect(sim.time).toBe(500);
    expect(r.flagged.map((e) => e.flag)).toEqual(['Alarm']);
    expect(sim.advanceTo(1000, true).stopped).toBe(false);
    expect(sim.time).toBe(1000);
  });

  it('reaches the same state at 1×, 64× and in one jump (determinism across acceleration)', () => {
    const target = 3 * HOUR;
    const run = (rate: number, realStep: () => number) => {
      const w = testWorld();
      const host = new SimHost(() => w);
      host.rate = rate;
      while (host.time + rate * 0.25 < target) host.step(realStep());
      host.world.sim.advanceTo(target);
      return { hash: w.sim.hash(), log: w.recorder.log.join(';'), stats: w.sim.stats };
    };
    // Irregular frame times at 1× (20–40 ms), steady ones at 64×.
    const jitter = rng(2, 'test/frame-jitter');
    const slow = run(1, () => 0.02 + 0.02 * jitter.nextFloat());
    const fast = run(64, () => 1 / 30);
    const w = testWorld();
    w.sim.advanceTo(target);
    const jump = { hash: w.sim.hash(), log: w.recorder.log.join(';'), stats: w.sim.stats };
    expect(slow.stats.ticks).toBeGreaterThan(180);
    expect(slow.stats.events).toBeGreaterThan(20);
    expect(fast).toEqual(slow);
    expect(jump).toEqual(slow);
  });

  it('auto-slowdown stops at an alarm and drops to 1× without changing the outcome', () => {
    const make = () => {
      const w = testWorld();
      scheduleAlarm(w, 40 * MINUTE, 'Test alarm');
      return w;
    };
    const host = new SimHost(make);
    host.rate = 256;
    let stop = null;
    while (!stop) {
      const s = host.step(0.1);
      if (s.flagged.length) stop = s;
    }
    expect(stop.time).toBe(40 * MINUTE);
    expect(stop.slowed).toBe(true);
    expect(host.rate).toBe(1);
    host.world.sim.advanceTo(2 * HOUR);

    const straight = make();
    straight.sim.advanceTo(2 * HOUR);
    expect(host.world.sim.hash()).toBe(straight.sim.hash());
  });

  it('seeking back replays from campaign start to the same state', () => {
    const host = new SimHost(testWorld);
    host.seek(5 * HOUR);
    const at5 = host.world.sim.hash();
    host.seek(9 * HOUR);
    host.seek(5 * HOUR);
    expect(host.world.sim.hash()).toBe(at5);
  });
});
