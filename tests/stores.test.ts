import { describe, expect, it } from 'vitest';
import { bundleOfType, parseBundle } from '../src/sim/air/bundles';
import {
  remainingStores,
  stationLoads,
  STORES,
  storeCounts,
  storesLoad,
} from '../src/sim/air/stores';

const f21 = bundleOfType('f21');
const loadout = (id: string) => f21.airWar!.loadouts.find((l) => l.id === id)!;

describe('stores and pylons (decision 285)', () => {
  it('has a catalog with masses, sizes and drag', () => {
    expect(Object.keys(STORES).sort()).toEqual([
      'bomb-230',
      'bomb-900',
      'mrm',
      'rockets-19',
      'srm',
      'srm-p',
      'tank-1100',
      'tank-1400',
    ]);
    for (const s of Object.values(STORES)) expect(s.mass).toBeGreaterThan(50);
    // One IR missile per side, each with its seeker, motor and guidance (decision 297).
    for (const id of ['srm', 'srm-p']) {
      const m = STORES[id]!.missile!;
      expect(m.cone).toBeLessThan(m.gimbal);
      expect(m.propellant).toBeLessThan(STORES[id]!.mass);
    }
  });

  it('hangs the F-21’s loadouts as their descriptions say', () => {
    const aa = stationLoads(loadout('air-to-air').stations!, f21.pylons!);
    expect(storeCounts(aa)).toEqual({ srm: 4, mrm: 2, 'tank-1400': 2 });
    const strike = stationLoads(loadout('strike').stations!, f21.pylons!);
    expect(storeCounts(strike)).toEqual({ srm: 2, 'bomb-900': 4, 'tank-1100': 1 });
    // The long-range variant trades two bombs for two wing tanks (decision 294).
    const long = stationLoads(loadout('strike/long').stations!, f21.pylons!);
    expect(storeCounts(long)).toEqual({ srm: 2, 'bomb-900': 2, 'tank-1400': 2 });
    // Mirrored pylons carry on both sides, at mirrored places.
    const tips = aa.filter((l) => l.pylon === 'wingtip');
    expect(tips.map((l) => l.station)).toEqual(['wingtip.right', 'wingtip.left']);
    expect(tips[0]!.at[2]).toBe(-tips[1]!.at[2]);
    expect(storesLoad(storeCounts(strike)).mass).toBeCloseTo(2 * 86 + 4 * 925 + 1050, 6);
  });

  it('counts what is left after stores are expended, never below zero', () => {
    const aa = stationLoads(loadout('air-to-air').stations!, f21.pylons!);
    expect(remainingStores(aa, { srm: 1, mrm: 5 })).toEqual({ srm: 3, mrm: 0, 'tank-1400': 2 });
  });

  it('refuses a loadout on a pylon that does not carry its store', () => {
    const raw = {
      name: 'Test',
      class: 'fighter',
      pylons: [{ id: 'tip', at: [0, 0, 5], mirror: true, carries: ['srm'] }],
      airWar: {
        id: 'test',
        side: 'alliance',
        role: 'fighter',
        reference: 'none',
        order: 99,
        flightSize: 2,
        cruiseSpeedKt: 450,
        lowLevelSpeedKt: 450,
        maxSpeedKt: 1000,
        cruiseAltitude: 9000,
        ceiling: 15000,
        climbRate: 50,
        combatRadiusKm: 500,
        stationTimeMin: 15,
        fuel: 3000,
        loadouts: [{ id: 'a', stores: 'x', radiusFactor: 1, stations: { tip: 'bomb-900' } }],
      },
    };
    expect(() => parseBundle(raw, 'test')).toThrow(/does not carry/);
  });
});
