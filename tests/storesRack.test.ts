/** Stores on the flight model and drop tanks with fuel (decision 287). */
import { describe, expect, it } from 'vitest';
import { AIRCRAFT_BUNDLES, bundleOfType } from '../src/sim/air/bundles';
import { STORES, stationLoads } from '../src/sim/air/stores';
import { dragCoefficient, emptyDrag } from '../src/sim/flight/drag';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { parseFlightSpec } from '../src/sim/flight/flightSpec';
import { FIGHT_RANGE } from '../src/sim/flight/promotedFlight';
import { loadedStations, storesEffect, StoresRack } from '../src/sim/flight/storesRack';
import { modelSpec } from '../src/render/common/models/library';
import { kestrel, kestrelSpec } from './helpers/flight';
import { capMission, phaseStart, promote, seaLevel } from './helpers/promoted';

const f21 = bundleOfType('f21');
const stations = (id: string) => f21.airWar!.loadouts.find((l) => l.id === id)!.stations!;
const rack = (id: string, expended: Record<string, number> = {}) =>
  new StoresRack(kestrelSpec(), f21.pylons, stations(id), { loadout: id, expended });

describe('stores on the flight model (decision 287)', () => {
  it('adds nothing for the flight data’s standard load', () => {
    const loads = stationLoads({ wingtip: 'srm', outer: 'srm' }, f21.pylons!);
    expect(storesEffect(loads, kestrelSpec().standardStores)).toEqual({
      mass: 0,
      dragArea: 0,
      tankCapacity: 0,
    });
  });

  it('adds what hangs beyond it, and takes away what is missing from it', () => {
    const aa = rack('air-to-air');
    expect(aa.effect.mass).toBeCloseTo(2 * STORES.mrm!.mass + 2 * 140, 9);
    expect(aa.effect.tankCapacity).toBe(2240);
    expect(aa.capacity).toBe(3200 + 2240);
    // The strike load hangs two short-range missiles fewer than the standard four.
    const strike = rack('strike');
    expect(strike.effect.mass).toBeCloseTo(2 * 925 + 2 * 140 - 2 * 86, 9);
    expect(strike.effect.dragArea).toBeCloseTo(2 * 0.035 + 2 * 0.045 - 2 * 0.008, 9);
  });

  it('turns the drag area into the stores’ drag coefficient over the wing', () => {
    const spec = kestrelSpec();
    const s = {
      cl: 0.3,
      alpha: 0.05,
      mach: 0.8,
      gear: 0,
      flaps: 0,
      gearDamaged: false,
      speedbrake: 0,
      groundEffect: 0,
    };
    const a = dragCoefficient(spec, s, emptyDrag());
    const b = dragCoefficient(spec, { ...s, storesArea: 0.14 }, emptyDrag());
    expect(b - a).toBeCloseTo(0.14 / spec.wing.area, 12);
  });

  it('every flown type’s air-war fuel is its internal fuel and its loadouts’ tanks', () => {
    for (const b of Object.values(AIRCRAFT_BUNDLES)) {
      if (!b.hasFlight || b.hasRotors || !b.airWar || !b.pylons) continue;
      const spec = parseFlightSpec(modelSpec(b.id).flight, b.id);
      for (const l of b.airWar.loadouts) {
        if (!l.stations) continue;
        const r = new StoresRack(spec, b.pylons, l.stations, { loadout: l.id, expended: {} });
        expect(r.capacity, `${b.id} ${l.id}`).toBe(b.airWar.fuel);
      }
    }
  });

  it('empties the same stations for the same counts expended', () => {
    const loads = stationLoads(stations('air-to-air'), f21.pylons!);
    const left = loadedStations(loads, { srm: 1, 'tank-1400': 2 });
    expect(left.map((l) => l.station)).toEqual([
      'wingtip.left',
      'outer.right',
      'outer.left',
      'middle.right',
      'middle.left',
    ]);
  });

  it('burns the tanks first, and drops them with the fuel left in them', () => {
    const cap = capMission();
    const f = promote({ ...cap, aircraft: 1 }, phaseStart(cap, 'on-target') + 200);
    const a = f.aircraft[0]!;
    const m = a.flown.airframe as FlightModel;
    const r = a.rack;
    r.load(m, 5000);
    expect(m.fuel).toBe(5000);
    expect(m.tankFuel).toBe(1800);
    const mass0 = m.mass;
    a.flown.controls.throttle = 1;
    for (let i = 0; i < 600; i++) a.flown.step(seaLevel);
    const burned = 5000 - m.fuel;
    expect(burned).toBeGreaterThan(2);
    expect(m.tankFuel).toBeCloseTo(1800 - burned, 6);
    // Internal fuel is untouched while the tanks hold some.
    expect(m.fuel - m.tankFuel).toBeCloseTo(3200, 6);
    expect(r.jettisonTanks(m)).toBe(2);
    expect(m.tankFuel).toBe(0);
    expect(m.fuel).toBeCloseTo(3200, 6);
    expect(m.mass).toBeCloseTo(mass0 - 1800 - 2 * 140, 6);
    expect(m.storesDragArea).toBeCloseTo(2 * 0.025, 9);
    expect(r.state.expended).toEqual({ 'tank-1400': 2 });
    expect(r.hasTanks).toBe(false);
    // Promoted again with the tanks gone, the aircraft holds internal fuel at most.
    const again = rack('air-to-air', r.state.expended);
    const m2 = kestrel();
    again.load(m2, 5000);
    expect(m2.fuel).toBe(3200);
    expect(m2.tankFuel).toBe(0);
    expect(again.capacity).toBe(5440);
  });
});

describe('the AI drops its tanks before a fight (decision 287)', () => {
  const m = capMission();
  const t0 = phaseStart(m, 'on-target') + 200;

  it('keeps them with no enemy near', () => {
    const f = promote({ ...m, aircraft: 2 }, t0, () => FIGHT_RANGE + 10_000);
    for (let t = t0; t < t0 + 5; t += 1 / 30) f.advanceTo(t, seaLevel);
    expect(f.aircraft.every((a) => a.rack.hasTanks)).toBe(true);
  });

  it('drops them when an enemy flight comes within reach, but leaves the player’s', () => {
    let near = FIGHT_RANGE + 10_000;
    const f = promote({ ...m, aircraft: 2 }, t0, () => near);
    f.takeOver(0);
    for (let t = t0; t < t0 + 2; t += 1 / 30) f.advanceTo(t, seaLevel);
    near = FIGHT_RANGE - 1000;
    for (let t = t0 + 2; t < t0 + 5; t += 1 / 30) f.advanceTo(t, seaLevel);
    const [player, wing] = f.aircraft;
    expect(player!.rack.hasTanks).toBe(true);
    expect(wing!.rack.hasTanks).toBe(false);
    expect((wing!.flown.airframe as FlightModel).tankFuel).toBe(0);
    expect(f.handback().stores.find((s) => s.slot === 1)!.expended).toEqual({ 'tank-1400': 2 });
    // The player drops theirs with the key.
    expect(f.jettisonPlayerTanks()).toBe(2);
    expect(player!.rack.hasTanks).toBe(false);
  });
});
