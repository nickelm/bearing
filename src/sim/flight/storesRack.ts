/**
 * The stores an aircraft at full fidelity carries (roadmap R2.6, decision 287): the
 * stations of its loadout still loaded, and what they do to the flight model.
 *
 * - **Beyond the standard load.** The flight data's mass and CD0 table already hold its
 *   `standardStores` (the F-21's four short-range missiles), so the rack gives the flight
 *   model the mass and drag area of the difference, store by store: more missiles, bombs
 *   or tanks add, fewer than the standard load take away. With the standard load the
 *   flight model is its spec's, bit for bit.
 * - **Drop tanks** hold fuel (`StoreSpec.fuel`) that the engine burns first; it is part
 *   of the flight model's `fuel` (`tankFuel` says how much). Their dry mass is a store's.
 *   `capacity` is the fuel the loadout takes, internal plus every tank it hangs: the air
 *   war's load maps onto it (promotion.ts), so a full route is full tanks.
 * - **Release.** `release` takes the next of a store off; `jettisonTanks` drops every tank with
 *   the fuel left in it. Both count the store as expended in `state`, which the handback
 *   carries to the campaign (decision 275), so a tank dropped stays dropped.
 * - **Order.** Which stations an expended count empties is fixed: the loadout's stations
 *   in pylon order, right before left (`loadedStations`), so a promotion with stores
 *   expended before hangs the same ones again.
 *
 * Headless: the sim's types only.
 */
import { STORES, remainingStores, stationLoads, storeCounts } from '../air/stores';
import type { PylonSpec, StationLoad } from '../air/stores';
import type { FlightModel } from './flightModel';
import type { FlightSpec } from './flightSpec';
import type { StoresState } from './promotion';

/** The stations of `loads` still loaded after `expended` (store id → count): each store's first ones go first. */
export function loadedStations(
  loads: readonly StationLoad[],
  expended: Readonly<Record<string, number>>,
): StationLoad[] {
  const gone: Record<string, number> = { ...expended };
  return loads.filter((l) => {
    const n = gone[l.store] ?? 0;
    if (n <= 0) return true;
    gone[l.store] = n - 1;
    return false;
  });
}

/** What hanging `loaded` instead of the `standard` load does to the flight model. */
export interface StoresEffect {
  /** kg, without the tanks' fuel; negative with fewer than the standard load. */
  mass: number;
  /** m². */
  dragArea: number;
  /** kg of fuel the loaded tanks hold full. */
  tankCapacity: number;
}

export function storesEffect(
  loaded: readonly StationLoad[],
  standard: Readonly<Record<string, number>> = {},
): StoresEffect {
  const n = storeCounts(loaded);
  let mass = 0;
  let dragArea = 0;
  let tankCapacity = 0;
  for (const id of new Set([...Object.keys(n), ...Object.keys(standard)])) {
    const s = STORES[id];
    if (!s) continue;
    const extra = (n[id] ?? 0) - (standard[id] ?? 0);
    mass += extra * (s.mass - s.fuel);
    dragArea += extra * s.dragArea;
    tankCapacity += (n[id] ?? 0) * s.fuel;
  }
  return { mass, dragArea, tankCapacity };
}

export class StoresRack {
  /** Every station of the loadout, loaded or not, in release order. */
  readonly stations: readonly StationLoad[];
  /** Fuel the loadout takes (kg): internal plus every tank it hangs, dropped or not. */
  readonly capacity: number;
  private loadedList: StationLoad[];

  constructor(
    readonly spec: FlightSpec,
    pylons: readonly PylonSpec[] | null,
    stations: Readonly<Record<string, string>> | undefined,
    /** The loadout and what is expended; the rack counts its releases here. */
    readonly state: StoresState,
  ) {
    this.stations = pylons && stations ? stationLoads(stations, pylons) : [];
    this.loadedList = loadedStations(this.stations, state.expended);
    this.capacity = spec.mass.fuel + storesEffect(this.stations, spec.standardStores).tankCapacity;
  }

  /** The stations still loaded. */
  get loaded(): readonly StationLoad[] {
    return this.loadedList;
  }

  /** What is left of each store. */
  get counts(): Record<string, number> {
    return remainingStores(this.stations, this.state.expended);
  }

  get effect(): StoresEffect {
    return storesEffect(this.loadedList, this.spec.standardStores);
  }

  /** Whether any tank still hangs. */
  get hasTanks(): boolean {
    return this.loadedList.some((l) => STORES[l.store]?.kind === 'tank');
  }

  /**
   * Hangs the stores on `m` with `fuel` aboard (kg, at most internal plus the loaded
   * tanks): the internal tanks fill first, so the drop tanks hold what is left over.
   */
  load(m: FlightModel, fuel: number): void {
    const e = this.effect;
    m.storesMass = e.mass;
    m.storesDragArea = e.dragArea;
    m.fuel = Math.max(0, Math.min(this.spec.mass.fuel + e.tankCapacity, fuel));
    m.tankFuel = Math.max(0, m.fuel - this.spec.mass.fuel);
  }

  /**
   * Takes the next `store` off (fired, released or dropped): its first loaded station in
   * release order, so the stations loaded always follow from the counts expended. Returns
   * the station, or null when none is loaded.
   */
  release(m: FlightModel, store: string): StationLoad | null {
    const i = this.loadedList.findIndex((l) => l.store === store);
    if (i < 0) return null;
    const l = this.loadedList[i]!;
    // A tank goes with its share of the fuel left in the tanks.
    if (STORES[store]?.kind === 'tank') {
      const tanks = this.loadedList.filter((x) => STORES[x.store]?.kind === 'tank').length;
      const share = m.tankFuel / tanks;
      m.fuel = Math.max(0, m.fuel - share);
      m.tankFuel = Math.max(0, m.tankFuel - share);
    }
    this.loadedList.splice(i, 1);
    this.state.expended[store] = (this.state.expended[store] ?? 0) + 1;
    const e = this.effect;
    m.storesMass = e.mass;
    m.storesDragArea = e.dragArea;
    return l;
  }

  /** Drops every tank with the fuel in it; returns how many went. */
  jettisonTanks(m: FlightModel): number {
    const tanks = this.loadedList.filter((l) => STORES[l.store]?.kind === 'tank');
    for (const t of tanks) this.release(m, t.store);
    m.tankFuel = 0;
    return tanks.length;
  }
}
