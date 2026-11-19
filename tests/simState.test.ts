import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR, MINUTE } from '../src/core/units';
import { campaignInput } from '../src/sim/command/campaignInput';
import type { CampaignInput } from '../src/sim/command/campaignInput';
import { CHECKPOINT_PERIOD, MAX_CHECKPOINTS, SimHost } from '../src/sim/host';
import { EventQueue } from '../src/sim/scheduler';
import { Simulation } from '../src/sim/simulation';
import { ALARM_EVENT, applyInput, createSimWorld } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { syntheticConfig } from './helpers/weatherWorld';

// A small generated world with the air war, as in tests/air.test.ts.
const campaignWorld = generateCampaignWorld(
  { ...DEFAULT_PLANET_PARAMS, seed: 7 },
  { grid: new CubeGrid(64) },
);
const input: CampaignInput = campaignInput(
  campaignWorld.graph,
  campaignWorld.campaign.cast,
  campaignWorld.infrastructure,
);
const make = (): SimWorld => createSimWorld({ ...syntheticConfig(7), campaign: input });

/** Advances in steps of `step` game seconds to `to`. */
function runTo(w: SimWorld, to: number, step: number): void {
  for (let t = w.sim.time + step; t < to; t += step) w.sim.advanceTo(t);
  w.sim.advanceTo(to);
}

describe('the event queue', () => {
  it('saves and loads its entries with their sequence numbers', () => {
    const q = new EventQueue<string>();
    q.push(5, 0, 'a');
    q.push(5, 0, 'b');
    const c = q.push(3, 0, 'c');
    q.push(5, -1, 'd');
    q.cancel(c);
    const saved = q.save();
    const r = new EventQueue<string>();
    r.load(saved);
    expect(r.size).toBe(3);
    expect([r.pop()!.item, r.pop()!.item, r.pop()!.item]).toEqual(['d', 'a', 'b']);
    // New entries continue the saved sequence, so ties still break by scheduling order.
    expect(r.push(1, 0, 'e')).toBe(saved.nextSeq);
  });
});

describe('a saved campaign', () => {
  it('restores to the same state: 6 h, save, restore, 6 h more equals 12 h straight', () => {
    for (const step of [1, 64 * 0.25 * 4, 10 * MINUTE]) {
      const straight = make();
      runTo(straight, 12 * HOUR, step);
      const first = make();
      runTo(first, 6 * HOUR, step);
      const saved = first.sim.save();
      const second = make();
      second.sim.load(saved);
      expect(second.sim.hash(), `step ${step}`).toBe(first.sim.hash());
      runTo(second, 12 * HOUR, step);
      expect(second.sim.hash(), `step ${step}`).toBe(straight.sim.hash());
      expect(second.air!.completed).toEqual(straight.air!.completed);
    }
  });

  it('is independent of the simulation it came from, and loads twice alike', () => {
    const w = make();
    runTo(w, 5 * HOUR, 10 * MINUTE);
    const saved = w.sim.save();
    const at5 = w.sim.hash();
    runTo(w, 9 * HOUR, 10 * MINUTE);
    const a = make();
    a.sim.load(saved);
    expect(a.sim.hash()).toBe(at5);
    runTo(a, 7 * HOUR, 10 * MINUTE);
    const b = make();
    b.sim.load(saved);
    expect(b.sim.hash()).toBe(at5);
    // Structured-cloneable, as the worker protocol needs.
    expect(structuredClone(saved)).toEqual(saved);
  });

  it('refuses a state from a differently built simulation', () => {
    const w = make();
    runTo(w, HOUR, 10 * MINUTE);
    const saved = w.sim.save();
    const bare = new Simulation();
    expect(() => bare.load(saved)).toThrow();
    expect(() => make().sim.load({ ...saved, format: 99 })).toThrow();
  });

  it('logs mission launches as decisions, and a restored run logs the same ones', () => {
    const straight = make();
    runTo(straight, 8 * HOUR, 10 * MINUTE);
    const launches = straight.sim.log.entries.filter((e) => e.kind === 'mission-launched');
    expect(launches.length).toBe(straight.air!.launched.alliance + straight.air!.launched.pact);
    expect(launches.length).toBeGreaterThan(10);
    const w = make();
    runTo(w, 3 * HOUR, 10 * MINUTE);
    const r = make();
    r.sim.load(w.sim.save());
    runTo(r, 8 * HOUR, 10 * MINUTE);
    expect(r.sim.log.entries).toEqual(straight.sim.log.entries);
  });
});

describe('the host', () => {
  const alarmsRun = (w: SimWorld) => w.sim.log.entries.filter((e) => e.kind === 'alarm').length;

  it('keeps an alarm across a backward seek and replays it', () => {
    const host = new SimHost(make, applyInput);
    host.seek(1 * HOUR);
    host.input({ kind: 'alarm', at: 7 * HOUR, label: 'Check the front' });
    host.seek(9 * HOUR);
    const at9 = host.world.sim.hash();
    // Back to 3 h: before the alarm goes off, after it was set.
    host.seek(3 * HOUR);
    expect(alarmsRun(host.world)).toBe(1);
    const pending = host.world.sim
      .save()
      .queue.entries.filter((e) => e.event?.kind === ALARM_EVENT);
    expect(pending.length).toBe(1);
    // Back before it was set: the timeline sets it again on the way.
    host.seek(30 * MINUTE);
    expect(alarmsRun(host.world)).toBe(0);
    host.seek(9 * HOUR);
    expect(host.world.sim.hash()).toBe(at9);
    // The same as a run that never seeks.
    const straight = new SimHost(make, applyInput);
    straight.seek(1 * HOUR);
    straight.input({ kind: 'alarm', at: 7 * HOUR, label: 'Check the front' });
    straight.seek(9 * HOUR);
    expect(straight.world.sim.hash()).toBe(at9);
  });

  it('stops at the alarm with auto-slowdown in the same state as a straight run', () => {
    const host = new SimHost(make, applyInput);
    host.input({ kind: 'alarm', at: 2 * HOUR, label: 'Wake up' });
    host.rate = 256;
    let stop = null;
    while (!stop) {
      const s = host.step(0.25);
      if (s.flagged.length) stop = s;
    }
    expect(stop.time).toBe(2 * HOUR);
    expect(host.rate).toBe(1);
    const straight = new SimHost(make, applyInput);
    straight.input({ kind: 'alarm', at: 2 * HOUR, label: 'Wake up' });
    straight.seek(2 * HOUR);
    expect(host.world.sim.hash()).toBe(straight.world.sim.hash());
  });

  it('takes checkpoints every period and thins them past the limit', () => {
    const host = new SimHost(() => createSimWorld(syntheticConfig(7)), applyInput);
    host.seek(3 * CHECKPOINT_PERIOD + HOUR);
    expect(host.checkpointTimes).toEqual([0, 1, 2, 3].map((k) => k * CHECKPOINT_PERIOD));
    host.seek((MAX_CHECKPOINTS + 5) * CHECKPOINT_PERIOD);
    const times = host.checkpointTimes;
    expect(times.length).toBeLessThanOrEqual(MAX_CHECKPOINTS);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe((MAX_CHECKPOINTS + 5) * CHECKPOINT_PERIOD);
    // Seeking back to the middle restores from a checkpoint and reaches the straight state.
    const mid = 20.5 * CHECKPOINT_PERIOD;
    host.seek(mid);
    const straight = createSimWorld(syntheticConfig(7));
    straight.sim.advanceTo(mid);
    expect(host.world.sim.hash()).toBe(straight.sim.hash());
  });

  it('saves and loads the whole campaign with its input timeline', () => {
    const host = new SimHost(make, applyInput);
    host.seek(2 * HOUR);
    host.input({ kind: 'alarm', at: 8 * HOUR, label: 'Later' });
    host.seek(5 * HOUR);
    host.input({ kind: 'alarm', at: 6 * HOUR, label: 'Sooner' });
    host.seek(4 * HOUR);
    const saved = host.save();
    const other = new SimHost(make, applyInput);
    other.load(saved);
    expect(other.world.sim.hash()).toBe(host.world.sim.hash());
    other.seek(10 * HOUR);
    host.seek(10 * HOUR);
    expect(other.world.sim.hash()).toBe(host.world.sim.hash());
    expect(alarmsRun(other.world)).toBe(2);
  });
});

describe('a flagged stop', () => {
  it('finishes every entry at the flagged time before it returns', () => {
    const sim = new Simulation();
    const ran: string[] = [];
    sim.on('alarm', () => ran.push('alarm'));
    sim.on('e', (e) => ran.push(`e${String(e.data)}`));
    sim.schedule(500, 'alarm', null, { flag: 'Alarm' });
    sim.schedule(500, 'e', 1);
    sim.schedule(501, 'e', 2);
    const r = sim.advanceTo(1000, true);
    expect(r.stopped).toBe(true);
    expect(sim.time).toBe(500);
    expect(ran).toEqual(['alarm', 'e1']);
  });
});
