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
import type { GameTime } from '../../core/units';
import type { Simulation } from '../simulation';
import type { StateHasher } from '../stateHash';
import type { CampaignInput } from '../command/campaignInput';
import { carrierState, carrierTrack } from '../naval/carrierGroup';
import type { CarrierTrack } from '../naval/carrierGroup';
import { aircraftType } from './aircraft';
import type { BaseRef, Mission, MissionPhase } from './mission';
import { buildOrderOfBattle, baseIndex } from './orbat';
import type { AirBaseRecord, BaseStocks, OrderOfBattle, Squadron } from './orbat';
import { returnRoute, routeState, routeTimeline } from './route';
import { clearanceFor, floorRoute } from './terrainFloor';
import { MISSION_LABELS } from './mission';
import { SUBSCRIPTION_EVENT, Subscriptions } from './subscriptions';
import type { SubscriptionHit } from './subscriptions';
import type { GroundSource } from './terrainFloor';

export const AIR_PHASE_EVENT = 'air:phase';
export const AIR_READY_EVENT = 'air:ready';
/** Share of a lost aircraft's crew who eject (the rest are killed). */
export const EJECT_CHANCE = 0.75;

/** Aircrew down after an ejection (R2.2): R2.9 rescues, captures or loses them. */
export interface Survivor {
  id: number;
  side: Side;
  pilot: string;
  squadron: number;
  mission: number;
  point: Dir;
  time: GameTime;
}

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
  /** Engagements and effects at phase events (R2.2); null: flights only fly. */
  resolution: PhaseHook | null = null;
  private readonly events = new Map<number, number[]>();
  private readonly losses: Rng;
  private nextSurvivor = 0;
  private nextMission = 0;
  private nextPackage = 0;

  constructor(
    readonly input: CampaignInput,
    seed: WorldSeed,
    /** The ground under routes, for their terrain floor (R1.6); null: sea level. */
    readonly ground: GroundSource | null = null,
  ) {
    this.radius = input.radius;
    this.orbat = buildOrderOfBattle(input, seed);
    this.carriers = input.carriers.map((c) => carrierTrack(c, input.radius));
    this.turnaround = this.orbat.squadrons.map(() => 0);
    this.losses = rng(seed, 'losses');
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
    this.survivors = s.survivors.map((x) => ({ ...x, point: [...x.point] }));
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

  /** Fuel and munitions a flight would draw from its base. */
  draw(m: Pick<Mission, 'aircraftType' | 'aircraft' | 'type'>): {
    fuel: number;
    munitions: number;
  } {
    const t = aircraftType(m.aircraftType);
    return {
      fuel: m.aircraft * t.fuel * this.input.rangeFactor,
      munitions: ARMED.has(m.type) ? m.aircraft : 0,
    };
  }

  /** Commits a planned mission: reserves its aircraft and stocks and schedules its phases. */
  launch(m: Mission, sim: Simulation): void {
    const sq = this.orbat.squadrons[m.squadron]!;
    if (sq.available < m.aircraft) {
      throw new Error(
        `Squadron ${sq.name} has ${sq.available} aircraft, mission needs ${m.aircraft}`,
      );
    }
    sq.available -= m.aircraft;
    const base = this.base(m.base);
    const d = this.draw(m);
    base.stocks.fuel -= d.fuel;
    base.stocks.munitions -= d.munitions;
    this.missions.set(m.id, m);
    this.launched[m.side]++;
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
      if (r.nextFloat() < EJECT_CHANCE) {
        ejected++;
        this.survivors.push({
          id: this.nextSurvivor++,
          side: m.side,
          pilot,
          squadron: sq.id,
          mission: m.id,
          point: [...at],
          time: sim.time,
        });
      } else {
        killed++;
      }
    }
    this.killed[m.side] += killed;
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
      this.cancelPhases(m, sim);
      this.missions.delete(m.id);
      this.completed[m.side]++;
    }
    return n;
  }

  /** Turns a flight home at the current time (R2.2): its route is cut and its later phases rescheduled. */
  abort(m: Mission, reason: string, sim: Simulation): void {
    if (m.aborted || !this.missions.has(m.id)) return;
    const t = aircraftType(m.aircraftType);
    m.aborted = reason;
    const home = this.basePoint(m.base, sim.time + 3600);
    let route = returnRoute(m.route, sim.time, home, t, this.radius, t.helicopter ? 180 : 480);
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
    const t = aircraftType(m.aircraftType);
    this.ready.push([m.squadron, sim.time + t.turnaround, m.aircraft]);
    sim.schedule(sim.time + t.turnaround, AIR_READY_EVENT, {
      squadron: m.squadron,
      aircraft: m.aircraft,
    });
  }

  private onReady(e: ReadyEvent, sim: Simulation): void {
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
    for (const sq of this.orbat.squadrons) h.number(sq.pilots.length);
    for (const b of this.orbat.bases) h.number(b.stocks.fuel).number(b.stocks.munitions);
    for (const m of this.missions.values()) {
      h.number(m.id).string(m.type).number(m.squadron).number(m.aircraft).number(m.seed);
      h.string(m.aborted ?? '');
      for (const e of m.timeline) h.number(e.time);
      // The route's shape too, so its terrain floor (R1.6) is in the hash.
      h.number(m.route.segments.length);
      for (const g of m.route.segments) h.number(g.t0).number(g.alt0).number(g.alt1);
    }
  }
}
