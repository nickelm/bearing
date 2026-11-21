/** Stores drawn on their pylons, gone once released (decision 288). */
import { describe, expect, it } from 'vitest';
import type { Mesh } from 'three/webgpu';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { AircraftView } from '../src/render/sim/aircraft/aircraftView';
import { standardMounts, typeLoadoutMounts } from '../src/render/sim/aircraft/storeMounts';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';
import { AIRCRAFT_BUNDLES, bundleOfType } from '../src/sim/air/bundles';
import { STORES, standardStations } from '../src/sim/air/stores';
import { flightStores } from '../src/follow/campaignTraffic';

const fighter = AIRCRAFT_BUNDLES['alliance-fighter']!;
const visibleMeshes = (v: AircraftView) => {
  let n = 0;
  v.group.traverse((o) => {
    if ((o as Mesh).isMesh && o.visible) n++;
  });
  return n;
};

describe('stores on pylons (decision 288)', () => {
  it('has a model for every store in the catalog', () => {
    for (const id of Object.keys(STORES)) expect(MODEL_SPECS[`store-${id}`], id).toBeDefined();
  });

  it('hangs the standard load on the outermost pylons that carry it', () => {
    expect(standardStations(fighter.pylons!, { srm: 4 })).toEqual({ wingtip: 'srm', outer: 'srm' });
    expect(standardMounts(fighter, { srm: 4 }).map((m) => m.station)).toEqual([
      'wingtip.right',
      'wingtip.left',
      'outer.right',
      'outer.left',
    ]);
  });

  it('draws a loadout’s stores and hides those released', () => {
    const { mounts } = typeLoadoutMounts(bundleOfType('f21'), 'strike');
    expect(mounts.map((m) => m.station).sort()).toEqual(
      [
        'inner.left',
        'inner.right',
        'middle.left',
        'middle.right',
        'wingtip.left',
        'wingtip.right',
      ].sort(),
    );
    const bare = new AircraftView(
      MODEL_SPECS['alliance-fighter']!,
      [0, 0, 0],
      new PlanetLighting(1e6),
    );
    const v = new AircraftView(
      MODEL_SPECS['alliance-fighter']!,
      [0, 0, 0],
      new PlanetLighting(1e6),
      mounts,
    );
    // A mesh and its ink per store.
    expect(visibleMeshes(v) - visibleMeshes(bare)).toBe(2 * mounts.length);
    v.setStores(['wingtip.right', 'wingtip.left']);
    expect(visibleMeshes(v) - visibleMeshes(bare)).toBe(4);
    expect(v.storeStations).toHaveLength(6);
  });

  it('hangs nothing on a stand-in model', () => {
    const standIn = Object.values(AIRCRAFT_BUNDLES).find(
      (b) => b.airWar && !b.geometry && b.airWar.side === 'alliance',
    );
    if (!standIn) return;
    expect(
      flightStores({ aircraftType: standIn.airWar!.id, loadout: standIn.airWar!.loadouts[0]!.id })
        .mounts,
    ).toEqual([]);
  });
});
