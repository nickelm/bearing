/**
 * The air tasking order (design, "Air Tasking"; decision 50; roadmap R2.1).
 * Each side's command layer issues one order per game day and revises it on
 * its doctrine's period; it replaces the interim tasker of decision 132.
 *
 * An order is a list of planned sorties. Planning follows the design's four
 * steps:
 *
 * 1. **Collect needs** from every mission plug-in's planner rule
 *    (missions/registry.ts): standing stations kept covered to the order's
 *    horizon, and needs with wanted times on target laid out by doctrine.
 * 2. **Rank** them by score, ties by key (stable).
 * 3. **Build packages** from the plug-in's template: each flight from the
 *    squadrons in range by role preference and distance, within the ledger's
 *    promises of aircraft over time and the side's airborne cap, under the
 *    plug-in's weather and daylight minimums, with winds aloft in the route's
 *    ground speeds.
 * 4. **Schedule** by doctrine (doctrine.ts).
 *
 * A **revision** keeps the planned sorties whose need still stands, whose
 * minimums the newer forecast still meets and whose aircraft are still there,
 * cancels the rest with a reason, and plans what is still missing. A new day's
 * order starts from the previous one's standing stations. Every hour the ATO
 * **commits** the sorties departing within COMMIT_AHEAD: it checks the
 * weather and the squadron once more, puts the terrain floor under the route
 * and hands the mission to AirOps, which reserves its aircraft and stocks.
 *
 * Orders, revisions and cancellations are decisions in the log (rule 19).
 * Draws come from rng(seed, "ato") forked per side, per day and per need, so
 * an order is the same at any time acceleration and for either viewing side.
 * Planning reads the campaign input, AirOps, the damage state, the networks
 * and the weather, never the terrain (rule 9): the route floor's ground is
 * AirOps', passed through untouched.
 */
import type { Side } from '../../campaign/cast';
import { arcDistance, dot, polylineStations } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { rng } from '../../core/rng';
import type { Rng, WorldSeed } from '../../core/rng';
import { HOUR, MINUTE } from '../../core/units';
import type { GameTime } from '../../core/units';
import type { Simulation, TickProcess } from '../simulation';
import type { StateHasher } from '../stateHash';
import { aircraftType, loadoutsFor } from '../air/aircraft';
import type { Loadout } from '../air/aircraft';
import { stocked } from '../air/orbat';
import type { AircraftRole } from '../air/aircraft';
import { CREW_REST } from '../air/airOps';
import type { AirOps } from '../air/airOps';
import { MISSION_PROFILES } from '../air/mission';
import type { BaseRef, Mission, MissionType } from '../air/mission';
import { planMissionRoute, timeOnTarget } from '../air/missionRoute';
import type { BaseStocks } from '../air/orbat';
import { routeTimeline } from '../air/route';
import type { Route } from '../air/route';
import { clearanceFor, floorRoute } from '../air/terrainFloor';
import type { DamageState } from '../ground/damage';
import type { GroundWar } from '../ground/war';
import type { NetworkGraph } from '../ground/network';
import type { CampaignInput } from './campaignInput';
import { ROAD_BRIDGE_LISTS, RAIL_BRIDGE_LISTS } from './campaignInput';
import { DOCTRINE, scheduleTimes } from './doctrine';
import type { Timing } from './doctrine';
import { PlanningEnvironment } from './environment';
import { frontPoint, frontSegments } from './front';
import type { FrontSegment } from './front';
import { Ledger } from './ledger';
import { plannedStation } from './missions/common';
import { isPending } from './missions/plugin';
import type { Need, PackageMember, PlanContext } from './missions/plugin';
import { MISSION_PLUGINS, missionPlugin } from './missions/registry';
import { supplyLines } from './supply';
import type { SupplyLines } from './supply';
import type { WeatherModel } from '../weather/model';
import type { CampaignCalendar, OrbitParams } from '../../core/calendar';

export const ATO_PERIOD = HOUR;
/** Earliest departure after planning (s). */
export const MIN_LEAD = 10 * MINUTE;
/** Sorties departing within this are committed at the hourly tick (s). */
export const COMMIT_AHEAD = HOUR;
/** Standing stations are covered this far past the order's day (s). */
export const ORDER_OVERLAP = 3 * HOUR;
/** Timed needs' windows start this long into the order's day (s). */
export const FIRST_LEAD = HOUR;
/** A named place counts as near within this (m). */
export const TOWN_RANGE = 60e3;
/** Candidate squadrons tried per flight. */
export const CANDIDATES = 4;

export const SIDES: readonly Side[] = ['alliance', 'pact'];

const ALLIANCE_CALLSIGNS = [
  'Viper',
  'Cobra',
  'Hawk',
  'Dodge',
  'Ford',
  'Colt',
  'Magic',
  'Jester',
  'Ghost',
  'Saber',
  'Lance',
  'Hammer',
  'Buick',
  'Pontiac',
  'Raven',
  'Tiger',
];

/** One flight of the order: planned, then committed to AirOps. */
export interface Sortie {
  /** The request it fills, and its role in the package: `need#i/lead`, `need@t/escort`. */
  key: string;
  need: string;
  /** The request (one time on target of a need, or one relief of a station). */
  request: string;
  standing: boolean;
  role: PackageMember['role'];
  /** Key of the package's lead sortie. */
  lead: string;
  /** Id −1 until committed; the route has no terrain floor until then. */
  mission: Mission;
  departure: GameTime;
  /** End of the time on station or over the target. */
  stationEnd: GameTime;
}

export interface AirTaskingOrder {
  side: Side;
  day: number;
  revision: number;
  issued: GameTime;
  planned: Sortie[];
}

/** What the ATO did, per side (for the war tool and tests). */
export interface AtoStats {
  orders: number;
  revisions: number;
  planned: number;
  committed: number;
  cancelled: Record<string, number>;
  /** Requests no package could fill, by mission type and the lead flight's reason. */
  unfilled: Record<string, Record<string, number>>;
}

export interface AtoState {
  orders: Record<Side, AirTaskingOrder | null>;
  /** Last time each side struck each target, `side:kind:id`. */
  struck: [string, number][];
  /** End of committed coverage of each standing station, `side:need`. */
  covered: [string, number][];
  /** Requests committed this day, `side:request`. */
  filled: string[];
  stats: Record<Side, AtoStats>;
}

/** The sim's parts the ATO reads (and AirOps, which it hands missions to). */
export interface AtoWorld {
  air: AirOps;
  input: CampaignInput;
  seed: WorldSeed;
  weather: WeatherModel | null;
  orbit: OrbitParams | null;
  calendar: CampaignCalendar | null;
  networks: { road: NetworkGraph; rail: NetworkGraph } | null;
  damage: DamageState | null;
  /** The ground war (R2.3): the front as it moves and the fighting's pressure; null: the start line. */
  ground?: GroundWar | null;
  /** A side flying no strikes and no ground support (the comparison tool's suppressed run, R2.3). */
  suppressAirSupport?: Side | null;
}

function emptyStats(): AtoStats {
  return { orders: 0, revisions: 0, planned: 0, committed: 0, cancelled: {}, unfilled: {} };
}

const byScore = (a: { score: number; key: string }, b: { score: number; key: string }) =>
  b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export class AirTaskingOrders implements TickProcess {
  readonly name = 'ato';
  readonly period = ATO_PERIOD;
  readonly orders: Record<Side, AirTaskingOrder | null> = { alliance: null, pact: null };
  readonly stats: Record<Side, AtoStats> = { alliance: emptyStats(), pact: emptyStats() };
  private readonly struck = new Map<string, number>();
  private readonly covered = new Map<string, number>();
  private readonly filled = new Set<string>();
  /** Why the last flight could not be planned. */
  private failure = '';
  private readonly root: Rng;
  private readonly env: PlanningEnvironment;
  private readonly segments: FrontSegment[];
  private readonly stations = new Map<number, Float64Array>();
  private readonly initial: BaseStocks[];
  private readonly supplyCache = new Map<string, SupplyLines>();
  readonly dayLength: number;

  constructor(private readonly w: AtoWorld) {
    this.root = rng(w.seed, 'ato');
    this.env = new PlanningEnvironment(w.weather, w.orbit, w.calendar);
    this.dayLength = w.orbit?.solarDay ?? 24 * HOUR;
    this.segments = w.input.fronts.flatMap((f) => frontSegments(f, w.input.radius));
    for (const f of w.input.fronts) {
      this.stations.set(f.theater, polylineStations(f.points, w.input.radius));
    }
    this.initial = w.air.orbat.bases.map((b) => ({ ...b.stocks }));
  }

  /** Every front's segments with their pressure. */
  get frontSegments(): readonly FrontSegment[] {
    return this.segments;
  }

  step(t: GameTime, _k: number, sim: Simulation): void {
    const day = Math.floor(t / this.dayLength + 1e-9);
    for (const side of SIDES) {
      const order = this.orders[side];
      if (!order || order.day !== day) {
        this.issue(side, day, t, sim);
      } else {
        const hours = Math.round((t - order.issued) / HOUR);
        if (hours > 0 && hours % DOCTRINE[side].revisionHours === 0) {
          order.revision++;
          this.revise(side, t, sim);
        }
      }
      this.urgent(side, t, sim);
      this.commit(side, t, sim);
    }
  }

  /** A survivor of `side` came down (AirOps' SURVIVOR_EVENT): its rescue is planned and committed now. */
  survivorDown(side: Side, sim: Simulation): void {
    if (!this.orders[side]) return;
    this.urgent(side, sim.time, sim);
    this.commit(side, sim.time, sim);
  }

  // ---- Orders and revisions ----

  private issue(side: Side, day: number, t: GameTime, sim: Simulation): void {
    const old = this.orders[side];
    const order: AirTaskingOrder = { side, day, revision: 0, issued: t, planned: [] };
    for (const key of [...this.filled]) if (key.startsWith(`${side}:`)) this.filled.delete(key);
    if (old) {
      // Standing stations carry over; the old day's timed sorties have all departed.
      for (const s of old.planned) {
        if (s.standing) order.planned.push(s);
        else this.count(side, 'order expired');
      }
    }
    this.orders[side] = order;
    this.stats[side].orders++;
    this.revise(side, t, sim);
  }

  private revise(side: Side, now: GameTime, sim: Simulation): void {
    const order = this.orders[side]!;
    const ctx = this.context(side, now, order.day);
    this.stats[side].revisions++;

    // 1. Needs from every plug-in.
    const needs: Need[] = [];
    const suppressed = this.w.suppressAirSupport === side;
    for (const p of MISSION_PLUGINS) {
      if (suppressed && (p.category === 'strike' || p.category === 'ground-support')) continue;
      if (!isPending(p.planner)) needs.push(...p.planner(ctx));
    }
    const byKey = new Map(needs.map((n) => [n.key, n]));
    const requests = new Set<string>();
    for (const n of needs) n.tots?.forEach((_, i) => requests.add(`${n.key}#${i}`));

    // 2. What is promised already: committed missions, and the planned sorties that still stand.
    const ledger = this.committedLedger(side, now);
    const kept: Sortie[] = [];
    let cancelled = 0;
    const packages = new Map<string, Sortie[]>();
    for (const s of order.planned) {
      let p = packages.get(s.lead);
      if (!p) packages.set(s.lead, (p = []));
      p.push(s);
    }
    for (const [, pkg] of [...packages].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const lead = pkg.find((s) => s.role === 'lead') ?? pkg[0]!;
      const need = byKey.get(lead.need);
      let reason: string | null = null;
      if (!need || (!need.standing && !requests.has(lead.request))) reason = 'need gone';
      else if (lead.departure < now) reason = 'late';
      if (!reason) {
        for (const s of pkg) {
          reason = this.refusal(s.mission, now) ?? this.promise(ledger, side, s);
          if (reason) break;
        }
      }
      if (reason) {
        for (let i = 0; i < pkg.length; i++) this.count(side, reason);
        cancelled += pkg.length;
        continue;
      }
      for (const s of pkg) {
        this.hold(ledger, side, s);
        kept.push(s);
      }
    }

    // 3. Plan what is missing, in rank order.
    const coverage = new Map<string, number>();
    for (const s of kept) {
      if (s.standing && s.role === 'lead') {
        coverage.set(s.need, Math.max(coverage.get(s.need) ?? -Infinity, s.stationEnd));
      }
    }
    const horizon = order.day * this.dayLength + this.dayLength + ORDER_OVERLAP;
    const added: Sortie[] = [];
    for (const need of [...needs].sort(byScore)) {
      if (need.standing) {
        let until = Math.max(
          coverage.get(need.key) ?? -Infinity,
          this.covered.get(`${side}:${need.key}`) ?? -Infinity,
          now,
        );
        while (until < horizon) {
          const tot = Math.max(until, now + MIN_LEAD);
          const pkg = this.planPackage(
            ctx,
            ledger,
            need,
            `${need.key}@${Math.round(tot)}`,
            tot,
            now,
          );
          if (!pkg) {
            this.unfilled(side, need.type);
            break;
          }
          added.push(...pkg);
          until = pkg[0]!.stationEnd;
        }
      } else {
        need.tots?.forEach((tot, i) => {
          const request = `${need.key}#${i}`;
          if (this.filled.has(`${side}:${request}`)) return;
          if (kept.some((s) => s.request === request)) return;
          if (tot < now + MIN_LEAD) return;
          const pkg = this.planPackage(ctx, ledger, need, request, tot, now);
          if (pkg) added.push(...pkg);
          else this.unfilled(side, need.type);
        });
      }
    }
    order.planned = [...kept, ...added].sort(
      (a, b) => a.departure - b.departure || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    this.stats[side].planned += added.length;
    sim.log.decision(now, {
      kind: 'ato-revised',
      side,
      day: order.day,
      revision: order.revision,
      kept: kept.length,
      added: added.length,
      cancelled,
    });
  }

  /**
   * What `side` has promised already: its committed missions with their crews' rest,
   * the aircraft in turnaround, the crews resting; without the order's planned sorties.
   */
  private committedLedger(side: Side, now: GameTime): Ledger {
    const air = this.w.air;
    const ledger = new Ledger();
    for (const m of air.missions.values()) {
      if (m.side !== side) continue;
      const t = aircraftType(m.aircraftType);
      const last = m.timeline[m.timeline.length - 1]!.time;
      const from = Math.max(now, m.timeline[0]!.time);
      ledger.hold(m.squadron, from, last + t.turnaround, m.aircraft);
      ledger.hold(crewKey(m.squadron), from, last + CREW_REST, m.aircraft * crewOf(t));
      ledger.fly(side, m.route, m.aircraft, missionPlugin(m.type).category);
    }
    for (const [sq, until, n] of air.ready) {
      if (air.squadrons[sq]!.side === side && until > now) ledger.hold(sq, now, until, n);
    }
    for (const [sq, until, seats] of air.resting) {
      if (air.squadrons[sq]!.side === side && until > now)
        ledger.hold(crewKey(sq), now, until, seats);
    }
    return ledger;
  }

  /**
   * Needs that cannot wait for the next revision (R2.9: a rescue): every tick, the urgent
   * plug-ins' needs are planned at once, beside what the order already holds, and the
   * commitment that follows launches them.
   */
  private urgent(side: Side, now: GameTime, sim: Simulation): void {
    const order = this.orders[side];
    if (!order) return;
    const urgentPlugins = MISSION_PLUGINS.filter((p) => p.urgent && !isPending(p.planner));
    if (urgentPlugins.length === 0) return;
    const ctx = this.context(side, now, order.day);
    const needs = urgentPlugins.flatMap((p) => (isPending(p.planner) ? [] : p.planner(ctx)));
    if (needs.length === 0) return;
    const ledger = this.committedLedger(side, now);
    for (const s of order.planned) this.hold(ledger, side, s);
    const added: Sortie[] = [];
    for (const need of needs.sort(byScore)) {
      need.tots?.forEach((tot, i) => {
        const request = `${need.key}#${i}`;
        if (this.filled.has(`${side}:${request}`)) return;
        if (order.planned.some((s) => s.request === request)) return;
        const pkg = this.planPackage(
          ctx,
          ledger,
          need,
          request,
          Math.max(tot, now + MIN_LEAD),
          now,
        );
        if (pkg) added.push(...pkg);
        else this.unfilled(side, need.type);
      });
    }
    if (added.length === 0) return;
    order.planned = [...order.planned, ...added].sort(
      (a, b) => a.departure - b.departure || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    this.stats[side].planned += added.length;
    sim.log.decision(now, { kind: 'ato-urgent', side, added: added.length });
  }

  /** Why a planned sortie may not fly now (the forecast at `now`), or null. */
  private refusal(m: Mission, now: GameTime): string | null {
    this.env.now = now;
    const t = aircraftType(m.aircraftType);
    const tot = timeOnTarget(m.route);
    return this.env.refusal(
      missionPlugin(m.type).minimums,
      t.helicopter,
      this.w.air.basePoint(m.base, m.timeline[0]!.time),
      m.target.point,
      Number.isFinite(tot) ? tot : m.timeline[0]!.time,
    );
  }

  /** Whether the ledger can still promise a sortie's aircraft: null if so, else why not. */
  private promise(ledger: Ledger, side: Side, s: Sortie): string | null {
    const m = s.mission;
    const sq = this.w.air.squadrons[m.squadron]!;
    const end = m.timeline[m.timeline.length - 1]!.time + aircraftType(m.aircraftType).turnaround;
    if (!ledger.fits(sq.id, sq.aircraft, s.departure, end, m.aircraft)) return 'aircraft';
    if (!this.crewFits(ledger, m.squadron, s.departure, m.timeline, m.aircraft)) return 'crews';
    return this.capped(ledger, side, m.route, m.aircraft, m.type);
  }

  /** Whether squadron `sq`'s roster can crew `n` more aircraft from `from` to the end of `timeline` and its rest. */
  private crewFits(
    ledger: Ledger,
    sq: number,
    from: GameTime,
    timeline: readonly { time: GameTime }[],
    n: number,
  ): boolean {
    const s = this.w.air.squadrons[sq]!;
    const crew = crewOf(aircraftType(s.type));
    const to = timeline[timeline.length - 1]!.time + CREW_REST;
    return ledger.fits(crewKey(sq), s.pilots.length, from, to, n * crew);
  }

  /** Whether a flight breaks the airborne cap or its category's share: the reason, or null. */
  private capped(
    ledger: Ledger,
    side: Side,
    route: Route,
    n: number,
    type: MissionType,
  ): string | null {
    const d = DOCTRINE[side];
    const plugin = missionPlugin(type);
    // A rescue is never refused for the sky being full (R2.9).
    if (plugin.urgent) return null;
    const category = plugin.category;
    const over = ledger.underCap(
      side,
      route,
      n,
      d.maxAirborne,
      category,
      d.apportionment[category] * d.maxAirborne,
    );
    return over === 'total' ? 'airborne cap' : over === 'category' ? 'apportionment' : null;
  }

  private hold(ledger: Ledger, side: Side, s: Sortie): void {
    const m = s.mission;
    const end = m.timeline[m.timeline.length - 1]!.time + aircraftType(m.aircraftType).turnaround;
    ledger.hold(m.squadron, s.departure, end, m.aircraft);
    const last = m.timeline[m.timeline.length - 1]!.time;
    ledger.hold(
      crewKey(m.squadron),
      s.departure,
      last + CREW_REST,
      m.aircraft * crewOf(aircraftType(m.aircraftType)),
    );
    ledger.fly(side, m.route, m.aircraft, missionPlugin(m.type).category);
  }

  // ---- Packages ----

  private planPackage(
    ctx: PlanContext,
    ledger: Ledger,
    need: Need,
    request: string,
    tot: GameTime,
    now: GameTime,
  ): Sortie[] | null {
    const plugin = missionPlugin(need.type);
    if (isPending(plugin.package)) {
      this.failure = 'no package template';
      return null;
    }
    const members = plugin.package(need, ctx);
    const lead = this.planFlight(
      ctx,
      ledger,
      need,
      request,
      members[0]!,
      tot,
      need.slip ?? Infinity,
      now,
      null,
    );
    if (!lead) return null;
    const pkg = [lead];
    const leadTot = timeOnTarget(lead.mission.route);
    for (const m of members.slice(1)) {
      const f = this.planFlight(
        ctx,
        ledger,
        need,
        request,
        m,
        leadTot + m.offset,
        15 * MINUTE,
        now,
        lead,
      );
      if (f) pkg.push(f);
    }
    const id = this.w.air.newPackageId();
    for (const s of pkg) s.mission.package = id;
    return pkg;
  }

  private planFlight(
    ctx: PlanContext,
    ledger: Ledger,
    need: Need,
    request: string,
    member: PackageMember,
    tot: GameTime,
    slip: number,
    now: GameTime,
    lead: Sortie | null,
  ): Sortie | null {
    const air = this.w.air;
    const R = this.w.input.radius;
    const side = ctx.side;
    const type: MissionType = member.type;
    const plugin = missionPlugin(type);
    const profile = MISSION_PROFILES[type];
    const roles: readonly AircraftRole[] =
      (member.role === 'lead' ? need.roles : undefined) ?? profile.roles;
    const candidates: {
      sq: number;
      dist: number;
      rank: number;
      loadout: Loadout;
      from: BaseRef;
    }[] = [];
    for (const sq of air.squadrons) {
      if (sq.side !== side) continue;
      if (need.base && (sq.base.kind !== need.base.kind || sq.base.id !== need.base.id)) continue;
      if (
        member.role === 'lead' &&
        need.notFrom &&
        sq.base.kind === need.notFrom.kind &&
        sq.base.id === need.notFrom.id
      ) {
        continue;
      }
      // Air wings fly only in their carrier's theater (theater tasking of carriers is C3).
      if (
        !need.base &&
        sq.base.kind === 'carrier' &&
        air.carriers[sq.base.id]!.cast.theater !== need.theater
      ) {
        continue;
      }
      const at = aircraftType(sq.type);
      const order = roles.indexOf(at.role);
      if (
        order < 0 ||
        sq.aircraft < flightOf(at, profile) ||
        air.crews(sq.id) < flightOf(at, profile)
      )
        continue;
      // Roles that rank alike leave the choice to distance (decision 254); a defended
      // target still goes to the types that fly it low first.
      const low = profile.lowRoles?.includes(at.role) ?? false;
      const rank = profile.rolesAlike ? (need.defended && !low ? 1 : 0) : order;
      // The heaviest of the profile's loadouts that reaches the target and that the base
      // can hang (its drop tanks; decision 294).
      // A rescue flies from the side's base nearest the target, where the squadron keeps
      // crews on alert (R2.9); every other flight from its squadron's base.
      const from = profile.staging ? this.nearestBase(side, need.target.point, tot) : sq.base;
      const dist = arcDistance(air.basePoint(from, tot), need.target.point, R);
      const stocks = air.base(from).stocks;
      const loadout = (profile.loadout ? loadoutsFor(at, profile.loadout) : [at.loadouts[0]!]).find(
        (l) =>
          dist <= at.combatRadius * l.radiusFactor * this.w.input.rangeFactor &&
          stocked(
            stocks,
            air.draw({ aircraftType: at.id, aircraft: flightOf(at, profile), type, loadout: l.id }),
          ),
      );
      if (!loadout) continue;
      candidates.push({ sq: sq.id, dist, rank, loadout, from });
    }
    candidates.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.sq - b.sq);
    this.failure = candidates.length === 0 ? 'no squadron' : 'route';
    this.env.now = now;
    const wind = this.w.weather
      ? (p: Readonly<Dir>, alt: number) => this.env.windAloft(p, alt)
      : null;
    for (const c of candidates.slice(0, CANDIDATES)) {
      const sq = air.squadrons[c.sq]!;
      const at = aircraftType(sq.type);
      const loadout = c.loadout;
      const from = c.from;
      const plan = (launch: GameTime): Route | null =>
        planMissionRoute({
          type: at,
          loadout,
          profile,
          radius: R,
          rangeFactor: this.w.input.rangeFactor,
          basePoint: (time) => air.basePoint(from, time),
          carrierBased: from.kind === 'carrier',
          target: need.target.point,
          launch,
          stationTime: need.stationTime,
          orbitHeading: need.orbitHeading,
          wind,
        });
      const earliest = now + MIN_LEAD;
      let route = plan(earliest);
      if (!route) continue;
      const launch = Math.max(earliest, tot - (timeOnTarget(route) - earliest));
      if (launch > earliest) route = plan(launch);
      if (!route) continue;
      const arrive = timeOnTarget(route);
      if (arrive > tot + slip) {
        this.failure = 'late';
        continue;
      }
      const refused = this.env.refusal(
        plugin.minimums,
        at.helicopter,
        air.basePoint(from, launch),
        need.target.point,
        arrive,
      );
      if (refused) {
        this.failure = refused;
        continue;
      }
      const timeline = routeTimeline(route);
      const end = timeline[timeline.length - 1]!.time + at.turnaround;
      if (!ledger.fits(sq.id, sq.aircraft, launch, end, flightOf(at, profile))) {
        this.failure = 'aircraft';
        continue;
      }
      if (!this.crewFits(ledger, sq.id, launch, timeline, flightOf(at, profile))) {
        this.failure = 'crews';
        continue;
      }
      const capped = this.capped(ledger, side, route, flightOf(at, profile), type);
      if (capped) {
        this.failure = capped;
        return null;
      }
      const key = `${request}/${member.role}`;
      const r = ctx.rng(`flight:${key}`);
      const mission: Mission = {
        id: -1,
        type,
        side,
        theater: need.theater,
        package: -1,
        squadron: sq.id,
        unit: sq.name,
        aircraftType: at.id,
        aircraft: flightOf(at, profile),
        loadout: loadout.id,
        callsign: callsign(side, r),
        base: { ...from },
        target: need.target,
        need:
          member.role === 'lead'
            ? need.label
            : `${capitalize(member.role === 'sead' ? 'SEAD' : member.role)} for ${lead!.mission.callsign}`,
        needKey: need.key,
        score: need.score,
        places: need.places,
        ...(need.survivors ? { survivors: [...need.survivors] } : {}),
        seed: r.nextUint32(),
        route,
        timeline,
      };
      const sortie: Sortie = {
        key,
        need: need.key,
        request,
        standing: need.standing === true,
        role: member.role,
        lead: lead ? lead.key : key,
        mission,
        departure: timeline[0]!.time,
        stationEnd: arrive + plannedStation(mission),
      };
      this.hold(ledger, side, sortie);
      return sortie;
    }
    return null;
  }

  /** The side's airbase or carrier group nearest point p at time t (a rescue's alert detachment). */
  private nearestBase(side: Side, p: Readonly<Dir>, t: GameTime): BaseRef {
    const air = this.w.air;
    const R = this.w.input.radius;
    let best: BaseRef | null = null;
    let bestD = Infinity;
    const refs: BaseRef[] = [
      ...this.w.input.airbases
        .filter((a) => a.side === side)
        .map((a) => ({ kind: 'airbase' as const, id: a.id })),
      ...air.carriers
        .map((c, id) => ({ c, id }))
        .filter((x) => x.c.cast.side === side)
        .map((x) => ({ kind: 'carrier' as const, id: x.id })),
    ];
    for (const ref of refs) {
      const d = arcDistance(air.basePoint(ref, t), p, R);
      if (d < bestD) {
        bestD = d;
        best = ref;
      }
    }
    return best ?? { kind: 'airbase', id: 0 };
  }

  // ---- Commitment ----

  private commit(side: Side, now: GameTime, sim: Simulation): void {
    const order = this.orders[side];
    if (!order) return;
    const air = this.w.air;
    const due = order.planned.filter((s) => s.departure < now + COMMIT_AHEAD);
    if (due.length === 0) return;
    const dropped = new Set<string>();
    const done = new Set<Sortie>();
    for (const s of due) {
      done.add(s);
      const m = s.mission;
      let reason: string | null = dropped.has(s.lead) ? 'package cancelled' : null;
      if (!reason && s.departure < now) reason = 'late';
      if (!reason) reason = this.refusal(m, now);
      const sq = air.squadrons[m.squadron]!;
      if (!reason && sq.available < m.aircraft) reason = 'aircraft';
      if (!reason && air.crewsFree(sq.id, s.departure) < m.aircraft) reason = 'crews';
      if (!reason) {
        const d = air.draw(m);
        const st = air.base(m.base).stocks;
        if (!stocked(st, d)) reason = 'stocks';
      }
      if (reason) {
        if (s.role === 'lead') dropped.add(s.key);
        this.count(side, reason);
        sim.log.decision(now, {
          kind: 'sortie-cancelled',
          side,
          sortie: s.key,
          type: m.type,
          reason,
        });
        continue;
      }
      const at = aircraftType(m.aircraftType);
      if (air.ground)
        m.route = floorRoute(m.route, air.ground, clearanceFor(at), this.w.input.radius);
      m.timeline = routeTimeline(m.route);
      m.id = air.newMissionId();
      air.launch(m, sim);
      this.stats[side].committed++;
      this.filled.add(`${side}:${s.request}`);
      if (s.standing && s.role === 'lead') {
        const k = `${side}:${s.need}`;
        this.covered.set(k, Math.max(this.covered.get(k) ?? -Infinity, s.stationEnd));
      }
      if (
        s.role === 'lead' &&
        (m.target.kind === 'site' || m.target.kind === 'airbase' || m.target.kind === 'road')
      ) {
        this.struck.set(`${side}:${m.target.kind}:${m.target.id}`, now);
      }
    }
    order.planned = order.planned.filter((s) => !done.has(s));
  }

  private unfilled(side: Side, type: MissionType): void {
    const u = (this.stats[side].unfilled[type] ??= {});
    u[this.failure] = (u[this.failure] ?? 0) + 1;
  }

  private count(side: Side, reason: string): void {
    const c = this.stats[side].cancelled;
    c[reason] = (c[reason] ?? 0) + 1;
  }

  // ---- The planner's view ----

  private supply(side: Side): SupplyLines {
    const nets = this.w.networks;
    if (!nets) return { side, sites: new Map(), roads: [] };
    const cutRoad =
      this.w.damage?.cutBridges(nets.road.input, ROAD_BRIDGE_LISTS) ?? new Set<number>();
    const cutRail =
      this.w.damage?.cutBridges(nets.rail.input, RAIL_BRIDGE_LISTS) ?? new Set<number>();
    const ground = this.w.ground ?? null;
    const key = `${side}|${ground?.revision ?? 0}|${[...cutRoad].sort((a, b) => a - b).join(',')}|${[...cutRail].sort((a, b) => a - b).join(',')}`;
    let s = this.supplyCache.get(key);
    if (!s) {
      if (this.supplyCache.size > 64) this.supplyCache.clear();
      s = supplyLines(
        this.w.input,
        side,
        this.currentSegments(),
        { ...nets, cutRoad, cutRail },
        ground ? (t, f, sd, b) => ground.frontPoint(t, f, sd, b) : null,
      );
      this.supplyCache.set(key, s);
    }
    return s;
  }

  /** Every front's segments: the ground war's, at the line now, or the start line's. */
  private currentSegments(): FrontSegment[] {
    return this.w.ground?.segments() ?? this.segments;
  }

  /** The planner's view for one side at one revision. */
  context(side: Side, now: GameTime, day: number): PlanContext {
    const w = this.w;
    const input = w.input;
    const R = input.radius;
    const enemy: Side = side === 'alliance' ? 'pact' : 'alliance';
    const dayStart = day * this.dayLength;
    const dayRoot = this.root.fork(side).fork(`day-${day}`);
    const env = this.env;
    env.now = now;
    const supplyOf = () => this.supply(enemy);
    const stations = this.stations;
    const struck = this.struck;
    const initial = this.initial;
    const dayLength = this.dayLength;
    const roles = new Set<AircraftRole>();
    for (const sq of w.air.squadrons)
      if (sq.side === side && sq.aircraft > 0) roles.add(aircraftType(sq.type).role);
    return {
      side,
      enemy,
      input,
      air: w.air,
      now,
      day,
      dayStart,
      dayLength: this.dayLength,
      env,
      segments: this.currentSegments(),
      get enemySupply() {
        return supplyOf();
      },
      frontPoint(theater, frac, setback) {
        if (w.ground) return w.ground.frontPoint(theater, frac, side, setback);
        const f = input.fronts.find((x) => x.theater === theater);
        if (!f) return null;
        return frontPoint(f, stations.get(theater)!, frac, side, setback, R);
      },
      damage: (id) => w.damage?.damage(id) ?? 0,
      lastStruck: (key) => struck.get(`${side}:${key}`) ?? -Infinity,
      rng: (key) => dayRoot.fork(key),
      schedule: (timing: Timing, count, window, key) =>
        scheduleTimes(side, timing, count, window, dayRoot.fork(`schedule:${key}`)),
      window(d, light) {
        const a = dayStart + FIRST_LEAD;
        const b = dayStart + dayLength;
        if (light === 'any') return [a, b];
        return env.window(d, a, b, light === 'day');
      },
      theaterName: (i) => input.theaters[i]?.name ?? 'the theater',
      theaterWeight: (i) => input.theaters[i]?.weight ?? 0.5,
      town(d, within = TOWN_RANGE) {
        let best: string | undefined;
        let bestDot = Math.cos(within / R);
        for (const p of input.places ?? []) {
          const c = dot(p.point, d);
          if (c > bestDot) {
            bestDot = c;
            best = p.name;
          }
        }
        return best;
      },
      hasRole: (role) => roles.has(role),
      initialStocks: (ref: BaseRef) =>
        initial[ref.kind === 'airbase' ? ref.id : input.airbases.length + ref.id]!,
    };
  }

  // ---- Saved state (R1.2) ----

  save(): AtoState {
    return structuredClone({
      orders: this.orders,
      struck: [...this.struck],
      covered: [...this.covered],
      filled: [...this.filled],
      stats: this.stats,
    });
  }

  load(state: unknown): void {
    const s = structuredClone(state as AtoState);
    this.orders.alliance = s.orders.alliance;
    this.orders.pact = s.orders.pact;
    this.struck.clear();
    this.covered.clear();
    this.filled.clear();
    for (const [k, v] of s.struck) this.struck.set(k, v);
    for (const [k, v] of s.covered) this.covered.set(k, v);
    for (const k of s.filled) this.filled.add(k);
    this.stats.alliance = s.stats.alliance;
    this.stats.pact = s.stats.pact;
  }

  hash(h: StateHasher): void {
    for (const side of SIDES) {
      const o = this.orders[side];
      if (!o) {
        h.number(-1);
        continue;
      }
      h.string(side).number(o.day).number(o.revision).number(o.issued).number(o.planned.length);
      for (const s of o.planned) {
        h.string(s.key).number(s.departure).number(s.mission.squadron).number(s.mission.seed);
      }
    }
    for (const [k, v] of [...this.struck].sort()) h.string(k).number(v);
    for (const [k, v] of [...this.covered].sort()) h.string(k).number(v);
    for (const k of [...this.filled].sort()) h.string(k);
  }
}

/** A flight's aircraft: the type's flight size, or fewer where the profile asks (R2.9). */
const flightOf = (t: { flightSize: number }, p: { flightSize?: number }) =>
  Math.min(t.flightSize, p.flightSize ?? Infinity);

/** The ledger's key for a squadron's crews (aircraft use the squadron's id). */
const crewKey = (sq: number) => -1 - sq;
const crewOf = (t: { crew: number }) => Math.max(1, t.crew);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function callsign(side: Side, r: Rng): string {
  if (side === 'pact') return String(100 + r.int(900));
  return `${ALLIANCE_CALLSIGNS[r.int(ALLIANCE_CALLSIGNS.length)]} ${1 + r.int(9)}${1 + r.int(9)}`;
}
