import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR, MINUTE } from '../src/core/units';
import { aircraftType } from '../src/sim/air/aircraft';
import { jumpInWindow, phaseTime } from '../src/sim/air/mission';
import type { Mission } from '../src/sim/air/mission';
import { matchesQuery, SUBSCRIPTION_EVENT } from '../src/sim/air/subscriptions';
import { campaignInput } from '../src/sim/command/campaignInput';
import { SimHost } from '../src/sim/host';
import { applyInput, createSimWorld } from '../src/sim/world';
import {
  filterChoices,
  missionRows,
  NO_FILTERS,
  queryOf,
  timeToAction,
} from '../src/ui/missionSearch/model';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { syntheticConfig } from './helpers/weatherWorld';

const w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: 7 }, { grid: new CubeGrid(64) });
const input = campaignInput(w.graph, w.campaign.cast, w.infrastructure);
const make = () => createSimWorld({ ...syntheticConfig(7), campaign: input });
const names = w.campaign.cast.theaters.map((t) => t.name);

describe('mission search', () => {
  const sim = make();
  sim.sim.advanceTo(8 * HOUR);
  const t = sim.sim.time;
  const missions = sim.air!.liveMissions();

  it('lists the viewing side’s missions, in action first, then by time until action', () => {
    const rows = missionRows(missions, 'alliance', t, NO_FILTERS, names);
    expect(rows.length).toBeGreaterThan(5);
    const byId = new Map(missions.map((m) => [m.id, m]));
    for (const r of rows) expect(byId.get(r.id)!.side).toBe('alliance');
    const rank = (x: number) => (x === 0 ? 0 : x > 0 ? 1 : 2);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      expect(rank(a.timeToAction)).toBeLessThanOrEqual(rank(b.timeToAction));
      if (rank(a.timeToAction) === 1 && rank(b.timeToAction) === 1) {
        expect(a.timeToAction).toBeLessThanOrEqual(b.timeToAction);
      }
    }
    expect(missionRows(missions, 'both', t, NO_FILTERS, names).length).toBeGreaterThan(rows.length);
  });

  it('filters by type, aircraft, theater, phase, threat and time until action', () => {
    const choices = filterChoices(missions, 'alliance');
    expect(choices.types.length).toBeGreaterThan(1);
    const type = choices.types[0]!;
    const only = missionRows(missions, 'alliance', t, { ...NO_FILTERS, types: [type] }, names);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((r) => r.type === type)).toBe(true);
    const ac = choices.aircraft[0]!;
    const byAircraft = missionRows(
      missions,
      'alliance',
      t,
      { ...NO_FILTERS, aircraft: [ac] },
      names,
    );
    const m = new Map(missions.map((x) => [x.id, x]));
    expect(byAircraft.every((r) => m.get(r.id)!.aircraftType === ac)).toBe(true);
    const soon = missionRows(missions, 'alliance', t, { ...NO_FILTERS, within: HOUR }, names);
    expect(soon.every((r) => r.timeToAction >= 0 && r.timeToAction <= HOUR)).toBe(true);
    const high = missionRows(missions, 'alliance', t, { ...NO_FILTERS, threats: ['high'] }, names);
    expect(high.every((r) => r.threat === 'high')).toBe(true);
    const egress = missionRows(missions, 'both', t, { ...NO_FILTERS, phases: ['egress'] }, names);
    expect(egress.every((r) => r.phase === 'egress')).toBe(true);
    const theater = choices.theaters[0]!;
    const inTheater = missionRows(
      missions,
      'alliance',
      t,
      { ...NO_FILTERS, theaters: [theater] },
      names,
    );
    expect(inTheater.every((r) => m.get(r.id)!.theater === theater)).toBe(true);
  });

  it('opens fixed-wing jump-in from climb-out to approach, and helicopters over their ground phases', () => {
    for (const x of missions) {
      const win = jumpInWindow(x)!;
      expect(win, x.callsign).not.toBeNull();
      const helo = aircraftType(x.aircraftType).helicopter;
      expect(win.from).toBe(phaseTime(x, helo ? 'departure' : 'climb-out'));
      expect(win.to).toBe(phaseTime(x, helo ? 'complete' : 'approach'));
    }
    for (const r of missionRows(missions, 'both', t, NO_FILTERS, names)) {
      expect(r.jumpable).toBe(r.jumpIn !== null && t >= r.jumpIn.from && t < r.jumpIn.to);
    }
  });

  it('measures time to action as 0 during the action and below 0 after', () => {
    const x: Mission = missions[0]!;
    const on = phaseTime(x, 'on-target');
    expect(timeToAction(x, on - 60)).toBeCloseTo(60, 6);
    expect(timeToAction(x, on)).toBe(0);
    expect(timeToAction(x, phaseTime(x, 'approach') + 1)).toBeLessThan(0);
  });
});

describe('a subscription', () => {
  it('drops 64× to 1× when a matching mission reaches its phase, as a straight run does', () => {
    const query = queryOf({ ...NO_FILTERS, types: ['cas'] }, 'alliance');
    const subscribe = {
      kind: 'subscribe' as const,
      subscription: { id: 1, query, phase: 'on-target' as const, label: 'CAS on target' },
    };
    const host = new SimHost(make, applyInput);
    host.seek(30 * MINUTE);
    host.input(subscribe);
    host.rate = 64;
    let stop = null;
    for (let i = 0; i < 200_000 && !stop; i++) {
      const s = host.step(1 / 30);
      if (s.flagged.some((e) => e.kind === SUBSCRIPTION_EVENT)) stop = s;
    }
    expect(stop, 'no CAS reached its target').not.toBeNull();
    expect(stop!.slowed).toBe(true);
    expect(host.rate).toBe(1);
    const hit = stop!.flagged.find((e) => e.kind === SUBSCRIPTION_EVENT)!;
    expect(hit.flag).toContain('CAS on target');
    const m = host.world.air!.missions.get((hit.data as { mission: number }).mission)!;
    expect(matchesQuery(m, query)).toBe(true);
    expect(phaseTime(m, 'on-target')).toBe(stop!.time);
    // No matching mission reached the phase earlier.
    for (const e of host.world.sim.log.entries) {
      if (e.kind === 'mission-launched' && e.side === 'alliance' && e.type === 'cas') {
        const x = host.world.air!.missions.get(e.mission);
        if (x) expect(phaseTime(x, 'on-target')).toBeGreaterThanOrEqual(stop!.time);
      }
    }
    // The same as a run that seeks there, and the subscription survives a restore.
    const straight = new SimHost(make, applyInput);
    straight.seek(30 * MINUTE);
    straight.input(subscribe);
    straight.seek(stop!.time);
    expect(straight.world.sim.hash()).toBe(host.world.sim.hash());
    const other = make();
    other.sim.load(host.world.sim.save());
    expect(other.air!.subscriptions.all).toEqual(host.world.air!.subscriptions.all);
  });
});
