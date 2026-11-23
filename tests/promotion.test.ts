/** Minimal entity promotion (roadmap R2.8, decisions 333–334). */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { arcDistance, destination, slerp } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { bundleOfType } from '../src/sim/air/bundles';
import { initialAvionics } from '../src/sim/avionics/avionics';
import { campaignInput } from '../src/sim/command/campaignInput';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { flyProjectile } from '../src/sim/flight/ordnance';
import { StoresRack } from '../src/sim/flight/storesRack';
import type { GroundTarget } from '../src/sim/flight/storesRack';
import type { BattalionKind } from '../src/sim/ground/orbat';
import {
  aliveCount,
  aliveVehicles,
  parseVehicleKey,
  PROMOTED,
  promoteBattalion,
  ROSTERS,
  rosterOrder,
  rosterSize,
  strengthAfterKill,
  VEHICLE_TARGETS,
  VehicleDamage,
  vehicleKey,
} from '../src/sim/ground/promotion';
import type { PromotableBattalion } from '../src/sim/ground/promotion';
import { SimHost } from '../src/sim/host';
import { applyInput, createSimWorld } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { kestrelSpec } from './helpers/flight';
import { capMission, phaseStart, promote, seaLevel } from './helpers/promoted';
import { syntheticConfig } from './helpers/weatherWorld';

const R = DEFAULT_PLANET_PARAMS.radius;
const KINDS: BattalionKind[] = ['tank', 'mechanized', 'air-defense', 'artillery', 'logistics'];
const ANCHOR: Dir = [0, 0, 1];

const battalion = (over: Partial<PromotableBattalion> = {}): PromotableBattalion => ({
  id: 5,
  side: 'pact',
  kind: 'tank',
  seed: 12345,
  strength: 1,
  killed: [],
  ...over,
});

describe('rosters (R2.8)', () => {
  it('order each kind’s vehicles so the first few show every type it has', () => {
    for (const k of KINDS) {
      const order = rosterOrder(k);
      expect(order.length).toBe(rosterSize(k));
      for (const [t, n] of Object.entries(ROSTERS[k])) {
        expect(order.filter((x) => x === t).length).toBe(n);
        expect(order.slice(0, PROMOTED[k])).toContain(t);
      }
    }
    // A tank battalion shows mostly tanks.
    const head = rosterOrder('tank').slice(0, PROMOTED.tank);
    expect(head.filter((t) => t === 'tank').length).toBeGreaterThanOrEqual(5);
  });

  it('count one vehicle less per kill, and the aggregate’s losses off the end', () => {
    for (const k of KINDS) {
      let s = 0.83;
      const before = aliveCount(k, s);
      s = strengthAfterKill(k, s);
      expect(aliveCount(k, s)).toBe(before - 1);
    }
    // Killed vehicles stay out; the anonymous losses come off the end of the order.
    const alive = aliveVehicles('tank', 30 / 38, [0, 2]);
    expect(alive.length).toBe(30);
    expect(alive).not.toContain(0);
    expect(alive).not.toContain(2);
    expect(alive[0]).toBe(1);
  });
});

describe('promotion (R2.8)', () => {
  it('is the same from the same seed, strength and kills', () => {
    const a = promoteBattalion(battalion(), ANCHOR, 0.3, R);
    const b = promoteBattalion(battalion(), ANCHOR, 0.3, R);
    expect(b).toEqual(a);
    expect(a.length).toBe(PROMOTED.tank);
    // Another seed, another layout.
    const c = promoteBattalion(battalion({ seed: 999 }), ANCHOR, 0.3, R);
    expect(c[0]!.point).not.toEqual(a[0]!.point);
  });

  it('keeps each vehicle where it stood when another is killed, and leaves the killed out', () => {
    const a = promoteBattalion(battalion(), ANCHOR, 0.3, R);
    const victim = a[2]!;
    const b = promoteBattalion(
      battalion({ strength: strengthAfterKill('tank', 1), killed: [victim.index] }),
      ANCHOR,
      0.3,
      R,
    );
    expect(b.some((v) => v.index === victim.index)).toBe(false);
    for (const v of b) {
      const same = a.find((x) => x.index === v.index);
      if (same) expect(v.point).toEqual(same.point);
    }
  });

  it('lays the vehicles out within a kilometer or so of the anchor, trucks behind', () => {
    for (const k of KINDS) {
      const vs = promoteBattalion(battalion({ kind: k }), ANCHOR, 0, R);
      for (const v of vs) expect(arcDistance(v.point, ANCHOR, R)).toBeLessThan(1000);
    }
    // Heading 0 is north: trucks lie south of the fighting vehicles.
    const vs = promoteBattalion(battalion({ kind: 'mechanized' }), ANCHOR, 0, R);
    const north = (p: Dir) => p[1];
    const trucks = vs.filter((v) => v.type === 'truck');
    const fighting = vs.filter((v) => v.type === 'ifv');
    expect(trucks.length).toBeGreaterThan(0);
    expect(Math.max(...trucks.map((v) => north(v.point)))).toBeLessThan(
      Math.min(...fighting.map((v) => north(v.point))),
    );
  });

  it('shows none of a battalion that has lost everything', () => {
    expect(promoteBattalion(battalion({ strength: 0 }), ANCHOR, 0, R)).toEqual([]);
  });

  it('names vehicles by battalion and index, and destroys one once at a damage of 1', () => {
    const key = vehicleKey(7, 3);
    expect(parseVehicleKey(key)).toEqual({ battalion: 7, index: 3 });
    expect(parseVehicleKey('site:4')).toBeNull();
    const d = new VehicleDamage();
    expect(d.hit(key, 0.6)).toBe(false);
    expect(d.hit(key, 0.5)).toBe(true);
    expect(d.hit(key, 0.5)).toBe(false);
    expect(d.destroyed(key)).toBe(true);
  });
});

describe('promoted vehicles in the ground war (R2.8)', () => {
  const world = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(64) },
  );
  const input = campaignInput(world.graph, world.campaign.cast, world.infrastructure);
  const make = (): SimWorld =>
    createSimWorld({ ...syntheticConfig(7), radius: R, campaign: input });

  it('anchors battalions behind their own side of the line, facing it', () => {
    const w = make();
    const g = w.ground!;
    const pic = g.picture();
    expect(pic.battalions.length).toBe(g.orbat.battalions.length);
    const front = input.fronts[0]!;
    const line = g.frontLine(front.theater);
    // The line densified (its vertices lie kilometers apart).
    const dense: Dir[] = [];
    for (let i = 0; i + 3 < line.length; i += 3) {
      const a: Dir = [line[i]!, line[i + 1]!, line[i + 2]!];
      const c: Dir = [line[i + 3]!, line[i + 4]!, line[i + 5]!];
      for (let k = 0; k < 20; k++) dense.push(slerp(a, c, k / 20));
    }
    const nearLine = (p: Dir) => Math.min(...dense.map((q) => arcDistance(p, q, R)));
    let facing = 0;
    const mine = pic.battalions.filter((x) => g.orbat.battalions[x.id]!.theater === front.theater);
    for (const b of mine) {
      const d = nearLine(b.point);
      if (b.kind === 'tank' || b.kind === 'mechanized') expect(d).toBeLessThan(5e3);
      expect(d).toBeLessThan(25e3);
      // Facing the line: a step along its heading comes nearer to it than a step back
      // (the line's nearest vertex, so a bend may fool it for a few).
      if (
        nearLine(destination(b.point, b.heading, 2000, R)) <
        nearLine(destination(b.point, b.heading + Math.PI, 2000, R))
      )
        facing++;
    }
    expect(facing / mine.length).toBeGreaterThan(0.9);
  }, 120_000);

  it('folds a destroyed vehicle into its battalion’s strength, once, and keeps it dead through a save', () => {
    const host = new SimHost(make, applyInput);
    host.seek(HOUR);
    const g = host.world.ground!;
    const b = g.orbat.battalions.find((x) => x.kind === 'tank' && x.strength > 0.5)!;
    const anchor = g.battalionAnchor(b.id)!;
    const shown = promoteBattalion(
      { ...b, killed: [...g.killedOf(b.id)] },
      anchor.point,
      anchor.heading,
      R,
    );
    const before = aliveCount(b.kind, b.strength);
    const s0 = b.strength;
    const kill = (i: number) =>
      host.input({
        kind: 'vehicle-destroyed',
        battalion: b.id,
        vehicle: shown[i]!.index,
        point: shown[i]!.point,
        heading: shown[i]!.heading,
        by: null,
      });
    kill(0);
    kill(1);
    kill(1);
    expect(b.strength).toBeCloseTo(s0 - 2 / rosterSize('tank'), 12);
    expect(aliveCount(b.kind, b.strength)).toBe(before - 2);
    expect(g.killedOf(b.id)).toEqual([shown[0]!.index, shown[1]!.index].sort((x, y) => x - y));
    const pic = g.picture();
    expect(pic.wrecks.length).toBe(2);
    expect(pic.battalions.find((x) => x.id === b.id)!.killed.length).toBe(2);
    // Promoted again, the dead stay dead.
    const again = promoteBattalion(
      pic.battalions.find((x) => x.id === b.id)!,
      anchor.point,
      anchor.heading,
      R,
    );
    expect(again.some((v) => v.index === shown[0]!.index || v.index === shown[1]!.index)).toBe(
      false,
    );
    // Saved and loaded, the kills and wrecks come along.
    const saved = g.save();
    const other = make().ground!;
    other.load(saved);
    expect(other.killedOf(b.id)).toEqual(g.killedOf(b.id));
    expect(other.picture().wrecks).toEqual(pic.wrecks);
    expect(host.world.sim.log.entries.some((e) => e.kind === 'vehicle-destroyed')).toBe(true);
  }, 120_000);
});

describe('CAS destroys promoted vehicles (the exit of R2.8)', () => {
  const m = capMission();
  const t0 = phaseStart(m, 'on-target') + 100;
  const f21 = bundleOfType('f21');

  it('a bomb and a gun pass destroy vehicles, and the battalion loses the same count', () => {
    const f = promote({ ...m, aircraft: 1 }, t0);
    const model = f.aircraft[0]!.flown.airframe as unknown as FlightModel;
    const cas = f21.airWar!.loadouts.find((l) => l.id === 'cas')!;
    const rack = new StoresRack(
      kestrelSpec(),
      f21.pylons,
      cas.stations,
      { loadout: 'cas', expended: {} },
      f21.gun ?? null,
    );
    const av = { ...initialAvionics(false), masterArm: true, weapon: 'bomb-230' };
    const bomb = rack.dropBomb(model, av)!;
    const probe = { ...bomb, pos: bomb.pos.clone(), vel: bomb.vel.clone() };
    let landing: Vec3d | null = null;
    for (let t = 0; !landing && t < 120; t += 1 / 120)
      landing = flyProjectile(probe, 1 / 120, model.radius, () => 0, t)?.at ?? null;
    // A promoted battalion laid out round the bomb's landing point.
    const up = landing!.clone().normalize();
    const b = battalion({ kind: 'mechanized', id: 3 });
    const shown = promoteBattalion(b, [up.x, up.y, up.z], 0, model.radius);
    // The pilot aims at the first vehicle: the layout shifted so it stands where the bomb lands.
    const at = (v: (typeof shown)[number]) =>
      new Vec3d(v.point[0], v.point[1], v.point[2]).scale(model.radius + 1.2);
    const shift = landing!.clone().sub(at(shown[0]!));
    const targets: GroundTarget[] = shown.map((v) => ({
      id: vehicleKey(v.battalion, v.index),
      pos: at(v).add(shift),
      kind: VEHICLE_TARGETS[v.type],
    }));
    rack.groundTargets = targets;
    for (let i = 0; i < 120 * 120 && rack.ordnance.length > 0; i++)
      rack.stepWeapons(model, av, 1 / 120, t0 + i / 120, seaLevel);
    const damage = new VehicleDamage();
    let strength = b.strength;
    const killed: number[] = [];
    const apply = () => {
      for (const h of rack.hits.splice(0)) {
        const v = parseVehicleKey(h.target);
        if (v && damage.hit(h.target, h.amount)) {
          killed.push(v.index);
          strength = strengthAfterKill(b.kind, strength);
        }
      }
    };
    apply();
    const byBomb = killed.length;
    expect(byBomb).toBeGreaterThan(0);
    // The gun on a truck: rounds aimed through it kill it.
    const truck = shown.find((v) => v.type === 'truck' && !killed.includes(v.index))!;
    const tp = targets.find((x) => x.id === vehicleKey(truck.battalion, truck.index))!;
    rack.groundTargets = [tp];
    const gun = rack.gun!;
    for (let k = 0; k < 20; k++)
      gun.live.push({
        pos: tp.pos.clone().add(new Vec3d(0, 0, 400)),
        vel: new Vec3d(0, 0, -1000),
        age: 0,
        tracer: false,
      });
    const gav = { ...initialAvionics(false), masterArm: true, weapon: 'gun' };
    for (let i = 0; i < 120; i++) rack.stepGun(model, gav, 1 / 120, t0 + i / 120);
    apply();
    expect(killed).toContain(truck.index);
    // The battalion's vehicles drop by the same count as were destroyed.
    expect(aliveCount(b.kind, strength)).toBe(rosterSize(b.kind) - killed.length);
    const after = promoteBattalion({ ...b, strength, killed }, [up.x, up.y, up.z], 0, model.radius);
    for (const i of killed) expect(after.some((v) => v.index === i)).toBe(false);
  });
});
