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
import { GUN } from '../air/stores';
import { Gun } from './gun';
import { boresightOf, Missile, Seeker } from './missile';
import { sourceAt } from './missile';
import type { HeatSource } from './missile';
import { AIRCRAFT_RADIUS, blast, groundDamage, ROUND_DAMAGE } from './damage';
import type { GroundTargetKind } from './damage';
import type { WarheadSpec } from '../air/stores';
import { flyProjectile, launchProjectile } from './ordnance';
import type { Impact, Projectile } from './ordnance';
import type { GroundQuery } from './airframe';
import { modelToBody } from './rigidBody';
import { Vec3d } from '../../core/vec3d';
import type { GunSpec } from './gun';
import type { AvionicsState } from '../avionics/avionics';

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
  /** The internal gun, with the rounds not yet fired (decision 295), or null. */
  readonly gun: Gun | null;
  /** The selected IR missile's seeker (decision 297), or null while none is selected. */
  seeker: Seeker | null = null;
  /** Missiles in flight, and those whose flight ended since the app last took them. */
  readonly missiles: Missile[] = [];
  readonly finished: Missile[] = [];
  /**
   * The aircraft its seekers and missiles can see (decision 297), refreshed by the app
   * from the war or the traffic; between refreshes each is carried along its velocity.
   */
  sources: HeatSource[] = [];
  /** Bombs and rockets falling or flying, and their impacts since the app last took them (decision 300). */
  readonly ordnance: Projectile[] = [];
  readonly impacts: Impact[] = [];
  /**
   * Ground targets the bombs and rockets can damage (decision 301), set by the app: the
   * campaign's target sites and road edges near the flight, where they are drawn.
   */
  groundTargets: GroundTarget[] = [];
  /** Hits since the app last took them (decision 301): on aircraft, or on ground targets. */
  readonly hits: Hit[] = [];
  /** The trigger held for the selected rocket pods: they ripple while it is. */
  rocketTrigger = false;
  private rocketOwed = 0;
  private rocketTurn = 0;

  constructor(
    readonly spec: FlightSpec,
    pylons: readonly PylonSpec[] | null,
    stations: Readonly<Record<string, string>> | undefined,
    /** The loadout and what is expended; the rack counts its releases here. */
    readonly state: StoresState,
    gun: Readonly<GunSpec> | null = null,
  ) {
    this.gun = gun ? new Gun(gun, gun.rounds - (state.expended[GUN] ?? 0)) : null;
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

  /**
   * Steps the gun by dt (decision 295): it fires while its trigger is held, master arm is on,
   * the aircraft is off the ground and the gun is selected or the dogfight mode is up. The
   * rounds fired count as expended stores.
   */
  stepGun(m: FlightModel, avionics: Readonly<AvionicsState>, dt: number, t = 0): number {
    const g = this.gun;
    if (!g) return 0;
    const armed = avionics.masterArm && !m.onGround && gunSelected(avionics);
    const n = g.step(m, this.spec.cg, dt, m.radius, armed);
    if (n > 0) this.state.expended[GUN] = (this.state.expended[GUN] ?? 0) + n;
    // Rounds that passed within an aircraft's radius this step hit it (decision 301).
    if (this.sources.length > 0) {
      const at = new Vec3d();
      for (let i = g.live.length - 1; i >= 0; i--) {
        const r = g.live[i]!;
        for (const s of this.sources) {
          sourceAt(s, t + dt, at);
          if (segmentDistance(r.pos, r.vel, dt, at) <= (s.radius ?? AIRCRAFT_RADIUS)) {
            this.hits.push({
              target: s.id,
              air: true,
              amount: ROUND_DAMAGE,
              cause: 'gun',
              at: r.pos.clone(),
              time: t + dt,
            });
            g.live.splice(i, 1);
            break;
          }
        }
      }
    }
    // Rounds that pass within a vehicle's size hit it (R2.8, decision 334): vehicles only,
    // so sites and roads stay the bombs' and rockets'.
    const vehicles = this.groundTargets.filter((x) => (x.kind.vehicle?.round ?? 0) > 0);
    if (vehicles.length > 0) {
      for (let i = g.live.length - 1; i >= 0; i--) {
        const r = g.live[i]!;
        for (const v of vehicles) {
          if (segmentDistance(r.pos, r.vel, dt, v.pos) <= v.kind.size) {
            this.hits.push({
              target: v.id,
              air: false,
              amount: v.kind.vehicle!.round,
              cause: 'gun',
              at: r.pos.clone(),
              time: t + dt,
            });
            g.live.splice(i, 1);
            break;
          }
        }
      }
    }
    return n;
  }

  /**
   * The selected IR missile's seeker looks again at game time t (decision 297), along the
   * boresight or slaved to `slave` (a radar lock's direction). Null without one selected.
   */
  updateSeeker(
    m: FlightModel,
    avionics: Readonly<AvionicsState>,
    t: number,
    slave: Readonly<Vec3d> | null = null,
  ): Seeker | null {
    const w = avionics.weapon;
    const spec = w ? STORES[w]?.missile : null;
    if (
      !w ||
      !spec ||
      STORES[w]?.kind !== 'ir-missile' ||
      !this.loaded.some((l) => l.store === w)
    ) {
      this.seeker = null;
      return null;
    }
    if (this.seeker?.spec !== spec) this.seeker = new Seeker(spec);
    this.seeker.update(m.pos, boresightOf(m.q), this.sources, t, slave);
    return this.seeker;
  }

  /**
   * Launches the selected IR missile at game time t (decision 297): with master arm on, in
   * the air, one left; it leaves its station with the aircraft's velocity, pushed clear,
   * at the seeker's target. Returns it, or null.
   */
  launch(
    m: FlightModel,
    avionics: Readonly<AvionicsState>,
    t: number,
    shooter: string,
  ): Missile | null {
    const w = avionics.weapon;
    const s = w ? STORES[w] : undefined;
    if (!w || !s?.missile || !avionics.masterArm || m.onGround) return null;
    const station = this.release(m, w);
    if (!station) return null;
    const pos = m.pos.clone().add(m.q.rotate(modelToBody(station.at, this.spec.cg)));
    const vel = m.vel.clone().add(m.q.rotate(new Vec3d(0, 0, 3)));
    const missile = new Missile(
      w,
      s.missile,
      s.mass,
      s.dragArea,
      pos,
      vel,
      this.seeker?.target ?? null,
      shooter,
      t,
    );
    this.missiles.push(missile);
    return missile;
  }

  /** Rockets left in the loaded pods of `store` (decision 300). */
  rocketsLeft(store: string): number {
    const r = STORES[store]?.rocket;
    if (!r) return 0;
    const pods = this.loadedList.filter((l) => l.store === store).length;
    return Math.max(0, pods * r.count - (this.state.expended[rocketKey(store)] ?? 0));
  }

  /**
   * Releases the selected bomb (decision 300), with master arm on, in the air: one per
   * press, from its next station. Returns the bomb, or null.
   */
  dropBomb(m: FlightModel, avionics: Readonly<AvionicsState>): Projectile | null {
    const w = avionics.weapon;
    if (!w || STORES[w]?.kind !== 'bomb' || !avionics.masterArm || m.onGround) return null;
    const station = this.release(m, w);
    if (!station) return null;
    const p = launchProjectile(w, this.stationPos(m, station.at), m.vel, m.q);
    if (p) this.ordnance.push(p);
    return p;
  }

  /** Where a station hangs in the world now (m). */
  private stationPos(m: FlightModel, at: readonly [number, number, number]): Vec3d {
    return m.pos.clone().add(m.q.rotate(modelToBody(at, this.spec.cg)));
  }

  /** Fires the selected rocket pods while their trigger is held: alternate pods at the ripple rate. */
  private stepRockets(m: FlightModel, avionics: Readonly<AvionicsState>, dt: number): void {
    const w = avionics.weapon;
    const r = w ? STORES[w]?.rocket : null;
    if (!w || !r || !this.rocketTrigger || !avionics.masterArm || m.onGround) {
      this.rocketOwed = 0;
      return;
    }
    this.rocketOwed += r.ripple * dt;
    while (this.rocketOwed >= 1 && this.rocketsLeft(w) > 0) {
      this.rocketOwed -= 1;
      const pods = this.loadedList.filter((l) => l.store === w);
      const pod = pods[this.rocketTurn++ % pods.length]!;
      const p = launchProjectile(w, this.stationPos(m, pod.at), m.vel, m.q);
      if (p) this.ordnance.push(p);
      const k = rocketKey(w);
      this.state.expended[k] = (this.state.expended[k] ?? 0) + 1;
    }
  }

  /** Steps the gun and the missiles in flight by dt from game time t (decisions 295, 297). */
  stepWeapons(
    m: FlightModel,
    avionics: Readonly<AvionicsState>,
    dt: number,
    t: number,
    ground: GroundQuery | null = null,
  ): void {
    this.stepGun(m, avionics, dt, t);
    this.stepRockets(m, avionics, dt);
    const groundAt = (d: Readonly<Vec3d>) => (ground ? ground.height(d) : 0);
    for (let i = this.ordnance.length - 1; i >= 0; i--) {
      const hit = flyProjectile(this.ordnance[i]!, dt, m.radius, groundAt, t);
      if (hit) {
        this.ordnance.splice(i, 1);
        this.impacts.push(hit);
        const w = STORES[hit.store]?.warhead;
        if (w) this.splash(w, hit.at, hit.time, hit.kind);
      } else if (this.ordnance[i]!.age > 120) this.ordnance.splice(i, 1);
    }
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const x = this.missiles[i]!;
      x.step(dt, t, m.radius, this.sources, ground ? (d) => ground.height(d) : null);
      if (x.state !== 'flying') {
        this.missiles.splice(i, 1);
        this.finished.push(x);
        const w = STORES[x.store]?.warhead;
        if (x.burst && w) this.splash(w, x.burst.at, t + dt, 'missile');
      }
    }
  }

  /**
   * A warhead bursting at `at` (decision 301): its blast on every aircraft and ground target
   * within its reach, as hits.
   */
  private splash(
    w: Readonly<WarheadSpec>,
    at: Readonly<Vec3d>,
    t: number,
    cause: Hit['cause'],
  ): void {
    const p = new Vec3d();
    for (const s of this.sources) {
      const d = Math.max(0, sourceAt(s, t, p).distanceTo(at) - (s.radius ?? AIRCRAFT_RADIUS));
      const amount = blast(w, d);
      if (amount > 0)
        this.hits.push({ target: s.id, air: true, amount, cause, at: at.clone(), time: t });
    }
    for (const g of this.groundTargets) {
      const amount = groundDamage(w, g.pos.distanceTo(at), g.kind);
      if (amount > 0)
        this.hits.push({ target: g.id, air: false, amount, cause, at: at.clone(), time: t });
    }
  }

  /** Drops every tank with the fuel in it; returns how many went. */
  jettisonTanks(m: FlightModel): number {
    const tanks = this.loadedList.filter((l) => STORES[l.store]?.kind === 'tank');
    for (const t of tanks) this.release(m, t.store);
    m.tankFuel = 0;
    return tanks.length;
  }
}

/**
 * Whether the trigger is the gun's (decisions 295, 297): the gun selected, or the dogfight
 * mode with no weapon selected.
 */
export function gunSelected(avionics: Readonly<AvionicsState>): boolean {
  return (
    avionics.weapon === GUN || (avionics.masterMode === 'dogfight' && avionics.weapon === null)
  );
}

/** The expended key that counts the rockets fired from the pods of `store` (decision 300). */
export function rocketKey(store: string): string {
  return `${store}#fired`;
}

/** Rockets left by pod store in `loaded`, after the rockets `expended` counts (decision 300). */
export function rocketCounts(
  loaded: readonly StationLoad[],
  expended: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of loaded) {
    const r = STORES[l.store]?.rocket;
    if (r) out[l.store] = (out[l.store] ?? 0) + r.count;
  }
  for (const k of Object.keys(out)) out[k] = Math.max(0, out[k]! - (expended[rocketKey(k)] ?? 0));
  return out;
}

/** A ground target the bombs and rockets can damage (decision 301). */
export interface GroundTarget {
  /** `site:<id>` for a target site, `road:<edge>` for a road edge, `vehicle:<battalion>:<index>` for a vehicle. */
  id: string;
  /** Where it is drawn (world, m). */
  pos: Vec3d;
  kind: GroundTargetKind;
}

/** A hit (decision 301): on an aircraft (damage 0..1 to add) or a ground target (a hit's amount). */
export interface Hit {
  target: string;
  air: boolean;
  amount: number;
  cause: 'gun' | 'missile' | 'bomb' | 'rocket';
  at: Vec3d;
  time: number;
}

/** The least distance (m) from `p` to a round's path over the last dt, ending at `pos` with `vel`. */
function segmentDistance(
  pos: Readonly<Vec3d>,
  vel: Readonly<Vec3d>,
  dt: number,
  p: Readonly<Vec3d>,
): number {
  // From a = pos − vel·dt to b = pos.
  const ax = pos.x - vel.x * dt - p.x;
  const ay = pos.y - vel.y * dt - p.y;
  const az = pos.z - vel.z * dt - p.z;
  const dx = vel.x * dt;
  const dy = vel.y * dt;
  const dz = vel.z * dt;
  const l2 = dx * dx + dy * dy + dz * dz;
  const k = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy + az * dz) / l2)) : 0;
  return Math.hypot(ax + dx * k, ay + dy * k, az + dz * k);
}
