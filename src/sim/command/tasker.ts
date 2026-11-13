/**
 * The interim air tasker (C2, decision 132): plans a believable flow of
 * missions for both sides every game hour, until the rule-based ATO of
 * decision 50 replaces it. It already follows that decision's shape, in a
 * simpler form: it collects needs, ranks them by score (theater weight ×
 * value × urgency, ties by key), and fills them from squadrons in range,
 * nearest base first, under a cap on aircraft in the air.
 *
 * Needs per side and hour:
 * - **Standing CAP** at CAP_STATIONS points along each front, set back
 *   CAP_SETBACK into own territory, over each own carrier group (from its
 *   air wing), and over the first island or forward airfield of each
 *   theater at sea. A station is refilled so that a relief arrives when the
 *   current patrol leaves (within PLAN_AHEAD).
 * - **Support:** an AEW orbit SUPPORT_SETBACK behind each front, and a tanker
 *   track further back.
 * - **Close air support** at random points on each front: CAS_PER_HOUR for
 *   the attacker, fewer for the defender, and attack helicopters every
 *   second hour when a squadron is close enough.
 * - **Strikes** on enemy fixed sites (factories, power plants, refineries,
 *   depots, rail yards, airbases), ranked by value × theater weight, with a
 *   recently struck site discounted. Airbases and high-value sites get an
 *   escort and, where a squadron reaches, SEAD in the same package. The
 *   Alliance spreads STRIKES_PER_HOUR through every hour; the Pact launches
 *   a wave of PACT_WAVE strikes with a common time on target every
 *   PACT_WAVE_PERIOD hours (design: doctrine).
 * - **Reconnaissance** over an enemy site every RECON_PERIOD hours, and
 *   **airlift** from a rear base to a forward or island field every
 *   AIRLIFT_PERIOD hours.
 *
 * Known targets only (decision 53): every target here is a fixed site, known
 * from peacetime intelligence; mobile targets (convoys, carriers, ground
 * units) wait for the intelligence store. Draws come from
 * rng(seed, "ato") forked per side and hour.
 */
import type { Side } from '../../campaign/cast';
import {
  alongPolyline,
  arcDistance,
  polylineStations,
  tangentHeading,
  toward,
} from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { rng } from '../../core/rng';
import type { Rng, WorldSeed } from '../../core/rng';
import { HOUR, MINUTE } from '../../core/units';
import type { GameTime } from '../../core/units';
import type { Simulation, TickProcess } from '../simulation';
import type { StateHasher } from '../stateHash';
import { aircraftType } from '../air/aircraft';
import type { AircraftRole, AircraftType, Loadout } from '../air/aircraft';
import type { AirOps } from '../air/airOps';
import { MISSION_PROFILES } from '../air/mission';
import type { BaseRef, Mission, MissionTarget, MissionType } from '../air/mission';
import { planMissionRoute, timeOnTarget } from '../air/missionRoute';
import { routeTimeline } from '../air/route';
import type { Route } from '../air/route';
import { carrierState } from '../naval/carrierGroup';
import type { CampaignInput, FrontInput } from './campaignInput';

export const ATO_PERIOD = HOUR;
/** Most aircraft of one side in the air at once (C2: 20–50 airborne in all). */
export const MAX_AIRBORNE = 24;
export const CAP_STATIONS = 2;
export const CAP_SETBACK = 40e3;
export const SUPPORT_SETBACK = 150e3;
export const TANKER_SETBACK = 220e3;
export const PLAN_AHEAD = 2 * HOUR;
/** Earliest launch after planning (s). */
export const MIN_LEAD = 10 * MINUTE;
export const CAS_PER_HOUR: Record<'attacker' | 'defender', number> = { attacker: 2, defender: 1 };
export const STRIKES_PER_HOUR = 2;
export const PACT_WAVE = 5;
export const PACT_WAVE_PERIOD = 3;
export const RECON_PERIOD = 3;
export const AIRLIFT_PERIOD = 4;
/** A site struck within this time scores less (s). */
export const RESTRIKE_TIME = 12 * HOUR;

const SIDES: readonly Side[] = ['alliance', 'pact'];

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

interface Need {
  key: string;
  label: string;
  type: MissionType;
  theater: number;
  score: number;
  target: MissionTarget;
  /** Wanted time on target or on station. */
  tot: GameTime;
  stationTime?: number;
  orbitHeading?: number;
  /** Roles that may fly it, in order of preference (the profile's when absent). */
  roles?: readonly AircraftRole[];
  /** Only this base's squadrons (a carrier's own CAP). */
  base?: BaseRef;
  /** Package escorts and SEAD for strikes. */
  escort?: boolean;
  /** Pact waves keep the time on target; others may slip. */
  fixedTot?: boolean;
  /** A standing station, refilled as patrols leave. */
  standing?: boolean;
}

export class InterimTasker implements TickProcess {
  readonly name = 'ato';
  readonly period = ATO_PERIOD;
  private readonly root: Rng;
  /** Last time each target key was struck. */
  private readonly struck = new Map<string, number>();
  /** Latest end of on-station time per standing station key. */
  private readonly covered = new Map<string, number>();
  private readonly frontStations: Map<number, Float64Array>;

  constructor(
    private readonly air: AirOps,
    private readonly input: CampaignInput,
    seed: WorldSeed,
  ) {
    this.root = rng(seed, 'ato');
    this.frontStations = new Map(
      input.fronts.map((f) => [f.theater, polylineStations(f.points, input.radius)]),
    );
  }

  step(t: GameTime, k: number, sim: Simulation): void {
    for (const side of SIDES) {
      const r = this.root.fork(side).fork(`hour-${k}`);
      const needs = this.collect(side, t, k, r);
      needs.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const n of needs) this.fill(side, n, t, r, sim);
    }
  }

  // ---- Needs ----

  private weight(theater: number): number {
    return this.input.theaters[theater]?.weight ?? 0.5;
  }

  /** A point on a front line at fraction f, pulled `setback` toward `side`'s centroid, and the line's heading there. */
  private frontPoint(
    f: FrontInput,
    frac: number,
    side: Side,
    setback: number,
  ): { point: Dir; heading: number } {
    const R = this.input.radius;
    const s = this.frontStations.get(f.theater)!;
    const at = alongPolyline(f.points, s, frac * s[s.length - 1]!);
    const centroid = f.centroid[side];
    const d = arcDistance(at.point, centroid, R);
    const point =
      setback > 0 ? toward(at.point, centroid, Math.min(setback, 0.7 * d), R) : at.point;
    return { point, heading: tangentHeading(at.point, at.tangent) };
  }

  private station(name: string, point: Dir): MissionTarget {
    return { kind: 'station', id: -1, name, point };
  }

  private collect(side: Side, t: GameTime, k: number, r: Rng): Need[] {
    const needs: Need[] = [];
    const theaterName = (i: number) => this.input.theaters[i]?.name ?? 'the theater';
    const standing = (n: Omit<Need, 'tot'>) => {
      n = { ...n, key: `${side}:${n.key}`, standing: true };
      const until = this.covered.get(n.key) ?? t;
      if (until < t + PLAN_AHEAD) needs.push({ ...n, tot: Math.max(until, t + MIN_LEAD) });
    };

    // Fronts: standing CAP, AEW and tanker orbits, CAS.
    for (const f of this.input.fronts) {
      const w = this.weight(f.theater);
      for (let j = 0; j < CAP_STATIONS; j++) {
        const p = this.frontPoint(f, (j + 1) / (CAP_STATIONS + 1), side, CAP_SETBACK);
        standing({
          key: `cap:front:${f.theater}:${j}`,
          label: `CAP over ${theaterName(f.theater)}`,
          type: 'cap',
          theater: f.theater,
          score: 0.9 * w,
          target: this.station(`CAP station ${j + 1}, ${theaterName(f.theater)}`, p.point),
          orbitHeading: p.heading,
        });
      }
      const aew = this.frontPoint(f, 0.5, side, SUPPORT_SETBACK);
      standing({
        key: `support:aew:${f.theater}`,
        label: `Airborne early warning behind ${theaterName(f.theater)}`,
        type: 'support',
        roles: ['aew'],
        theater: f.theater,
        score: 0.85 * w,
        target: this.station(`AEW orbit, ${theaterName(f.theater)}`, aew.point),
        orbitHeading: aew.heading,
      });
      const tanker = this.frontPoint(f, 0.4, side, TANKER_SETBACK);
      standing({
        key: `support:tanker:${f.theater}`,
        label: `Tanker track behind ${theaterName(f.theater)}`,
        type: 'support',
        roles: ['tanker'],
        theater: f.theater,
        score: 0.6 * w,
        target: this.station(`Tanker track, ${theaterName(f.theater)}`, tanker.point),
        orbitHeading: tanker.heading,
      });
      const role = f.attacker === side ? 'attacker' : 'defender';
      for (let j = 0; j < CAS_PER_HOUR[role]; j++) {
        const p = this.frontPoint(f, 0.1 + 0.8 * r.nextFloat(), side, 5e3);
        needs.push({
          key: `cas:${f.theater}:${k}:${j}`,
          label: `Close air support on ${theaterName(f.theater)}`,
          type: 'cas',
          theater: f.theater,
          score: (role === 'attacker' ? 0.75 : 0.55) * w,
          target: {
            kind: 'front',
            id: -1,
            name: `Front, ${theaterName(f.theater)}`,
            point: p.point,
          },
          tot: t + HOUR + r.nextFloat() * HOUR,
          orbitHeading: p.heading,
        });
      }
      if (k % 2 === 0 && role === 'attacker') {
        const p = this.frontPoint(f, 0.1 + 0.8 * r.nextFloat(), side, 3e3);
        needs.push({
          key: `helo:${f.theater}:${k}`,
          label: `Attack helicopters on ${theaterName(f.theater)}`,
          type: 'helo-cas',
          theater: f.theater,
          score: 0.7 * w,
          target: {
            kind: 'front',
            id: -1,
            name: `Front, ${theaterName(f.theater)}`,
            point: p.point,
          },
          tot: t + HOUR + r.nextFloat() * HOUR,
          orbitHeading: p.heading,
        });
      }
    }

    // CAP over own carrier groups, from their own air wings.
    for (const c of this.air.carriers) {
      if (c.cast.side !== side) continue;
      standing({
        key: `cap:carrier:${c.cast.id}`,
        label: `CAP over ${c.cast.name}`,
        type: 'cap',
        theater: c.cast.theater,
        score: 0.95,
        target: this.station(`CAP over ${c.cast.name}`, carrierState(c, t + HOUR).point),
        base: { kind: 'carrier', id: c.cast.id },
      });
    }

    // CAP over the first island or forward field of each theater at sea.
    for (const th of this.input.theaters) {
      if (th.kind !== 'island-campaign' && th.kind !== 'chokepoint' && th.kind !== 'sea-lane')
        continue;
      const field = this.input.airbases.find(
        (a) =>
          a.side === side && a.theater === th.id && (a.kind === 'island' || a.kind === 'forward'),
      );
      if (!field) continue;
      standing({
        key: `cap:field:${field.id}`,
        label: `CAP over ${field.name}`,
        type: 'cap',
        theater: th.id,
        score: 0.8 * th.weight,
        target: this.station(`CAP over ${field.name}`, [...field.point]),
      });
    }

    // Strikes on enemy fixed sites.
    const pool: { target: MissionTarget; theater: number; score: number; airbase: boolean }[] = [];
    for (const x of this.input.targets) {
      if (x.side === side) continue;
      pool.push({
        target: { kind: 'site', id: x.id, name: x.name, point: [...x.point] },
        theater: x.theater,
        score: x.value * this.weight(x.theater),
        airbase: false,
      });
    }
    for (const a of this.input.airbases) {
      if (a.side === side) continue;
      const value =
        a.kind === 'forward' || a.kind === 'island' ? 0.8 : a.kind === 'bomber' ? 0.7 : 0.6;
      pool.push({
        target: { kind: 'airbase', id: a.id, name: a.name, point: [...a.point] },
        theater: a.theater,
        score: value * this.weight(a.theater),
        airbase: true,
      });
    }
    for (const p of pool) {
      const last = this.struck.get(`${p.target.kind}:${p.target.id}`);
      if (last !== undefined && t - last < RESTRIKE_TIME) p.score *= 0.3;
      p.score *= 0.9 + 0.2 * r.nextFloat();
    }
    pool.sort(
      (a, b) =>
        b.score - a.score ||
        a.target.kind.localeCompare(b.target.kind) ||
        a.target.id - b.target.id,
    );
    const wave = side === 'pact';
    const count = wave ? (k % PACT_WAVE_PERIOD === 0 ? PACT_WAVE : 0) : STRIKES_PER_HOUR;
    const waveTot = t + 1.5 * HOUR;
    for (const p of pool.slice(0, count)) {
      const site = p.target.kind === 'site' ? this.input.targets[p.target.id]! : null;
      const industrial =
        site &&
        (site.kind === 'factory' || site.kind === 'power-plant' || site.kind === 'refinery');
      const type: MissionType = p.airbase
        ? 'deep-strike'
        : industrial
          ? 'strategic-bombing'
          : 'interdiction';
      needs.push({
        key: `strike:${p.target.kind}:${p.target.id}:${k}`,
        label: `Strike on ${p.target.name}`,
        type,
        theater: p.theater,
        score: p.score,
        target: p.target,
        tot: wave ? waveTot + (r.nextFloat() - 0.5) * 6 * MINUTE : t + HOUR + r.nextFloat() * HOUR,
        escort: p.airbase || p.score > 0.6,
        fixedTot: wave,
      });
    }

    // Reconnaissance and airlift.
    if (k % RECON_PERIOD === (side === 'pact' ? 1 : 0) && pool.length > 0) {
      const p = pool[r.int(Math.min(pool.length, 12))]!;
      needs.push({
        key: `recon:${k}`,
        label: `Reconnaissance of ${p.target.name}`,
        type: 'recon',
        theater: p.theater,
        score: 0.4,
        target: p.target,
        tot: t + HOUR + r.nextFloat() * HOUR,
      });
    }
    if (k % AIRLIFT_PERIOD === (side === 'pact' ? 2 : 1)) {
      const dests = this.input.airbases.filter(
        (a) => a.side === side && (a.kind === 'forward' || a.kind === 'island'),
      );
      if (dests.length > 0) {
        const d = dests[r.int(dests.length)]!;
        needs.push({
          key: `airlift:${k}`,
          label: `Airlift to ${d.name}`,
          type: 'airlift',
          theater: d.theater,
          score: 0.3,
          target: { kind: 'airbase', id: d.id, name: d.name, point: [...d.point] },
          tot: t + HOUR + r.nextFloat() * HOUR,
        });
      }
    }
    return needs;
  }

  // ---- Filling a need ----

  private fill(side: Side, n: Need, t: GameTime, r: Rng, sim: Simulation): void {
    const pkg = this.air.newPackageId();
    const main = this.plan(side, n, n.type, n.tot, t, r, pkg);
    if (!main) return;
    this.commit(main, sim);
    if (n.standing) {
      const end =
        main.timeline.find((e) => e.phase === 'egress')?.time ??
        main.timeline[main.timeline.length - 1]!.time;
      this.covered.set(n.key, end);
    }
    if (n.type === 'deep-strike' || n.type === 'interdiction' || n.type === 'strategic-bombing') {
      this.struck.set(`${n.target.kind}:${n.target.id}`, t);
    }
    if (!n.escort) return;
    const tot = timeOnTarget(main.route);
    const follow = (key: string, label: string): Need => ({
      ...n,
      key: `${n.key}:${key}`,
      label,
      roles: undefined,
      fixedTot: true,
      standing: false,
    });
    const escort = this.plan(
      side,
      follow('escort', `Escort for ${main.callsign}`),
      'escort',
      tot,
      t,
      r,
      pkg,
    );
    if (escort) this.commit(escort, sim);
    if (n.target.kind === 'airbase') {
      const sead = this.plan(
        side,
        follow('sead', `SEAD for ${main.callsign}`),
        'sead',
        tot - 5 * MINUTE,
        t,
        r,
        pkg,
      );
      if (sead) this.commit(sead, sim);
    }
  }

  private commit(m: Mission, sim: Simulation): void {
    this.air.launch(m, sim);
  }

  /** Plans one flight for a need, or null if no squadron can fly it within the cap. */
  private plan(
    side: Side,
    n: Need,
    type: MissionType,
    tot: GameTime,
    now: GameTime,
    r: Rng,
    pkg: number,
  ): Mission | null {
    const air = this.air;
    const profile = MISSION_PROFILES[type];
    const R = this.input.radius;
    const candidates: {
      sq: number;
      type: AircraftType;
      loadout: Loadout;
      dist: number;
      rank: number;
    }[] = [];
    for (const sq of air.squadrons) {
      if (sq.side !== side) continue;
      if (n.base && (sq.base.kind !== n.base.kind || sq.base.id !== n.base.id)) continue;
      // Air wings fly only in their carrier's theater (theater tasking of carriers is C3).
      if (
        !n.base &&
        sq.base.kind === 'carrier' &&
        air.carriers[sq.base.id]!.cast.theater !== n.theater
      ) {
        continue;
      }
      const at = aircraftType(sq.type);
      const rank = (n.roles ?? profile.roles).indexOf(at.role);
      if (rank < 0 || sq.available < at.flightSize) continue;
      if (type === 'airlift' && sq.base.kind === 'airbase' && sq.base.id === n.target.id) continue;
      const loadout = at.loadouts.find((l) => l.id === profile.loadout) ?? at.loadouts[0]!;
      const dist = arcDistance(air.basePoint(sq.base, tot), n.target.point, R);
      const reach = at.combatRadius * loadout.radiusFactor * this.input.rangeFactor;
      if (dist > reach) continue;
      const stocks = air.base(sq.base).stocks;
      const d = air.draw({ aircraftType: at.id, aircraft: at.flightSize, type });
      if (stocks.fuel < d.fuel || stocks.munitions < d.munitions) continue;
      candidates.push({ sq: sq.id, type: at, loadout, dist, rank });
    }
    // Preferred role first, then the nearest base, then the squadron id.
    candidates.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.sq - b.sq);
    for (const c of candidates.slice(0, 4)) {
      const sq = air.squadrons[c.sq]!;
      const carrierBased = sq.base.kind === 'carrier';
      const plan = (launch: GameTime): Route | null =>
        planMissionRoute({
          type: c.type,
          loadout: c.loadout,
          profile,
          radius: R,
          rangeFactor: this.input.rangeFactor,
          basePoint: (time) => air.basePoint(sq.base, time),
          carrierBased,
          target: n.target.point,
          launch,
          stationTime: n.stationTime,
          orbitHeading: n.orbitHeading,
        });
      const earliest = now + MIN_LEAD;
      let route = plan(earliest);
      if (!route) continue;
      const lead = timeOnTarget(route) - earliest;
      const launch = Math.max(earliest, tot - lead);
      if (launch > earliest) route = plan(launch);
      if (!route) continue;
      if (n.fixedTot && timeOnTarget(route) > tot + 15 * MINUTE) continue;
      if (!this.underCap(side, route, c.type.flightSize)) return null;
      const timeline = routeTimeline(route);
      const id = air.newMissionId();
      return {
        id,
        type,
        side,
        theater: n.theater,
        package: pkg,
        squadron: sq.id,
        aircraftType: c.type.id,
        aircraft: c.type.flightSize,
        loadout: c.loadout.id,
        callsign: this.callsign(side, r),
        base: { ...sq.base },
        target: n.target,
        need: n.label,
        needKey: n.key,
        score: n.score,
        seed: r.nextUint32(),
        route,
        timeline,
      };
    }
    return null;
  }

  /** Whether `aircraft` more in the air along `route` keep the side under MAX_AIRBORNE. */
  private underCap(side: Side, route: Route, aircraft: number): boolean {
    // The count in the air only rises at a takeoff, so its peak over the new
    // flight's time aloft is at the new flight's takeoffs or at another's.
    const spans = airborneSpans(route);
    const times = spans.map((s) => s[0]);
    for (const m of this.air.missions.values()) {
      if (m.side !== side) continue;
      for (const [t0] of airborneSpans(m.route)) {
        if (spans.some(([a, b]) => t0 >= a && t0 < b)) times.push(t0);
      }
    }
    for (const t of times) {
      if (this.air.airborneAt(side, t + 1e-3) + aircraft > MAX_AIRBORNE) return false;
    }
    return true;
  }

  private callsign(side: Side, r: Rng): string {
    if (side === 'pact') return String(100 + r.int(900));
    return `${ALLIANCE_CALLSIGNS[r.int(ALLIANCE_CALLSIGNS.length)]} ${1 + r.int(9)}${1 + r.int(9)}`;
  }

  hash(h: StateHasher): void {
    for (const [k, v] of [...this.struck].sort()) h.string(k).number(v);
    for (const [k, v] of [...this.covered].sort()) h.string(k).number(v);
    this.air.hash(h);
  }
}

/** Time spans a route spends in the air (between ground segments). */
function airborneSpans(route: Route): [GameTime, GameTime][] {
  const spans: [GameTime, GameTime][] = [];
  for (const seg of route.segments) {
    if (seg.kind === 'ground') continue;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last[1] - seg.t0) < 1e-6) last[1] = seg.t1;
    else spans.push([seg.t0, seg.t1]);
  }
  return spans;
}
