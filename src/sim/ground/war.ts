/**
 * The ground war in aggregate (roadmap R2.3): battalions on every continental
 * front, fighting segment by segment each game minute, supplied over the road
 * graph, attacked from the air, moving the front.
 *
 * - **Combat.** On each front segment the attacker's and the defender's power
 *   is the sum of their battalions' value × strength × supply factor (0.4 +
 *   0.6 · supply). The defender fights from the terrain (the start line's
 *   barrier strength) and prepared positions: its multiplier is 1 +
 *   TERRAIN_DEFENSE · terrain + PREPARED. Lanchester's square law gives each
 *   side's losses per minute (K_ATTRITION times the other side's power, the
 *   defender's raised by its multiplier, the attacker's lowered by it), times
 *   the fighting's intensity: 1 where the attacker is on the offensive, QUIET
 *   elsewhere. Losses go to the battalions by their share of the power.
 * - **Offensives** open where the pressure (front.ts) reaches
 *   OFFENSIVE_PRESSURE, along the invasion corridors (decision 96), and stop
 *   when the attacker there has fallen below CULMINATION of its strength at the
 *   start: the offensive has culminated.
 * - **Movement.** A segment moves by the force ratio r = A / (D · multiplier):
 *   at V_MAX · (r − 1) / (r + 1) · 2 (at most V_MAX forward, half of it back),
 *   slowed by the terrain, within MAX_OFFSET of the start line and
 *   MAX_SHEAR of its neighbors. The front line is the start line moved by each
 *   segment's offset, toward the defender's ground (or back).
 * - **Supply**, every game hour, per segment and side: the best of its
 *   sources (depots and rear cities, supply.ts) by the road graph with cut
 *   bridges, 1 at a way no longer than 1.5 times the straight distance and less
 *   with detours, times the source's undamaged share and half of the worst road
 *   damage on the way; at least LOCAL_SUPPLY from what the troops carry.
 * - **Air support.** Each attack on troops the air war records (R2.2's CAS)
 *   kills CAS_KILL battalion equivalents per unit on the nearest segment of the
 *   enemy; interdiction acts through supply.
 * - **Promotion** (R2.8, decision 333). Each battalion has an anchor: spread along its
 *   segment among the side's battalions there, BATTALION_DEPTH[kind] behind the line,
 *   facing the enemy. The main thread promotes the battalions near the player into
 *   vehicles (promotion.ts); a vehicle full fidelity destroys comes back as the
 *   `vehicle-destroyed` input, which lowers its battalion's strength by one vehicle
 *   and keeps it dead and its wreck where it burned.
 *
 * The constants are priors for the demo; R5.6 tunes the campaign.
 */
import type { Side } from '../../campaign/cast';
import { arcDistance, initialHeading, polylineStations, toward } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import type { WorldSeed } from '../../core/rng';
import { DAY, MINUTE } from '../../core/units';
import type { GameTime } from '../../core/units';
import type { CampaignInput, FrontInput } from '../command/campaignInput';
import { RAIL_BRIDGE_LISTS, ROAD_BRIDGE_LISTS } from '../command/campaignInput';
import { BASE_PRESSURE, frontPoint, frontSegments } from '../command/front';
import type { FrontSegment } from '../command/front';
import { supplySources, SUPPLY_REACH, SUPPLY_SETBACK } from '../command/supply';
import type { Simulation, TickProcess } from '../simulation';
import type { StateHasher } from '../stateHash';
import type { DamageState } from './damage';
import type { NetworkGraph } from './network';
import { BATTALION_VALUE, buildGroundOrbat } from './orbat';
import type { Battalion, BattalionKind, GroundOrbat } from './orbat';
import { rosterOrder, rosterSize, strengthAfterKill } from './promotion';
import type { VehicleType } from './promotion';

export const K_ATTRITION = 0.08 / DAY;
export const QUIET = 0.15;
export const TERRAIN_DEFENSE = 0.8;
export const PREPARED = 0.2;
export const V_MAX = 25e3 / DAY;
export const TERRAIN_SLOW = 0.6;
export const MAX_OFFSET = 200e3;
export const MAX_SHEAR = 60e3;
export const OFFENSIVE_PRESSURE = 0.5;
export const CULMINATION = 0.5;
export const CAS_KILL = 0.04;
export const LOCAL_SUPPLY = 0.25;
/** The map's unit grid behind a segment: first row's depth and the spacing of columns and rows (m). */
export const UNIT_DEPTH = 10e3;
export const UNIT_SPACING = 14e3;
/** A battalion's anchor behind the line by kind (m), plus up to BATTALION_JITTER from its seed (R2.8). */
export const BATTALION_DEPTH: Record<BattalionKind, number> = {
  tank: 2.5e3,
  mechanized: 2e3,
  'air-defense': 5e3,
  artillery: 9e3,
  logistics: 16e3,
};
export const BATTALION_JITTER = 1.5e3;
/** Wrecks the picture carries at most, the latest kept. */
export const MAX_WRECKS = 400;

const other = (s: Side): Side => (s === 'alliance' ? 'pact' : 'alliance');

interface FrontState {
  input: FrontInput;
  stations: Float64Array;
  length: number;
  segments: FrontSegment[];
  terrain: number[];
  /** Battalions per segment and side. */
  members: Record<Side, number[][]>;
}

export interface GroundState {
  strength: number[];
  offsets: number[][];
  offensive: boolean[][];
  supply: Record<Side, number[]>[];
  start: number[][];
  activity: number[][];
  attacksSeen: number;
  revision: number;
  /** Vehicles full fidelity destroyed, by battalion (R2.8; absent before decision 333). */
  killed?: [number, number[]][];
  wrecks?: VehicleWreck[];
}

/** A vehicle full fidelity destroyed (R2.8): where its wreck burns. */
export interface VehicleWreck {
  battalion: number;
  /** Its index in the battalion's roster order. */
  vehicle: number;
  type: VehicleType;
  side: Side;
  point: Dir;
  heading: number;
  time: number;
}

/** A battalion as the main thread promotes it (R2.8). */
export interface BattalionPicture {
  id: number;
  side: Side;
  kind: BattalionKind;
  seed: number;
  strength: number;
  killed: number[];
  /** Its anchor and the heading toward the enemy (rad from north). */
  point: Dir;
  heading: number;
}

/** What the map draws of the ground war (the worker's snapshot, R2.3). */
export interface GroundPicture {
  revision: number;
  /** Each front's line now: unit directions, xyz interleaved. */
  fronts: { theater: number; attacker: Side; points: number[] }[];
  /** Brigades and regiments with their strength, behind the line. */
  units: { side: Side; kind: 'tank' | 'mechanized'; name: string; point: Dir; strength: number }[];
  /** Every battalion with its anchor, for promotion near the player (R2.8). */
  battalions: BattalionPicture[];
  /** The latest wrecks of vehicles full fidelity destroyed (R2.8). */
  wrecks: VehicleWreck[];
}

export class GroundWar implements TickProcess {
  readonly name = 'ground';
  readonly period = MINUTE;
  readonly orbat: GroundOrbat;
  private readonly fronts: FrontState[];
  private offsets: number[][];
  private offensive: boolean[][];
  private supply: Record<Side, number[]>[];
  private start: number[][];
  private activity: number[][];
  private attacksSeen = 0;
  /** Vehicles full fidelity destroyed, by battalion, and their wrecks (R2.8). */
  private killed = new Map<number, number[]>();
  private wrecks: VehicleWreck[] = [];
  /** Bumped every game hour the front moved, and when units change much (snapshots resend the picture). */
  revision = 0;

  constructor(
    private readonly input: CampaignInput,
    seed: WorldSeed,
    private readonly networks: { road: NetworkGraph; rail: NetworkGraph } | null,
    private readonly damage: DamageState | null,
  ) {
    const R = input.radius;
    this.fronts = input.fronts.map((f) => {
      const stations = polylineStations(f.points, R);
      const segments = frontSegments(f, R);
      const n = f.points.length / 3;
      const terrain = segments.map((s) => {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < n; i++) {
          const frac = stations[i]! / stations[n - 1]!;
          if (frac >= s.from && frac <= s.to) {
            sum += f.strength[i] ?? 0;
            count++;
          }
        }
        return count > 0 ? sum / count : 0;
      });
      return {
        input: f,
        stations,
        length: stations[n - 1]!,
        segments,
        terrain,
        members: { alliance: segments.map(() => []), pact: segments.map(() => []) },
      };
    });
    const byTheater = new Map(this.fronts.map((s) => [s.input.theater, s]));
    this.orbat = buildGroundOrbat(
      input,
      (t) => byTheater.get(t)!.segments,
      (t) => byTheater.get(t)!.length,
      seed,
    );
    for (const b of this.orbat.battalions)
      byTheater.get(b.theater)!.members[b.side][b.segment]!.push(b.id);
    this.offsets = this.fronts.map((f) => f.segments.map(() => 0));
    this.offensive = this.fronts.map((f) =>
      f.segments.map((s) => s.pressure >= OFFENSIVE_PRESSURE),
    );
    this.supply = this.fronts.map((f) => ({
      alliance: f.segments.map(() => 1),
      pact: f.segments.map(() => 1),
    }));
    this.activity = this.fronts.map((f) => f.segments.map(() => 0));
    this.start = this.fronts.map((f, i) =>
      f.segments.map((_, s) => this.power(i, s, f.input.attacker)),
    );
  }

  // ---- The front's geometry ----

  private front(theater: number): { state: FrontState; index: number } | null {
    const index = this.fronts.findIndex((f) => f.input.theater === theater);
    return index < 0 ? null : { state: this.fronts[index]!, index };
  }

  /** The offset (m, + toward the defender) at fraction `frac` of a front, between segment centers. */
  private offsetAt(i: number, frac: number): number {
    const segs = this.fronts[i]!.segments;
    const off = this.offsets[i]!;
    const n = segs.length;
    const x = frac * n - 0.5;
    if (x <= 0) return off[0]!;
    if (x >= n - 1) return off[n - 1]!;
    const k = Math.floor(x);
    return off[k]! + (off[k + 1]! - off[k]!) * (x - k);
  }

  private moved(i: number, base: Readonly<Dir>, frac: number): Dir {
    const f = this.fronts[i]!.input;
    const off = this.offsetAt(i, frac);
    if (Math.abs(off) < 1) return [...base] as Dir;
    const defender = other(f.attacker);
    return toward(
      base,
      f.centroid[off > 0 ? defender : f.attacker],
      Math.abs(off),
      this.input.radius,
    );
  }

  /** A point on a front's line now, `setback` into `side`'s ground, and the line's heading. */
  frontPoint(
    theater: number,
    frac: number,
    side: Side,
    setback: number,
  ): { point: Dir; heading: number } | null {
    const fr = this.front(theater);
    if (!fr) return null;
    const { state, index } = fr;
    const at = frontPoint(state.input, state.stations, frac, side, 0, this.input.radius);
    const now = this.moved(index, at.point, frac);
    if (setback <= 0) return { point: now, heading: at.heading };
    const c = state.input.centroid[side];
    const d = arcDistance(now, c, this.input.radius);
    return {
      point: toward(now, c, Math.min(setback, 0.7 * d), this.input.radius),
      heading: at.heading,
    };
  }

  /** A front's line now: its start line's points moved by the offsets. */
  frontLine(theater: number): number[] {
    const fr = this.front(theater);
    if (!fr) return [];
    const { state, index } = fr;
    const p = state.input.points;
    const out: number[] = [];
    for (let k = 0; k < p.length / 3; k++) {
      const frac = state.stations[k]! / state.length;
      out.push(...this.moved(index, [p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!], frac));
    }
    return out;
  }

  /** Every front's segments now: at the moved line, with the pressure of the fighting there (the ATO's view). */
  segments(): FrontSegment[] {
    const out: FrontSegment[] = [];
    this.fronts.forEach((f, i) => {
      const max = Math.max(1e-9, ...this.activity[i]!);
      f.segments.forEach((s, k) => {
        const mid = (s.from + s.to) / 2;
        const p = this.frontPoint(f.input.theater, mid, f.input.attacker, 0)!;
        const busy = this.activity[i]![k]! > 0;
        out.push({
          ...s,
          point: p.point,
          pressure: busy
            ? BASE_PRESSURE + (1 - BASE_PRESSURE) * (this.activity[i]![k]! / max)
            : s.pressure,
        });
      });
    });
    return out;
  }

  /** Each front's offset per segment (m, + toward the defender). */
  frontOffsets(theater: number): number[] {
    const fr = this.front(theater);
    return fr ? [...this.offsets[fr.index]!] : [];
  }

  supplyOf(theater: number, segment: number, side: Side): number {
    const fr = this.front(theater);
    return fr ? this.supply[fr.index]![side][segment]! : 1;
  }

  // ---- Combat ----

  private power(i: number, s: number, side: Side): number {
    let p = 0;
    const sup = 0.4 + 0.6 * this.supply[i]![side][s]!;
    for (const id of this.fronts[i]!.members[side][s]!) {
      const b = this.orbat.battalions[id]!;
      p += BATTALION_VALUE[b.kind] * b.strength * sup;
    }
    return p;
  }

  /** Takes `loss` battalion equivalents from `side` on a segment, by each battalion's share of its power. */
  private lose(i: number, s: number, side: Side, loss: number, power: number): void {
    if (loss <= 0 || power <= 0) return;
    const sup = 0.4 + 0.6 * this.supply[i]![side][s]!;
    for (const id of this.fronts[i]!.members[side][s]!) {
      const b = this.orbat.battalions[id]!;
      const v = BATTALION_VALUE[b.kind];
      const share = (v * b.strength * sup) / power;
      b.strength = Math.max(0, b.strength - (loss * share) / (v * sup));
    }
  }

  step(_t: GameTime, k: number, _sim: Simulation): void {
    if (k % 60 === 0) this.updateSupply();
    this.applyAir();
    const dt = this.period;
    this.fronts.forEach((f, i) => {
      const attacker = f.input.attacker;
      const defender = other(attacker);
      const off = this.offsets[i]!;
      f.segments.forEach((_, s) => {
        const a = this.power(i, s, attacker);
        const d = this.power(i, s, defender);
        if (this.offensive[i]![s] && a < CULMINATION * this.start[i]![s]!)
          this.offensive[i]![s] = false;
        const intensity = this.offensive[i]![s] ? 1 : QUIET;
        const m = 1 + TERRAIN_DEFENSE * f.terrain[s]! + PREPARED;
        this.activity[i]![s] = intensity * (a + d);
        this.lose(i, s, attacker, K_ATTRITION * intensity * d * m * dt, a);
        this.lose(i, s, defender, (K_ATTRITION * intensity * a * dt) / m, d);
        if (a + d <= 0) return;
        const r = a / Math.max(1e-9, d * m);
        const push = Math.max(-0.5, Math.min(1, ((r - 1) / (r + 1)) * 2));
        off[s] = Math.max(
          -MAX_OFFSET,
          Math.min(
            MAX_OFFSET,
            off[s]! + V_MAX * intensity * push * (1 - TERRAIN_SLOW * f.terrain[s]!) * dt,
          ),
        );
      });
      // The front holds together: neighbors stay within MAX_SHEAR.
      for (let s = 1; s < off.length; s++) {
        off[s] = Math.max(off[s - 1]! - MAX_SHEAR, Math.min(off[s - 1]! + MAX_SHEAR, off[s]!));
      }
      for (let s = off.length - 2; s >= 0; s--) {
        off[s] = Math.max(off[s + 1]! - MAX_SHEAR, Math.min(off[s + 1]! + MAX_SHEAR, off[s]!));
      }
    });
    if (k % 60 === 0) this.revision++;
  }

  /** Attacks on troops from the air war since the last tick (R2.2's CAS). */
  private applyAir(): void {
    const attacks = this.damage?.attacks;
    if (!attacks) return;
    const R = this.input.radius;
    for (; this.attacksSeen < attacks.length; this.attacksSeen++) {
      const a = attacks[this.attacksSeen]!;
      const fr = this.front(a.theater);
      if (!fr) continue;
      const enemy = other(a.side as Side);
      let best = 0;
      let bestD = Infinity;
      fr.state.segments.forEach((s, k) => {
        const p = this.frontPoint(a.theater, (s.from + s.to) / 2, enemy, 0)!.point;
        const d = arcDistance(p, a.point, R);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      });
      this.lose(fr.index, best, enemy, CAS_KILL * a.amount, this.power(fr.index, best, enemy));
    }
  }

  // ---- Supply ----

  private updateSupply(): void {
    const nets = this.networks;
    if (!nets) return;
    const R = this.input.radius;
    const cut = this.damage?.cutBridges(nets.road.input, ROAD_BRIDGE_LISTS) ?? new Set<number>();
    void RAIL_BRIDGE_LISTS;
    const all = this.segments();
    for (const side of ['alliance', 'pact'] as const) {
      const sources = supplySources(this.input, side, all)
        .map((x) => ({ ...x, node: snap(nets.road, x.point) }))
        .filter((x) => x.node >= 0);
      this.fronts.forEach((f, i) => {
        f.segments.forEach((s, k) => {
          const sink = this.frontPoint(
            f.input.theater,
            (s.from + s.to) / 2,
            side,
            SUPPLY_SETBACK,
          )!.point;
          const root = snap(nets.road, sink);
          let best = LOCAL_SUPPLY;
          if (root >= 0) {
            const tree = nets.road.tree(root, cut, SUPPLY_REACH);
            for (const x of sources) {
              const dist = tree.dist[x.node]!;
              if (!Number.isFinite(dist)) continue;
              let worst = 0;
              for (let y = x.node; y >= 0; y = tree.prev[y]!) {
                const e = tree.prevEdge[y]!;
                if (e >= 0) worst = Math.max(worst, this.damage?.roadDamage(e) ?? 0);
              }
              const straight = Math.max(1, arcDistance(x.point, sink, R));
              const q =
                (1 - (x.site >= 0 ? (this.damage?.damage(x.site) ?? 0) : 0)) *
                Math.min(1, (1.5 * straight) / Math.max(dist, 1)) *
                (1 - 0.5 * worst);
              best = Math.max(best, q);
            }
          }
          this.supply[i]![side][k] = best;
        });
      });
    }
  }

  // ---- Promotion (R2.8) ----

  /**
   * Battalion b's anchor now: spread along its segment among its side's battalions there,
   * BATTALION_DEPTH behind the moved line plus a jitter from its seed, and the heading
   * toward the enemy (the line's point at the same fraction).
   */
  battalionAnchor(id: number): { point: Dir; heading: number } | null {
    const b = this.orbat.battalions[id];
    const fr = b ? this.front(b.theater) : null;
    if (!b || !fr) return null;
    const seg = fr.state.segments[b.segment]!;
    const members = fr.state.members[b.side][b.segment]!;
    const j = Math.max(0, members.indexOf(id));
    const n = Math.max(1, members.length);
    const frac = seg.from + ((j + 0.5) / n) * (seg.to - seg.from);
    const depth = BATTALION_DEPTH[b.kind] + ((b.seed % 1009) / 1009) * BATTALION_JITTER;
    const at = this.frontPoint(b.theater, frac, b.side, depth);
    const line = this.frontPoint(b.theater, frac, b.side, 0);
    if (!at || !line) return null;
    const far = arcDistance(at.point, line.point, this.input.radius) > 1;
    return {
      point: at.point,
      heading: far
        ? initialHeading(at.point, line.point)
        : at.heading + (b.side === fr.state.input.attacker ? Math.PI / 2 : -Math.PI / 2),
    };
  }

  /** Vehicles full fidelity destroyed in battalion `id`, by roster index. */
  killedOf(id: number): readonly number[] {
    return this.killed.get(id) ?? [];
  }

  /**
   * Full fidelity destroyed vehicle `vehicle` of battalion `id` at `point` (the
   * `vehicle-destroyed` input): its battalion loses exactly one vehicle of strength, the
   * vehicle stays dead, and its wreck burns there. False if it was dead already.
   */
  destroyVehicle(
    id: number,
    vehicle: number,
    point: Readonly<Dir>,
    heading: number,
    time: number,
  ): boolean {
    const b = this.orbat.battalions[id];
    if (!b || !Number.isInteger(vehicle) || vehicle < 0 || vehicle >= rosterSize(b.kind))
      return false;
    const dead = this.killed.get(id) ?? [];
    if (dead.includes(vehicle)) return false;
    this.killed.set(
      id,
      [...dead, vehicle].sort((a, c) => a - c),
    );
    b.strength = strengthAfterKill(b.kind, b.strength);
    this.wrecks.push({
      battalion: id,
      vehicle,
      type: rosterOrder(b.kind)[vehicle]!,
      side: b.side,
      point: [point[0], point[1], point[2]],
      heading,
      time,
    });
    if (this.wrecks.length > MAX_WRECKS) this.wrecks.splice(0, this.wrecks.length - MAX_WRECKS);
    this.revision++;
    return true;
  }

  // ---- The map's picture ----

  picture(): GroundPicture {
    const units: GroundPicture['units'] = [];
    for (const f of this.fronts) {
      for (const side of ['alliance', 'pact'] as const) {
        f.segments.forEach((s, k) => {
          const brigades = [
            ...new Set(f.members[side][k]!.map((id) => this.orbat.battalions[id]!.brigade)),
          ].sort((a, b) => a - b);
          // A grid behind the segment: columns UNIT_SPACING apart along it, rows deeper.
          const cols = Math.max(
            1,
            Math.min(brigades.length, Math.floor(((s.to - s.from) * f.length) / UNIT_SPACING)),
          );
          brigades.forEach((id, j) => {
            const br = this.orbat.brigades[id]!;
            const col = j % cols;
            const row = Math.floor(j / cols);
            const frac = s.from + ((col + 0.5) / cols) * (s.to - s.from);
            const depth = UNIT_DEPTH + row * UNIT_SPACING;
            const p = this.frontPoint(f.input.theater, frac, side, depth)!.point;
            const bns = br.battalions.map((b) => this.orbat.battalions[b]!);
            units.push({
              side,
              kind: br.kind,
              name: br.name,
              point: p,
              strength: bns.reduce((a, b) => a + b.strength, 0) / Math.max(1, bns.length),
            });
          });
        });
      }
    }
    const battalions: BattalionPicture[] = [];
    for (const b of this.orbat.battalions) {
      const a = this.battalionAnchor(b.id);
      if (!a) continue;
      battalions.push({
        id: b.id,
        side: b.side,
        kind: b.kind,
        seed: b.seed,
        strength: b.strength,
        killed: [...this.killedOf(b.id)],
        point: a.point,
        heading: a.heading,
      });
    }
    return {
      revision: this.revision,
      battalions,
      wrecks: this.wrecks.map((w) => ({ ...w, point: [...w.point] as Dir })),
      fronts: this.fronts.map((f) => ({
        theater: f.input.theater,
        attacker: f.input.attacker,
        points: this.frontLine(f.input.theater),
      })),
      units,
    };
  }

  // ---- Saved state ----

  save(): GroundState {
    return structuredClone({
      strength: this.orbat.battalions.map((b) => b.strength),
      offsets: this.offsets,
      offensive: this.offensive,
      supply: this.supply,
      start: this.start,
      activity: this.activity,
      attacksSeen: this.attacksSeen,
      revision: this.revision,
      killed: [...this.killed].sort((a, b) => a[0] - b[0]),
      wrecks: this.wrecks,
    });
  }

  load(state: unknown): void {
    const s = structuredClone(state as GroundState);
    if (s.strength.length !== this.orbat.battalions.length) {
      throw new Error('Saved ground state does not match this order of battle');
    }
    s.strength.forEach((v, i) => (this.orbat.battalions[i]!.strength = v));
    this.offsets = s.offsets;
    this.offensive = s.offensive;
    this.supply = s.supply;
    this.start = s.start;
    this.activity = s.activity;
    this.attacksSeen = s.attacksSeen;
    this.revision = s.revision;
    this.killed = new Map(s.killed ?? []);
    this.wrecks = s.wrecks ?? [];
  }

  hash(h: StateHasher): void {
    for (const b of this.orbat.battalions) h.number(b.strength);
    for (const o of this.offsets) for (const v of o) h.number(v);
    for (const o of this.offensive) for (const v of o) h.number(v ? 1 : 0);
    h.number(this.attacksSeen);
    for (const [id, dead] of [...this.killed].sort((a, b) => a[0] - b[0])) {
      h.number(id).number(dead.length);
      for (const v of dead) h.number(v);
    }
  }

  /** Total strength in battalion equivalents of a side on a front (for tools and tests). */
  strengthOf(theater: number, side: Side): number {
    let p = 0;
    for (const b of this.orbat.battalions as Battalion[]) {
      if (b.theater === theater && b.side === side) p += BATTALION_VALUE[b.kind] * b.strength;
    }
    return p;
  }
}

function snap(g: NetworkGraph, p: Readonly<Dir>): number {
  if (g.nodeCount === 0) return -1;
  const n = g.nearestNode(p);
  return n.distance <= 40e3 ? n.node : -1;
}
