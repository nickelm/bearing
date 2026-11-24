/**
 * Air operations state in the sim (C2): the order of battle, the carrier
 * groups' tracks and every live mission (planned or flying). The command
 * layer (sim/command/) plans missions and hands them to `launch`; from then
 * on the mission runs on scheduled events:
 *
 * - **Phase events** (AIR_PHASE_EVENT) at each phase start of its timeline.
 *   Positions between them are analytic (route.ts), so the events only mark
 *   state changes: later milestones hang subscriptions, auto-slowdown and
 *   mission resolution on them.
 * - **Completion** frees the flight into turnaround: AIR_READY_EVENT returns
 *   its aircraft to the squadron after the type's turnaround time.
 *
 * - **Resolution** (R2.2): a phase hook (`resolution`) resolves engagements and
 *   effects at phase events. A flight can lose aircraft (`lose`: the squadron's
 *   strength falls, its crews eject as survivors or are killed) and turn home
 *   (`abort`: the route is cut and turned home, the later phase events are
 *   cancelled by id and new ones scheduled).
 *
 * Aircraft are conserved: each squadron's strength is its available aircraft
 * plus those on live missions plus those in turnaround (tested); losses lower
 * the strength and the flight together.
 */
import type { Side } from '../../campaign/cast';
import { rng } from '../../core/rng';
import type { Rng, WorldSeed } from '../../core/rng';
import type { Dir } from '../../core/greatCircle';
import { HOUR } from '../../core/units';
import type { GameTime } from '../../core/units';
import type { Simulation } from '../simulation';
import type { StateHasher } from '../stateHash';
import type { CampaignInput } from '../command/campaignInput';
import { carrierState, carrierTrack } from '../naval/carrierGroup';
import type { CarrierTrack } from '../naval/carrierGroup';
import { aircraftType, loadoutFuel, loadoutTanks } from './aircraft';
import type { HandbackFix, HandbackLoss, HandbackStores } from '../eventLog';
import { jumpInOpen, missionPhase as missionPhaseAt, MISSION_PROFILES } from './mission';
import type { BaseRef, Mission, MissionPhase } from './mission';
import { REJOIN_BANK, rejoinRoute, turnToward } from './missionRoute';
import { buildOrderOfBattle, baseIndex } from './orbat';
import type { AirBaseRecord, BaseStocks, OrderOfBattle, Squadron } from './orbat';
import { returnRoute, routeState, routeTimeline } from './route';
import { clearanceFor, floorRoute } from './terrainFloor';
import { MISSION_LABELS } from './mission';
import { SUBSCRIPTION_EVENT, Subscriptions } from './subscriptions';
import type { SubscriptionHit } from './subscriptions';
import type { GroundSource } from './terrainFloor';
import { groupOf, newSurvivor, survivorStream } from './survivors';
import type { Survivor, SurvivorState } from './survivors';

export const AIR_PHASE_EVENT = 'air:phase';
export const AIR_READY_EVENT = 'air:ready';
/** A survivor came down (R2.9): the side's order plans its rescue at once. */
export const SURVIVOR_EVENT = 'air:survivor';
/** Share of a lost aircraft's crew who eject (the rest are killed). */
export const EJECT_CHANCE = 0.75;

export type { Survivor } from './survivors';
/**
 * Hours a crew rests after it lands before it flies again (R2.9): the roster, not the
 * aircraft, then limits how often a busy squadron flies.
 */
export const CREW_REST = 6 * HOUR;

/** Resolves engagements and effects at phase events (R2.2's MissionResolution). */
export interface PhaseHook {
  phase(m: Mission, phase: MissionPhase, sim: Simulation): void;
}

/** AirOps' saved state (R1.2). */
export interface AirOpsState {
  /** Per squadron: aircraft on strength, aircraft available, aircrew on the roster. */
  squadrons: [number, number, string[]][];
  stocks: BaseStocks[];
  missions: Mission[];
  launched: Record<Side, number>;
  completed: Record<Side, number>;
  turnaround: number[];
  /** Aircraft in turnaround: squadron, ready time, aircraft. */
  ready: [number, number, number][];
  /** Phase event ids of each live mission. */
  events: [number, number[]][];
  lost: Record<Side, number>;
  killed: Record<Side, number>;
  survivors: Survivor[];
  /** Crews resting after a sortie: squadron, until, seats (R2.9; absent before decision 353). */
  resting?: [number, number, number][];
  nextSurvivor: number;
  nextMission: number;
  nextPackage: number;
  revision: number;
}

interface PhaseEvent {
  mission: number;
  phase: MissionPhase;
}

interface ReadyEvent {
  squadron: number;
  aircraft: number;
}

/** Munition loads a mission type draws per aircraft. */
const ARMED = new Set([
  'interdiction',
  'deep-strike',
  'stealth-strike',
  'sead',
  'cas',
  'helo-cas',
  'anti-shipping',
  'strategic-bombing',
]);

/** The cause of a loss whose crew ejected at full fidelity: all of it survives (decision 301). */
export const EJECTED = 'ejected';

export class AirOps {
  readonly orbat: OrderOfBattle;
  readonly carriers: CarrierTrack[];
  readonly radius: number;
  /** The player's mission subscriptions (R1.4). */
  readonly subscriptions = new Subscriptions();
  /** Live missions by id (planned or flying), in launch order. */
  readonly missions = new Map<number, Mission>();
  /** Bumped whenever a mission is added or removed (snapshots resend the list). */
  revision = 0;
  /** Missions launched and completed per side, and aircraft in turnaround per squadron. */
  readonly launched: Record<Side, number> = { alliance: 0, pact: 0 };
  readonly completed: Record<Side, number> = { alliance: 0, pact: 0 };
  readonly turnaround: number[];
  /** Aircraft in turnaround with their ready times: squadron, time, aircraft. */
  ready: [number, number, number][] = [];
  /** Aircraft lost and aircrew killed per side; aircrew down awaiting rescue (R2.2). */
  readonly lost: Record<Side, number> = { alliance: 0, pact: 0 };
  readonly killed: Record<Side, number> = { alliance: 0, pact: 0 };
  survivors: Survivor[] = [];
  /** Crews resting after a sortie: squadron, until, seats (R2.9). */
  resting: [number, number, number][] = [];
  /**
   * The capture hazard (per second) a survivor of a side unhurt on land meets at a point
   * (R2.9's survivor watch, from the ground war); null: no enemy known anywhere.
   */
  survivorThreat: ((side: Side, p: Readonly<Dir>) => number) | null = null;
  /** Engagements and effects at phase events (R2.2); null: flights only fly. */
  resolution: PhaseHook | null = null;
  private readonly events = new Map<number, number[]>();
  private readonly losses: Rng;
  private readonly survivorRoot: Rng;
  private nextSurvivor = 0;
  private nextMission = 0;
  private nextPackage = 0;

  constructor(
    readonly input: CampaignInput,
    seed: WorldSeed,
    /** The ground under routes, for their terrain floor (R1.6); null: sea level. */
    readonly ground: GroundSource | null = null,
    /** Whether a point is water, for a survivor's surface (R2.9); null: all land. */
    readonly water: ((d: Readonly<Dir>) => boolean) | null = null,
  ) {
    this.radius = input.radius;
    this.orbat = buildOrderOfBattle(input, seed);
    this.carriers = input.carriers.map((c) => carrierTrack(c, input.radius));
    this.turnaround = this.orbat.squadrons.map(() => 0);
    this.losses = rng(seed, 'losses');
    this.survivorRoot = survivorStream(seed);
  }

  /** Registers the event handlers and the saved state with the simulation. */
  register(sim: Simulation): void {
    sim.on(AIR_PHASE_EVENT, (e, s) => this.onPhase(e.data as PhaseEvent, s));
    sim.on(AIR_READY_EVENT, (e, s) => this.onReady(e.data as ReadyEvent, s));
    // Subscription hits carry a flag for auto-slowdown and nothing else.
    sim.on(SUBSCRIPTION_EVENT, () => {});
    sim.addState('air', this);
    sim.addState('subscriptions', this.subscriptions);
  }

  /**
   * What changes as the war runs (R1.2): squadron strengths, base stocks, live
   * missions in launch order, the counters. The order of battle's structure and
   * the carrier tracks come from the campaign input and the seed.
   */
  save(): AirOpsState {
    return {
      squadrons: this.orbat.squadrons.map((s) => [s.aircraft, s.available, [...s.pilots]]),
      stocks: this.orbat.bases.map((b) => ({ ...b.stocks })),
      missions: [...this.missions.values()],
      launched: { ...this.launched },
      completed: { ...this.completed },
      turnaround: [...this.turnaround],
      ready: this.ready.map((r) => [...r] as [number, number, number]),
      events: [...this.events].map(([k, v]) => [k, [...v]] as [number, number[]]),
      lost: { ...this.lost },
      killed: { ...this.killed },
      survivors: this.survivors.map((x) => ({ ...x, point: [...x.point] })),
      resting: this.resting.map((r) => [...r] as [number, number, number]),
      nextSurvivor: this.nextSurvivor,
      nextMission: this.nextMission,
      nextPackage: this.nextPackage,
      revision: this.revision,
    };
  }

  load(state: unknown): void {
    const s = state as AirOpsState;
    if (
      s.squadrons.length !== this.orbat.squadrons.length ||
      s.stocks.length !== this.orbat.bases.length
    ) {
      throw new Error('Saved air state does not match this order of battle');
    }
    s.squadrons.forEach(([aircraft, available, pilots], i) => {
      const sq = this.orbat.squadrons[i]!;
      sq.aircraft = aircraft;
      sq.available = available;
      sq.pilots = [...pilots];
    });
    s.stocks.forEach((st, i) => Object.assign(this.orbat.bases[i]!.stocks, st));
    this.missions.clear();
    for (const m of s.missions) this.missions.set(m.id, m);
    Object.assign(this.launched, s.launched);
    Object.assign(this.completed, s.completed);
    this.turnaround.splice(0, this.turnaround.length, ...s.turnaround);
    this.ready = s.ready.map((r) => [...r] as [number, number, number]);
    this.events.clear();
    for (const [k, v] of s.events) this.events.set(k, [...v]);
    Object.assign(this.lost, s.lost);
    Object.assign(this.killed, s.killed);
    // Survivors saved before R2.9 have no state: down, unhurt, on land, three days to live.
    type Saved = Partial<Survivor> & Pick<Survivor, 'time' | 'point'>;
    this.survivors = (s.survivors as Saved[]).map(
      (x): Survivor =>
        ({
          injury: 'none',
          water: false,
          until: x.time + 72 * HOUR,
          state: 'down',
          changed: x.time,
          theater: -1,
          attempts: 0,
          ...x,
          point: [...x.point],
        }) as Survivor,
    );
    this.resting = (s.resting ?? []).map((r) => [...r] as [number, number, number]);
    this.nextSurvivor = s.nextSurvivor;
    this.nextMission = s.nextMission;
    this.nextPackage = s.nextPackage;
    this.revision = s.revision;
  }

  get squadrons(): readonly Squadron[] {
    return this.orbat.squadrons;
  }

  base(ref: BaseRef): AirBaseRecord {
    return this.orbat.bases[baseIndex(ref, this.input.airbases.length)]!;
  }

  /** Where a base is at game time t: an airbase's site, or a carrier group's position. */
  basePoint(ref: BaseRef, t: GameTime): Dir {
    if (ref.kind === 'airbase') return [...this.input.airbases[ref.id]!.point];
    return carrierState(this.carriers[ref.id]!, t).point;
  }

  newMissionId(): number {
    return this.nextMission++;
  }

  newPackageId(): number {
    return this.nextPackage++;
  }

  /** Fuel, munitions and drop tanks a flight would draw from its base (tanks: decision 294). */
  draw(m: Pick<Mission, 'aircraftType' | 'aircraft' | 'type' | 'loadout'>): {
    fuel: number;
    munitions: number;
    tanks: number;
  } {
    const t = aircraftType(m.aircraftType);
    const l = t.loadouts.find((x) => x.id === m.loadout);
    const tanks = Object.values(l?.tanks ?? {}).reduce((a, n) => a + n, 0);
    return {
      fuel: m.aircraft * loadoutFuel(t, l) * this.input.rangeFactor,
      munitions: ARMED.has(m.type) ? m.aircraft : 0,
      tanks: m.aircraft * tanks,
    };
  }

  /**
   * The flight drops its tanks for a fight (decision 294): each aircraft's tanks count as
   * expended, so they neither return to the base nor hang on it when promoted.
   */
  dropTanks(m: Mission): void {
    const tanks = loadoutTanks(aircraftType(m.aircraftType), m.loadout);
    if (Object.keys(tanks).length === 0 || m.aircraft <= 0) return;
    const ex = Array.from({ length: m.aircraft }, (_, k) => ({ ...(m.expended?.[k] ?? {}) }));
    for (const e of ex)
      for (const [id, n] of Object.entries(tanks)) e[id] = Math.max(e[id] ?? 0, n);
    m.expended = ex;
  }

  /** The tanks mission m brings home: those its surviving aircraft still hang (decision 294). */
  tanksHome(m: Readonly<Mission>): number {
    const tanks = loadoutTanks(aircraftType(m.aircraftType), m.loadout);
    let n = 0;
    for (let k = 0; k < m.aircraft; k++)
      for (const [id, c] of Object.entries(tanks))
        n += Math.max(0, c - (m.expended?.[k]?.[id] ?? 0));
    return n;
  }

  /** Commits a planned mission: reserves its aircraft and stocks and schedules its phases. */
  launch(m: Mission, sim: Simulation): void {
    const sq = this.orbat.squadrons[m.squadron]!;
    if (sq.available < m.aircraft) {
      throw new Error(
        `Squadron ${sq.name} has ${sq.available} aircraft, mission needs ${m.aircraft}`,
      );
    }
    if (this.crewsFree(sq.id, m.timeline[0]!.time) < m.aircraft) {
      throw new Error(`Squadron ${sq.name} has no crews for ${m.aircraft} aircraft`);
    }
    sq.available -= m.aircraft;
    const base = this.base(m.base);
    const d = this.draw(m);
    base.stocks.fuel -= d.fuel;
    base.stocks.munitions -= d.munitions;
    base.stocks.tanks = (base.stocks.tanks ?? 0) - d.tanks;
    this.missions.set(m.id, m);
    this.launched[m.side]++;
    // A rescue launched for survivors (R2.9): the next one for them is a new attempt.
    for (const id of m.survivors ?? []) {
      const s = this.survivors[id];
      if (s) s.attempts++;
    }
    sim.log.decision(sim.time, {
      kind: 'mission-launched',
      mission: m.id,
      side: m.side,
      type: m.type,
      squadron: m.squadron,
      aircraft: m.aircraft,
    });
    this.revision++;
    this.schedulePhases(m, -Infinity, sim);
  }

  /** Schedules the mission's phase events after `after`, keeping their ids. */
  private schedulePhases(m: Mission, after: GameTime, sim: Simulation): void {
    const ids: number[] = [];
    for (const e of m.timeline) {
      if (e.time <= after) continue;
      ids.push(
        sim.schedule(Math.max(e.time, sim.time), AIR_PHASE_EVENT, {
          mission: m.id,
          phase: e.phase,
        }),
      );
    }
    this.events.set(m.id, ids);
  }

  private cancelPhases(m: Mission, sim: Simulation): void {
    for (const id of this.events.get(m.id) ?? []) sim.cancel(id);
    this.events.delete(m.id);
  }

  /**
   * Takes `n` aircraft off a flight (R2.2): the squadron loses them, each crew
   * member ejects (EJECT_CHANCE) and becomes a survivor at `at`, or is killed;
   * the pilots leave the roster. A flight with no aircraft left ends.
   */
  lose(m: Mission, n: number, at: Readonly<Dir>, cause: string, sim: Simulation): number {
    n = Math.min(n, m.aircraft);
    if (n <= 0) return 0;
    const sq = this.orbat.squadrons[m.squadron]!;
    const t = aircraftType(m.aircraftType);
    m.aircraft -= n;
    m.losses = (m.losses ?? 0) + n;
    sq.aircraft -= n;
    this.lost[m.side] += n;
    const r = this.losses.fork(`m${m.id}`).fork(`${cause}@${Math.round(sim.time)}`);
    let ejected = 0;
    let killed = 0;
    for (let i = 0; i < n * Math.max(1, t.crew); i++) {
      const pilot =
        sq.pilots.length > 0 ? sq.pilots.splice(r.int(sq.pilots.length), 1)[0]! : 'unknown';
      // A crew that ejected at full fidelity survives (decision 301); otherwise its chances.
      if (cause === EJECTED || r.nextFloat() < EJECT_CHANCE) {
        ejected++;
        this.survivors.push(
          newSurvivor(
            this.survivorRoot,
            {
              id: this.nextSurvivor++,
              side: m.side,
              pilot,
              squadron: sq.id,
              mission: m.id,
              theater: m.theater,
              time: sim.time,
            },
            at,
            this.radius,
            (d) => this.water?.(d) ?? false,
          ),
        );
      } else {
        killed++;
      }
    }
    this.killed[m.side] += killed;
    if (ejected > 0) sim.schedule(sim.time, SURVIVOR_EVENT, { side: m.side });
    sim.log.decision(sim.time, {
      kind: 'aircraft-lost',
      mission: m.id,
      side: m.side,
      type: m.type,
      aircraft: n,
      cause,
      ejected,
      killed,
    });
    this.revision++;
    if (m.aircraft === 0) {
      // Survivors a lost rescue flight carried are down again where it went down.
      for (const s of this.survivors) {
        if (s.state === 'aboard' && s.carrier === m.id) {
          s.state = 'down';
          s.point = [...at];
          s.changed = sim.time;
          delete s.carrier;
        }
      }
      this.cancelPhases(m, sim);
      this.missions.delete(m.id);
      this.completed[m.side]++;
    }
    return n;
  }

  // ---- Survivors (R2.9) ----

  /**
   * Survivor s is captured or dies (the survivor watch): logged, and a rescue flight
   * on its way whose survivors are all gone turns home with its package.
   */
  survivorLost(s: Survivor, state: 'captured' | 'died', sim: Simulation): void {
    if (s.state !== 'down') return;
    s.state = state;
    s.changed = sim.time;
    sim.log.decision(sim.time, {
      kind: 'survivor-lost',
      survivor: s.id,
      side: s.side,
      squadron: s.squadron,
      state,
    });
    this.revision++;
    for (const m of this.liveMissions()) {
      if (!m.survivors?.includes(s.id) || m.aborted || m.resolved) continue;
      const left = m.survivors.some((id) => this.survivors[id]?.state === 'down');
      if (left || missionPhaseAt(m, sim.time) === 'on-target') continue;
      for (const x of this.liveMissions()) {
        if (x.side === m.side && x.package === m.package && !x.aborted && !x.flown)
          this.abort(x, 'survivor lost', sim);
      }
    }
  }

  /** Rescue flight m picks up survivors `ids` still down: they are aboard until it lands home. */
  pickUp(m: Mission, ids: readonly number[], sim: Simulation): number {
    let n = 0;
    for (const id of ids) {
      const s = this.survivors[id];
      if (!s || s.state !== 'down') continue;
      s.state = 'aboard';
      s.carrier = m.id;
      s.changed = sim.time;
      n++;
      sim.log.decision(sim.time, {
        kind: 'survivor-picked-up',
        survivor: s.id,
        side: s.side,
        mission: m.id,
      });
    }
    if (n > 0) this.revision++;
    return n;
  }

  /** The survivors still down that a rescue of survivor `id` would take: its group. */
  rescueGroup(id: number): Survivor[] {
    const s = this.survivors[id];
    return s ? groupOf(this.survivors, s, this.radius) : [];
  }

  /** Survivors flight m carried home are rescued: each pilot back on its squadron's roster, resting. */
  private bringHome(m: Mission, sim: Simulation): void {
    for (const s of this.survivors) {
      if (s.state !== 'aboard' || s.carrier !== m.id) continue;
      s.state = 'rescued' satisfies SurvivorState;
      s.changed = sim.time;
      const sq = this.orbat.squadrons[s.squadron];
      if (sq) {
        sq.pilots.push(s.pilot);
        this.resting.push([sq.id, sim.time + CREW_REST, 1]);
      }
      sim.log.decision(sim.time, {
        kind: 'survivor-rescued',
        survivor: s.id,
        side: s.side,
        squadron: s.squadron,
        mission: m.id,
      });
      this.revision++;
    }
  }

  // ---- Crews (R2.9) ----

  /** Crew seats of squadron `sq` resting at game time t. */
  restingSeats(sq: number, t: GameTime): number {
    let n = 0;
    for (const [s, until, seats] of this.resting) if (s === sq && until > t) n += seats;
    return n;
  }

  /** Crews (whole aircraft's worth) on squadron `sq`'s roster. */
  crews(sq: number): number {
    const s = this.orbat.squadrons[sq]!;
    return Math.floor(s.pilots.length / Math.max(1, aircraftType(s.type).crew));
  }

  /**
   * Aircraft squadron `sq` can crew now: its roster less the crews in the air and those
   * resting, in whole aircraft's worth (R2.9's pool limits sorties).
   */
  crewsFree(sq: number, t: GameTime): number {
    const s = this.orbat.squadrons[sq]!;
    const crew = Math.max(1, aircraftType(s.type).crew);
    let flying = 0;
    for (const m of this.missions.values()) if (m.squadron === sq) flying += m.aircraft * crew;
    return Math.floor((s.pilots.length - flying - this.restingSeats(sq, t)) / crew);
  }

  /** Turns a flight home at the current time (R2.2): its route is cut and its later phases rescheduled. */
  abort(m: Mission, reason: string, sim: Simulation): void {
    if (m.aborted || !this.missions.has(m.id)) return;
    const t = aircraftType(m.aircraftType);
    m.aborted = reason;
    const home = this.basePoint(m.base, sim.time + 3600);
    // The turn home through a real radius at the rejoin's bank, not a corner (decision 281).
    let route = returnRoute(
      m.route,
      sim.time,
      home,
      t,
      this.radius,
      t.helicopter ? 180 : 480,
      (b, to) => turnToward(b, to, t.cruiseSpeed, 'cruise', 'egress', this.radius, REJOIN_BANK),
    );
    if (this.ground) route = floorRoute(route, this.ground, clearanceFor(t), this.radius);
    m.route = route;
    m.timeline = routeTimeline(route);
    this.cancelPhases(m, sim);
    this.schedulePhases(m, sim.time, sim);
    sim.log.decision(sim.time, {
      kind: 'mission-aborted',
      mission: m.id,
      side: m.side,
      type: m.type,
      reason,
    });
    this.revision++;
  }

  /**
   * The player takes over aircraft `slot` of flight `m` (R2.5): its phase events are
   * held, so resolution and completion wait, until the handback. Only inside the
   * mission's jump-in window, and only once.
   */
  hold(m: Mission, slot: number, sim: Simulation): boolean {
    if (!this.missions.has(m.id) || m.flown || !jumpInOpen(m, sim.time)) return false;
    if (slot < 0 || slot >= m.aircraft) return false;
    m.flown = { slot, since: sim.time };
    this.cancelPhases(m, sim);
    this.revision++;
    return true;
  }

  /**
   * The player hands flight `m` back (R2.5): the aircraft full fidelity lost are lost
   * here (their crews eject or are killed as in any loss), and the route is rebuilt
   * from the fix (`rejoinRoute`), carrying on the mission from its phase there; the
   * phases after now are scheduled again. A flight with no aircraft left ends.
   */
  release(
    m: Mission,
    fix: HandbackFix,
    lost: readonly HandbackLoss[],
    sim: Simulation,
    stores: readonly HandbackStores[] = [],
  ): void {
    if (!this.missions.has(m.id) || !m.flown) return;
    const flown = m.flown;
    delete m.flown;
    // The session's consequences (decision 275): the survivors' stores, by their new slots.
    const gone = new Set(lost.map((l) => l.slot));
    const kept = [...stores].filter((x) => !gone.has(x.slot)).sort((a, b) => a.slot - b.slot);
    if (kept.some((x) => Object.keys(x.expended).length > 0))
      m.expended = kept.map((x) => ({ ...x.expended }));
    const total: Record<string, number> = {};
    for (const x of stores)
      for (const [k, n] of Object.entries(x.expended)) total[k] = (total[k] ?? 0) + n;
    sim.log.decision(sim.time, {
      kind: 'flight-session',
      mission: m.id,
      side: m.side,
      type: m.type,
      slot: flown.slot,
      since: flown.since,
      lost: lost.length,
      aircraft: Math.max(0, m.aircraft - lost.length),
      fuel: fix.fuel,
      expended: total,
    });
    // The input lands at the worker's time, a frame or so from the fix's: the fix counts as now,
    // so the phases after now are scheduled exactly once, on replay too.
    fix = { ...fix, time: sim.time };
    const byCause = new Map<string, HandbackLoss[]>();
    for (const l of lost) byCause.set(l.cause, [...(byCause.get(l.cause) ?? []), l]);
    for (const [cause, ls] of byCause) this.lose(m, ls.length, ls[0]!.point, cause, sim);
    if (!this.missions.has(m.id)) return;
    // Aircraft the fix knows and the flight does not are the campaign's losses already.
    const t = aircraftType(m.aircraftType);
    const loadout = t.loadouts.find((l) => l.id === m.loadout) ?? t.loadouts[0]!;
    let route = rejoinRoute({
      type: t,
      loadout,
      profile: MISSION_PROFILES[m.type],
      radius: this.radius,
      rangeFactor: this.input.rangeFactor,
      basePoint: (time) => this.basePoint(m.base, time),
      carrierBased: m.base.kind === 'carrier',
      target: m.target.point,
      ground: this.ground,
      route: m.route,
      fix,
    });
    if (!fix.airborne) route = m.route;
    m.route = route;
    m.timeline = routeTimeline(route);
    this.schedulePhases(m, sim.time, sim);
    const now = routeState(route, sim.time, this.radius);
    sim.log.decision(sim.time, {
      kind: 'mission-rejoined',
      mission: m.id,
      side: m.side,
      type: m.type,
      phase: now.segment >= 0 ? now.phase : 'complete',
      segments: route.segments.length,
      end: m.timeline[m.timeline.length - 1]!.time,
    });
    this.revision++;
    // A route that ended before now (a fix on the ground at home) completes at once.
    if (m.timeline[m.timeline.length - 1]!.time <= sim.time) {
      sim.schedule(sim.time, AIR_PHASE_EVENT, { mission: m.id, phase: 'complete' });
    }
  }

  private onPhase(e: PhaseEvent, sim: Simulation): void {
    const m = this.missions.get(e.mission);
    if (!m) return;
    this.resolution?.phase(m, e.phase, sim);
    if (!this.missions.has(e.mission)) return;
    for (const s of this.subscriptions.matching(m, e.phase)) {
      const hit: SubscriptionHit = { subscription: s.id, mission: m.id, phase: e.phase };
      sim.schedule(sim.time, SUBSCRIPTION_EVENT, hit, {
        flag: `${s.label}: ${m.callsign}, ${MISSION_LABELS[m.type]}, ${e.phase}`,
      });
    }
    if (e.phase !== 'complete') return;
    this.missions.delete(e.mission);
    this.events.delete(e.mission);
    this.completed[m.side]++;
    this.revision++;
    this.turnaround[m.squadron]! += m.aircraft;
    // Its crews rest before they fly again; survivors it carried are home (R2.9).
    const crew = Math.max(1, aircraftType(m.aircraftType).crew);
    if (m.aircraft > 0) this.resting.push([m.squadron, sim.time + CREW_REST, m.aircraft * crew]);
    this.bringHome(m, sim);
    // The tanks still hanging come back to the base it recovers at.
    const home = this.base(m.base).stocks;
    home.tanks = (home.tanks ?? 0) + this.tanksHome(m);
    const t = aircraftType(m.aircraftType);
    this.ready.push([m.squadron, sim.time + t.turnaround, m.aircraft]);
    sim.schedule(sim.time + t.turnaround, AIR_READY_EVENT, {
      squadron: m.squadron,
      aircraft: m.aircraft,
    });
  }

  private onReady(e: ReadyEvent, sim: Simulation): void {
    // Rests that ended are forgotten (kept sorted by nothing: a filter is cheap at this size).
    this.resting = this.resting.filter((r) => r[1] > sim.time);
    this.orbat.squadrons[e.squadron]!.available += e.aircraft;
    this.turnaround[e.squadron]! -= e.aircraft;
    const i = this.ready.findIndex(
      (r) => r[0] === e.squadron && r[1] === sim.time && r[2] === e.aircraft,
    );
    if (i >= 0) this.ready.splice(i, 1);
  }

  /** Live missions in id order. */
  liveMissions(): Mission[] {
    return [...this.missions.values()];
  }

  /** Aircraft of `side` in the air at game time t (all live missions, planned ones included when they will be). */
  airborneAt(side: Side, t: GameTime): number {
    let n = 0;
    for (const m of this.missions.values()) {
      if (m.side === side && routeState(m.route, t, this.radius).airborne) n += m.aircraft;
    }
    return n;
  }

  hash(h: StateHasher): void {
    h.number(this.nextMission).number(this.nextPackage).number(this.revision);
    for (const s of this.orbat.squadrons) h.number(s.available).number(s.aircraft);
    for (const n of this.turnaround) h.number(n);
    for (const r of this.ready) h.number(r[0]).number(r[1]).number(r[2]);
    h.number(this.lost.alliance)
      .number(this.lost.pact)
      .number(this.killed.alliance)
      .number(this.killed.pact);
    h.number(this.survivors.length);
    for (const x of this.survivors) h.string(x.state).number(x.changed).number(x.attempts);
    for (const r of this.resting) h.number(r[0]).number(r[1]).number(r[2]);
    for (const sq of this.orbat.squadrons) h.number(sq.pilots.length);
    for (const b of this.orbat.bases)
      h.number(b.stocks.fuel)
        .number(b.stocks.munitions)
        .number(b.stocks.tanks ?? 0);
    for (const m of this.missions.values()) {
      h.number(m.id).string(m.type).number(m.squadron).number(m.aircraft).number(m.seed);
      h.string(m.aborted ?? '');
      h.number(m.flown ? m.flown.slot : -1);
      for (const e of m.expended ?? []) for (const n of Object.values(e)) h.number(n);
      for (const e of m.timeline) h.number(e.time);
      // The route's shape too, so its terrain floor (R1.6) is in the hash.
      h.number(m.route.segments.length);
      for (const g of m.route.segments) h.number(g.t0).number(g.alt0).number(g.alt1);
    }
  }
}
