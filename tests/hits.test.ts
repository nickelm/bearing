/** Hits and kills at full fidelity, and their consequences in the campaign (decision 301). */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { bundleOfType } from '../src/sim/air/bundles';
import { STORES } from '../src/sim/air/stores';
import { routeState } from '../src/sim/air/route';
import { initialAvionics } from '../src/sim/avionics/avionics';
import { campaignInput } from '../src/sim/command/campaignInput';
import { blast, GROUND_TARGETS, groundDamage, ROUND_DAMAGE } from '../src/sim/flight/damage';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { flyProjectile } from '../src/sim/flight/ordnance';
import { StoresRack } from '../src/sim/flight/storesRack';
import { BRIDGE_CUT } from '../src/sim/ground/damage';
import { SimHost } from '../src/sim/host';
import { applyInput, createSimWorld } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { kestrelSpec } from './helpers/flight';
import { capMission, phaseStart, promote, seaLevel } from './helpers/promoted';
import { syntheticConfig } from './helpers/weatherWorld';

const bridge = GROUND_TARGETS.bridge!;

describe('damage (decision 301)', () => {
  it('blasts in full within the lethal radius and falls off as the square beyond it', () => {
    const w = STORES['bomb-900']!.warhead!;
    expect(blast(w, 10)).toBe(1);
    expect(blast(w, 2 * w.lethal)).toBeCloseTo(0.25, 9);
    expect(blast(w, w.reach)).toBe(0);
  });

  it('cuts a bridge with one 900 kg bomb close by, or three 230 kg ones', () => {
    expect(groundDamage(STORES['bomb-900']!.warhead!, 30, bridge)).toBeGreaterThanOrEqual(
      BRIDGE_CUT,
    );
    const one = groundDamage(STORES['bomb-230']!.warhead!, 30, bridge);
    expect(one).toBeLessThan(BRIDGE_CUT);
    expect(1 - (1 - one) ** 3).toBeGreaterThanOrEqual(BRIDGE_CUT);
    // A rocket barely scratches it.
    expect(groundDamage(STORES['rockets-19']!.warhead!, 0, bridge)).toBeLessThan(0.01);
  });
});

describe('hits from the rack (decision 301)', () => {
  const m = capMission();
  const t0 = phaseStart(m, 'on-target') + 100;
  const f21 = bundleOfType('f21');

  it('hits an aircraft ahead with the gun, a round at a time', () => {
    const f = promote({ ...m, aircraft: 1 }, t0);
    const a = f.aircraft[0]!;
    const model = a.flown.airframe as unknown as FlightModel;
    const fwd = model.q.rotate(new Vec3d(1, 0, 0));
    // A bandit 300 m ahead on the gun line, flying with us.
    const p0 = model.pos.clone().addScaled(fwd, 300);
    a.rack.sources = [{ id: 'bandit', pos: p0, vel: model.vel.clone(), time: t0, radius: 8 }];
    a.rack.gun!.trigger = true;
    const av = { ...initialAvionics(false), masterArm: true, weapon: 'gun' };
    for (let i = 0; i < 60; i++) {
      a.rack.sources[0]!.pos = p0.clone().addScaled(model.vel, i / 120);
      a.rack.sources[0]!.time = t0 + i / 120;
      a.rack.stepWeapons(model, av, 1 / 120, t0 + i / 120, seaLevel);
    }
    const hits = a.rack.hits.filter((h) => h.target === 'bandit');
    expect(hits.length).toBeGreaterThan(5);
    expect(hits.every((h) => h.air && h.cause === 'gun' && h.amount === ROUND_DAMAGE)).toBe(true);
  });

  it('damages a ground target with a bomb that lands by it', () => {
    const f = promote({ ...m, aircraft: 1 }, t0);
    const model = f.aircraft[0]!.flown.airframe as unknown as FlightModel;
    const strike = f21.airWar!.loadouts.find((l) => l.id === 'strike')!;
    const rack = new StoresRack(kestrelSpec(), f21.pylons, strike.stations, {
      loadout: 'strike',
      expended: {},
    });
    const av = { ...initialAvionics(false), masterArm: true, weapon: 'bomb-900' };
    const bomb = rack.dropBomb(model, av)!;
    // Where it will land: fly a copy of it.
    const probe = { ...bomb, pos: bomb.pos.clone(), vel: bomb.vel.clone() };
    let landing: Vec3d | null = null;
    for (let t = 0; !landing && t < 120; t += 1 / 120)
      landing = flyProjectile(probe, 1 / 120, model.radius, () => 0, t)?.at ?? null;
    rack.groundTargets = [{ id: 'site:3', pos: landing!.clone(), kind: bridge }];
    for (let i = 0; i < 120 * 120 && rack.ordnance.length > 0; i++)
      rack.stepWeapons(model, av, 1 / 120, t0 + i / 120, seaLevel);
    const hit = rack.hits.find((h) => h.target === 'site:3')!;
    expect(hit.air).toBe(false);
    expect(hit.amount).toBeGreaterThanOrEqual(BRIDGE_CUT);
  });
});

describe('kills and hits in the campaign (decision 301)', () => {
  const R = DEFAULT_PLANET_PARAMS.radius;
  const world = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(64) },
  );
  const input = campaignInput(world.graph, world.campaign.cast, world.infrastructure);
  const make = (): SimWorld =>
    createSimWorld({ ...syntheticConfig(7), radius: R, campaign: input });

  it('loses a shot-down aircraft, credits the shooter, and damages a target that was hit', () => {
    const host = new SimHost(make, applyInput);
    host.seek(3 * HOUR);
    const air = host.world.air!;
    const live = air.liveMissions().filter((x) => routeState(x.route, host.time, R).airborne);
    const victim = live.find((x) => x.side === 'pact' && x.aircraft >= 2)!;
    const shooter = live.find((x) => x.side === 'alliance')!;
    const before = victim.aircraft;
    const kills = shooter.kills ?? 0;
    host.input({
      kind: 'shot-down',
      mission: victim.id,
      point: routeState(victim.route, host.time, R).point,
      cause: 'missile',
      by: shooter.id,
    });
    expect(victim.aircraft).toBe(before - 1);
    expect(shooter.kills).toBe(kills + 1);
    const log = host.world.sim.log.entries;
    expect(
      log.some(
        (e) => e.kind === 'aircraft-lost' && e.mission === victim.id && e.cause === 'missile',
      ),
    ).toBe(true);
    // A bridge target hit hard enough is cut.
    const site = input.targets.find((t) => t.bridge)!;
    host.input({ kind: 'target-hit', target: 'site', id: site.id, amount: 0.6, by: shooter.id });
    expect(host.world.damage!.damage(site.id)).toBeCloseTo(0.6, 9);
    // An aircraft lost by ejection at full fidelity: its whole crew survives.
    const survivors = air.survivors.length;
    const own = live.find((x) => x.side === 'alliance' && x.aircraft >= 2 && x.id !== victim.id)!;
    air.lose(own, 1, routeState(own.route, host.time, R).point, 'ejected', host.world.sim);
    expect(air.survivors.length).toBeGreaterThanOrEqual(survivors + 1);
    expect(
      log
        .filter((e) => e.kind === 'aircraft-lost' && e.cause === 'ejected')
        .every((e) => e.kind === 'aircraft-lost' && e.killed === 0),
    ).toBe(true);
  }, 120_000);
});

describe('damaged targets on the map (decision 301)', () => {
  it('turns a damaged target amber and a cut bridge red, by their marks’ keys', async () => {
    const { damagedInfra, DAMAGED_COLOR, DESTROYED_COLOR } =
      await import('../src/render/strategic/infra/infraModel');
    const mark = (key: string) =>
      ({ key, color: 1, shape: 'bridge', layer: 'sites' }) as unknown as Parameters<
        typeof damagedInfra
      >[0]['marks'][number];
    const model = { lines: [], marks: [mark('bridge:road:4'), mark('site:2'), mark('site:9')] };
    const targets = [
      { id: 0, bridge: { list: 'road', index: 4 } },
      undefined,
      { id: 2, kind: 'supply-depot' },
    ] as unknown as Parameters<typeof damagedInfra>[1];
    const out = damagedInfra(
      model,
      targets,
      new Map([
        [0, 0.6],
        [2, 0.3],
      ]),
      BRIDGE_CUT,
    );
    expect(out.marks.map((m) => m.color)).toEqual([DESTROYED_COLOR, DAMAGED_COLOR, 1]);
  });
});
