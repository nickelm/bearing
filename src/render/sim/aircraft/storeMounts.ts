/**
 * Which stores a drawn aircraft hangs (decision 288): its bundle's pylons with a
 * loadout's stations, or the flight data's standard load (Free Flight's Kestrel and its
 * scripted traffic), each store drawn from its `store-<id>` model spec.
 */
import type { AircraftBundle } from '../../../sim/air/bundles';
import { standardStations, stationLoads } from '../../../sim/air/stores';
import type { StationLoad } from '../../../sim/air/stores';
import { MODEL_SPECS } from '../../common/models/library';
import type { ModelSpec } from '../../common/models/spec';

/** A store drawn on a station (decision 288): its model, centered where it hangs (model frame, m). */
export interface StoreMount {
  station: string;
  spec: ModelSpec;
  at: readonly [number, number, number];
}

/** The mounts of `loads`, each store's model by `modelOf` (its `store-<id>` spec); stores without one are left out. */
export function storeMounts(
  loads: readonly StationLoad[],
  modelOf: (store: string) => ModelSpec | undefined,
): StoreMount[] {
  const out: StoreMount[] = [];
  for (const l of loads) {
    const spec = modelOf(l.store);
    if (spec) out.push({ station: l.station, spec, at: l.at });
  }
  return out;
}

/** A store's drawn model, or undefined. */
export function storeModel(store: string) {
  return MODEL_SPECS[`store-${store}`];
}

/** The stations `stations` (pylon id → store id) hang on bundle `b`, and their mounts. */
export function loadoutMounts(
  b: Readonly<AircraftBundle>,
  stations: Readonly<Record<string, string>> | undefined,
): { loads: StationLoad[]; mounts: StoreMount[] } {
  if (!b.pylons || !stations) return { loads: [], mounts: [] };
  const loads = stationLoads(stations, b.pylons);
  return { loads, mounts: storeMounts(loads, storeModel) };
}

/** The mounts of a loadout of bundle `b`'s air-war type, by id. */
export function typeLoadoutMounts(b: Readonly<AircraftBundle>, loadout: string) {
  return loadoutMounts(b, b.airWar?.loadouts.find((l) => l.id === loadout)?.stations);
}

/** The mounts of a flight data's standard load (store id → count) on bundle `b`'s pylons. */
export function standardMounts(
  b: Readonly<AircraftBundle>,
  standard: Readonly<Record<string, number>> | undefined,
): StoreMount[] {
  if (!b.pylons || !standard) return [];
  return loadoutMounts(b, standardStations(b.pylons, standard)).mounts;
}
