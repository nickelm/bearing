import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { arcDistance } from '../src/core/greatCircle';
import { HOUR, MINUTE } from '../src/core/units';
import { campaignInput } from '../src/sim/command/campaignInput';
import { DIVISION_FRONTAGE } from '../src/sim/ground/orbat';
import { CAS_KILL, MAX_OFFSET, MAX_SHEAR } from '../src/sim/ground/war';
import { createSimWorld } from '../src/sim/world';
import type { SimWorld } from '../src/sim/world';
import { buildGroundOverlays } from '../src/render/strategic/overlays/groundModel';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { syntheticConfig } from './helpers/weatherWorld';

const R = DEFAULT_PLANET_PARAMS.radius;
const world = generateCampaignWorld(
  { ...DEFAULT_PLANET_PARAMS, seed: 7 },
  { grid: new CubeGrid(64) },
);
const input = campaignInput(world.graph, world.campaign.cast, world.infrastructure);
const make = (extra: object = {}): SimWorld =>
  createSimWorld({ ...syntheticConfig(7), radius: R, campaign: input, ...extra });
const front = input.fronts[0]!;
const attacker = front.attacker;
const defender = attacker === 'alliance' ? 'pact' : 'alliance';

describe('the ground order of battle', () => {
  const w = make();
  const g = w.ground!;
  const o = g.orbat;

  it('fields divisions of brigades or regiments of battalions on both sides, the Pact more of them', () => {
    expect(input.fronts.length).toBeGreaterThan(0);
    const divs = (side: string) =>
      o.divisions.filter((d) => d.side === side && d.theater === front.theater).length;
    expect(divs('pact')).toBeGreaterThanOrEqual(divs('alliance'));
    expect(DIVISION_FRONTAGE.pact).toBeLessThan(DIVISION_FRONTAGE.alliance);
    for (const d of o.divisions) expect(d.brigades.length).toBe(3);
    for (const b of o.battalions) {
      expect(o.brigades[b.brigade]!.battalions).toContain(b.id);
      expect(b.strength).toBe(1);
    }
    expect(new Set(o.battalions.map((b) => b.seed)).size).toBe(o.battalions.length);
  });

  it('is the same world when built again', () => {
    const again = make().ground!.orbat;
    expect(again).toEqual(o);
  });

  it('masses the attacker where the pressure is', () => {
    const segs = w.ground!.segments().filter((s) => s.theater === front.theater);
    const count = (side: string, k: number) =>
      o.battalions.filter((b) => b.side === side && b.theater === front.theater && b.segment === k)
        .length;
    const hot = segs.reduce((a, s) => (s.pressure > a.pressure ? s : a));
    const cold = segs.reduce((a, s) => (s.pressure < a.pressure ? s : a));
    expect(count(attacker, hot.index) / (hot.to - hot.from)).toBeGreaterThan(
      count(attacker, cold.index) / (cold.to - cold.from),
    );
  });
});

describe('a day of ground war', () => {
  const w = make();
  for (let t = 10 * MINUTE; t <= 24 * HOUR; t += 10 * MINUTE) w.sim.advanceTo(t);
  const g = w.ground!;

  it('moves the front within its limits, holding together', () => {
    const off = g.frontOffsets(front.theater);
    expect(Math.max(...off.map(Math.abs))).toBeGreaterThan(1000);
    for (const v of off) expect(Math.abs(v)).toBeLessThanOrEqual(MAX_OFFSET);
    for (let i = 1; i < off.length; i++)
      expect(Math.abs(off[i]! - off[i - 1]!)).toBeLessThanOrEqual(MAX_SHEAR + 1e-6);
    // The line now lies where the offsets put it.
    const line = g.frontLine(front.theater);
    expect(line.length).toBe(front.points.length);
  });

  it('costs both sides strength', () => {
    for (const side of [attacker, defender]) {
      const lost = g.orbat.battalions.filter((b) => b.side === side && b.strength < 1).length;
      expect(lost, side).toBeGreaterThan(0);
    }
  });

  it('lets the ATO plan at the moved front', () => {
    const segs = g.segments();
    const p = w.ato!.context(attacker, w.sim.time, 1).frontPoint(front.theater, 0.5, 0);
    const mid = g.frontPoint(front.theater, 0.5, attacker, 0)!;
    expect(arcDistance(p!.point, mid.point, R)).toBeLessThan(1);
    expect(segs.some((s) => s.pressure > 0)).toBe(true);
  });
});

describe('supply and air support', () => {
  it('kills troops where CAS attacks', () => {
    const w = make();
    w.sim.advanceTo(MINUTE);
    const g = w.ground!;
    const seg = g.segments().find((s) => s.theater === front.theater)!;
    const before = g.strengthOf(front.theater, defender);
    w.damage!.attacks.push({
      time: 60,
      side: attacker,
      theater: front.theater,
      point: seg.point,
      amount: 10,
    });
    w.sim.advanceTo(2 * MINUTE);
    const after = g.strengthOf(front.theater, defender);
    // CAS_KILL per unit, besides a minute of fighting.
    expect(before - after).toBeGreaterThan(0.8 * CAS_KILL * 10);
  });

  it('falls behind cut bridges and damaged depots', () => {
    const w = make();
    w.sim.advanceTo(1);
    const g = w.ground!;
    const segs = g.segments().filter((s) => s.theater === front.theater);
    const mean = () =>
      segs.reduce((a, s) => a + g.supplyOf(front.theater, s.index, defender), 0) / segs.length;
    const full = mean();
    for (const x of input.targets) {
      if (
        x.side === defender &&
        (x.bridge || x.kind === 'supply-depot' || x.kind === 'fuel-depot')
      ) {
        w.damage!.hit(x.id, 1);
      }
    }
    w.sim.advanceTo(HOUR + 1);
    expect(mean()).toBeLessThan(full);
  });

  it('ends a day with a different front when one side flies no air support', () => {
    const full = make();
    const none = make({ suppressAirSupport: attacker });
    full.sim.advanceTo(24 * HOUR);
    none.sim.advanceTo(24 * HOUR);
    expect(none.ground!.frontOffsets(front.theater)).not.toEqual(
      full.ground!.frontOffsets(front.theater),
    );
    expect(none.damage!.attacks.filter((a) => a.side === attacker).length).toBe(0);
  });
});

describe('the map of the ground war', () => {
  it('draws brigades as unit symbols for the viewing side, and the front where it is now', () => {
    const w = make();
    w.sim.advanceTo(6 * HOUR);
    const pic = w.ground!.picture();
    const both = buildGroundOverlays(pic, { side: 'both' });
    expect(both.marks.length).toBe(pic.units.filter((u) => u.strength >= 0.15).length);
    const mine = buildGroundOverlays(pic, { side: 'alliance' });
    expect(mine.marks.every((m) => m.badge?.fill !== undefined)).toBe(true);
    expect(mine.marks.length).toBe(
      pic.units.filter((u) => u.side === 'alliance' && u.strength >= 0.15).length,
    );
    expect(new Set(both.marks.map((m) => m.shape))).toEqual(new Set(['unit-armor', 'unit-mech']));
    expect(pic.fronts[0]!.points.length).toBe(front.points.length);
  });
});
