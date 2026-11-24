/**
 * Promoted ground units near the player (roadmap R2.8, decisions 333–335): the main
 * thread's side of minimal entity promotion.
 *
 * - **The bubble.** Battalions whose anchor (the ground picture's, from the worker) lies
 *   within PROMOTE_RANGE of the camera's ground point are promoted into vehicles
 *   (`promoteBattalion`, the sim's pure expansion); beyond DEMOTE_RANGE they are demoted.
 *   The bubble collapses above BUBBLE_MAX_RATE (design §Time: above about 16×) and above
 *   the simulation view's 20 km. A promoted battalion keeps its anchor and its vehicles
 *   until it is demoted, so the front's hourly moves do not shift what the player sees;
 *   R3.6 gives the vehicles movement.
 * - **On the ground.** Each vehicle stands on the drawn ground, its hull tilted to the
 *   slope; trucks within ROAD_SNAP of an aligned road stand on it, along it.
 * - **Targets.** The alive vehicles near the flown aircraft are the rack's ground
 *   targets (`targets`); hits add up per vehicle (`VehicleDamage`), and a destroyed one
 *   explodes, turns into a burnt wreck, and goes to the worker as the `vehicle-destroyed`
 *   input, which lowers its battalion's strength by one vehicle (rule 19).
 * - **Wrecks** (the worker's, and those destroyed here before the worker has them) stand
 *   in a burnt scheme where they died and burn as the effects' columns for WRECK_BURN.
 *
 * Drawn instanced by model and scheme (TrafficLayer), without ink or shadows for now.
 */
import { destination, headingTangent, initialHeading } from '../core/greatCircle';
import type { Dir } from '../core/greatCircle';
import { HOUR } from '../core/units';
import type { GameTime, Meters } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { modelSpec } from '../render/common/models/library';
import type { ModelSpec } from '../render/common/models/spec';
import { TrafficLayer } from '../render/sim/aircraft/trafficLayer';
import type { TrafficAircraft } from '../render/sim/aircraft/trafficLayer';
import type { GlobeScene } from '../render/sim/globeScene';
import type { TerrainRenderer } from '../render/sim/terrain/terrainRenderer';
import type { FireColumn } from '../sim/effects/events';
import type { CampaignInputEvent } from '../sim/eventLog';
import type { GroundTarget, Hit } from '../sim/flight/storesRack';
import {
  parseVehicleKey,
  promoteBattalion,
  VEHICLE_MODELS,
  VEHICLE_SCALE,
  VEHICLE_SCHEMES,
  VEHICLE_TARGETS,
  VehicleDamage,
  vehicleKey,
} from '../sim/ground/promotion';
import type { VehicleType } from '../sim/ground/promotion';
import type { BattalionPicture, GroundPicture, VehicleWreck } from '../sim/ground/war';
import type { Side } from '../campaign/cast';
import { NETWORK } from '../worldgen/networks/link';
import type { Alignments } from '../worldgen/networks/alignments';

/** Battalions are promoted within this distance of the camera's ground point, and demoted beyond the second (m). */
export const PROMOTE_RANGE: Meters = 15_000;
export const DEMOTE_RANGE: Meters = 18_000;
/** The bubble collapses above this rate and above this height (m). */
export const BUBBLE_MAX_RATE = 16;
export const BUBBLE_CEILING: Meters = 20_000;
/** Vehicles within this distance of the flown aircraft are the rack's targets (m). */
export const TARGET_RANGE: Meters = 8_000;
/** Wrecks within this distance of the camera are drawn and burn (m). */
export const WRECK_RANGE: Meters = 20_000;
/** A wreck burns this long (s of game time), fading, then smolders out. */
export const WRECK_BURN = 2 * HOUR;
/** A truck within this distance of an aligned road stands on it (m). */
export const ROAD_SNAP: Meters = 400;
/** The height of a vehicle's center over the ground, where rounds and blasts measure from (m). */
export const VEHICLE_CENTER = 1.2 * VEHICLE_SCALE;
/** The explosive a destroyed vehicle's cook-off is drawn with (kg). */
const COOK_OFF: Record<VehicleType, number> = { tank: 60, ifv: 40, shorad: 40, truck: 20 };
/** The ground controller marks enemy battalions of these kinds within MARK_RANGE of the aircraft (decision 337). */
export const MARK_RANGE: Meters = 15_000;
const MARK_KINDS = new Set(['tank', 'mechanized', 'air-defense']);
const MARK_LABELS: Record<string, string> = {
  tank: 'ARMOR',
  mechanized: 'MECH',
  'air-defense': 'SAM',
};
/** Vehicles keep out of forest denser than this and of water, moved up to SITE_REACH on rings SITE_STEP apart (m). */
export const OPEN_FOREST = 0.3;
export const SITE_REACH: Meters = 600;
export const SITE_STEP: Meters = 50;
/** Beyond this distance a vehicle is drawn larger with distance, up to READABLE_MAX times (decision 336). */
export const READABLE_FROM: Meters = 1500;
export const READABLE_MAX = 2.5;
/** How often the heights under the vehicles are sampled again as tiles refine (ms). */
const HEIGHT_REFRESH = 2000;

/** A promoted vehicle in the scene. */
export interface PlacedVehicle {
  key: string;
  battalion: number;
  index: number;
  type: VehicleType;
  side: Side;
  dir: Vec3d;
  heading: number;
  /** Ground height under it (m), or null until the terrain answers. */
  ground: number | null;
  /**
   * Whether it has been sited out of woods and water (decision 336): drawn and a
   * target only once sited. Trucks on a road and wrecks are sited as they are.
   */
  sited: boolean;
  /** Its center (world, m) and its axes, from the ground. */
  pos: Vec3d;
  forward: [number, number, number];
  up: [number, number, number];
}

interface Promoted {
  anchor: Dir;
  heading: number;
  vehicles: PlacedVehicle[];
}

/** Aligned road links with a bounding sphere each, to find the road near a truck. */
interface RoadIndex {
  al: Alignments;
  links: number[];
  center: Vec3d[];
  radius: number[];
}

export class GroundUnits {
  /** The picture's battalions and wrecks (the worker's, hourly and on kills). */
  private battalions: BattalionPicture[] = [];
  private wrecks: VehicleWreck[] = [];
  private readonly promoted = new Map<number, Promoted>();
  private readonly damage = new VehicleDamage();
  /** Wrecks of vehicles destroyed here that the worker's picture does not have yet. */
  private readonly pending = new Map<string, VehicleWreck>();
  private readonly layer: TrafficLayer;
  private roads: RoadIndex | null = null;
  private lastHeights = 0;
  /** Called when the wrecks change (their columns). */
  onWrecks?: () => void;
  /** Promoted battalions and vehicles drawn last frame (for tools and the debug panel). */
  readonly stats = { battalions: 0, vehicles: 0, wrecks: 0 };
  /** The campaign's clock and rate, set by the app each frame. */
  time: GameTime = 0;
  rate = 1;

  constructor(
    private readonly globe: GlobeScene,
    private readonly radius: Meters,
    private readonly post: (input: CampaignInputEvent) => void,
  ) {
    // Ink outlines and contact shadows, as the guide asks of models (decision 340).
    this.layer = new TrafficLayer(globe.lighting, { ink: true, contactShadows: true });
    globe.vehicles.add(this.layer.group);
  }

  /** The worker's ground picture (R2.3, with R2.8's battalions and wrecks). */
  setPicture(p: GroundPicture | null): void {
    this.battalions = p?.battalions ?? [];
    this.wrecks = p?.wrecks ?? [];
    for (const w of this.wrecks) this.pending.delete(vehicleKey(w.battalion, w.vehicle));
    // Vehicles the worker has as killed (a replay, or another session) leave the promoted set.
    const killed = new Map(this.battalions.map((b) => [b.id, new Set(b.killed)]));
    for (const [id, pr] of this.promoted) {
      const dead = killed.get(id);
      if (dead) pr.vehicles = pr.vehicles.filter((v) => !dead.has(v.index));
    }
    this.onWrecks?.();
  }

  /** The aligned roads trucks stand on (decision 184), once the alignment stage is done. */
  setRoads(al: Alignments | null): void {
    if (!al) {
      this.roads = null;
      return;
    }
    const links: number[] = [];
    const center: Vec3d[] = [];
    const radius: number[] = [];
    const p = new Vec3d();
    for (let k = 0; k < al.count; k++) {
      if (al.network[k] === NETWORK.Rail) continue;
      const a = al.offsets[k]!;
      const b = al.offsets[k + 1]!;
      if (b <= a) continue;
      const c = new Vec3d();
      for (let i = a; i < b; i++) c.add(this.roadPoint(al, k, i, p));
      c.scale(1 / (b - a));
      let r = 0;
      for (let i = a; i < b; i++) r = Math.max(r, this.roadPoint(al, k, i, p).distanceTo(c));
      links.push(k);
      center.push(c);
      radius.push(r);
    }
    this.roads = { al, links, center, radius };
  }

  /** Point i of road link k (world, m, on the sphere of the planet's radius). */
  private roadPoint(al: Alignments, k: number, i: number, out: Vec3d): Vec3d {
    return out
      .set(
        al.origin[k * 3]! + al.offset[i * 3]!,
        al.origin[k * 3 + 1]! + al.offset[i * 3 + 1]!,
        al.origin[k * 3 + 2]! + al.offset[i * 3 + 2]!,
      )
      .normalize()
      .scale(this.radius);
  }

  /** The nearest aligned road point within ROAD_SNAP of `d` and the road's heading there, or null. */
  private nearRoad(d: Readonly<Vec3d>): { dir: Vec3d; heading: number } | null {
    const r = this.roads;
    if (!r) return null;
    const p = d.clone().scale(this.radius);
    let best = ROAD_SNAP;
    let found: { k: number; i: number } | null = null;
    const q = new Vec3d();
    for (let j = 0; j < r.links.length; j++) {
      if (p.distanceTo(r.center[j]!) - r.radius[j]! > best) continue;
      const k = r.links[j]!;
      for (let i = r.al.offsets[k]!; i < r.al.offsets[k + 1]!; i++) {
        const dist = this.roadPoint(r.al, k, i, q).distanceTo(p);
        if (dist < best) {
          best = dist;
          found = { k, i };
        }
      }
    }
    if (!found) return null;
    const { k, i } = found;
    const a = this.roadPoint(r.al, k, i, new Vec3d()).normalize();
    const n = i + 1 < r.al.offsets[k + 1]! ? i + 1 : i - 1;
    const b = this.roadPoint(r.al, k, n, new Vec3d()).normalize();
    let heading = initialHeading([a.x, a.y, a.z], [b.x, b.y, b.z]);
    if (n < i) heading += Math.PI;
    return { dir: a, heading };
  }

  // ---- The bubble ----

  /** Promotes and demotes battalions round the camera's ground point, and draws them for the frame from `eye`. */
  place(eye: Readonly<Vec3d>): void {
    const g = this.globe;
    const alt = eye.length() - this.radius;
    const active = this.rate <= BUBBLE_MAX_RATE && alt < BUBBLE_CEILING;
    const center = eye.clone().normalize();
    const c: Dir = [center.x, center.y, center.z];
    if (!active) this.demoteAll();
    else {
      for (const [id, pr] of this.promoted) {
        if (this.arc(pr.anchor, c) > DEMOTE_RANGE) this.demote(id);
      }
      for (const b of this.battalions) {
        if (this.promoted.has(b.id) || b.strength <= 0) continue;
        if (this.arc(b.point, c) > PROMOTE_RANGE) continue;
        this.promote(b);
      }
    }
    const now = performance.now();
    if (now - this.lastHeights > HEIGHT_REFRESH && g.terrainReady) {
      this.lastHeights = now;
      for (const pr of this.promoted.values()) for (const v of pr.vehicles) this.settle(v);
    }
    const list: TrafficAircraft[] = [];
    let vehicles = 0;
    for (const pr of this.promoted.values())
      for (const v of pr.vehicles) {
        if (v.ground === null || !v.sited) continue;
        list.push(this.drawn(v, VEHICLE_SCHEMES[v.side], eye));
        vehicles++;
      }
    let wrecks = 0;
    if (active)
      for (const w of this.allWrecks()) {
        if (this.arc(w.point, c) > WRECK_RANGE) continue;
        const v = this.wreckVehicle(w);
        if (v.ground === null) continue;
        list.push(this.drawn(v, 'burnt', eye));
        wrecks++;
      }
    const cam = (g as Partial<GlobeScene>).camera;
    if (cam && typeof window !== 'undefined')
      this.layer.radPerPixel = (cam.fov * (Math.PI / 180)) / Math.max(1, window.innerHeight);
    this.layer.update(list, eye);
    this.stats.battalions = this.promoted.size;
    this.stats.vehicles = vehicles;
    this.stats.wrecks = wrecks;
  }

  private arc(a: Readonly<Dir>, b: Readonly<Dir>): number {
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return Math.acos(Math.max(-1, Math.min(1, d))) * this.radius;
  }

  private promote(b: BattalionPicture): void {
    const dead = new Set(b.killed);
    for (const k of this.pending.keys()) {
      const v = parseVehicleKey(k);
      if (v?.battalion === b.id) dead.add(v.index);
    }
    const shown = promoteBattalion({ ...b, killed: [...dead] }, b.point, b.heading, this.radius);
    const vehicles = shown.map((s) => {
      const v = this.placed(s.battalion, s.index, s.type, s.side, s.point, s.heading);
      // Trucks on an aligned road near them stand on it, along it.
      if (s.type === 'truck') {
        const road = this.nearRoad(v.dir);
        if (road) {
          v.dir.copy(road.dir);
          v.heading = road.heading + ((s.index & 1) === 0 ? 0 : Math.PI);
          v.sited = true;
        }
      }
      return v;
    });
    // Trucks that snapped onto one point of a road spread out along it.
    const trucks = vehicles.filter((v) => v.type === 'truck');
    for (let i = 1; i < trucks.length; i++)
      for (let j = 0; j < i; j++) {
        const a = trucks[i]!;
        if (a.dir.distanceTo(trucks[j]!.dir) * this.radius < 12) {
          const d = destination([a.dir.x, a.dir.y, a.dir.z], a.heading, 15 * i, this.radius);
          a.dir.set(d[0], d[1], d[2]);
        }
      }
    for (const v of vehicles) this.settle(v);
    this.promoted.set(b.id, { anchor: [...b.point] as Dir, heading: b.heading, vehicles });
  }

  private demote(id: number): void {
    const pr = this.promoted.get(id);
    if (!pr) return;
    // Damage short of destruction is not kept (the vehicles are whole or destroyed, R2.8).
    for (const v of pr.vehicles) this.damage.forget(v.key);
    this.promoted.delete(id);
  }

  private demoteAll(): void {
    for (const id of [...this.promoted.keys()]) this.demote(id);
  }

  private placed(
    battalion: number,
    index: number,
    type: VehicleType,
    side: Side,
    point: Readonly<Dir>,
    heading: number,
  ): PlacedVehicle {
    return {
      key: vehicleKey(battalion, index),
      battalion,
      index,
      type,
      side,
      dir: new Vec3d(point[0], point[1], point[2]),
      heading,
      ground: null,
      sited: false,
      pos: new Vec3d(),
      forward: [1, 0, 0],
      up: [0, 1, 0],
    };
  }

  /** Samples the drawn ground under v and round it: its height, its center and its hull's axes on the slope. */
  private settle(v: PlacedVehicle): void {
    if (!v.sited && !this.site(v)) return;
    const h = this.heightAt(v.dir);
    if (h === null) return;
    v.ground = h;
    const R = this.radius;
    const d: Dir = [v.dir.x, v.dir.y, v.dir.z];
    const at = (bearing: number, dist: number): Vec3d => {
      const p = destination(d, bearing, dist, R);
      const q = new Vec3d(p[0], p[1], p[2]);
      return q.scale(R + (this.heightAt(q) ?? h));
    };
    const base = v.dir.clone().scale(R + h);
    const ahead = at(v.heading, 3)
      .sub(at(v.heading + Math.PI, 3))
      .normalize();
    const right = at(v.heading + Math.PI / 2, 1.5)
      .sub(at(v.heading - Math.PI / 2, 1.5))
      .normalize();
    // Up from the slope (right × ahead points up for a right-handed east-north-up frame).
    const up = new Vec3d(
      right.y * ahead.z - right.z * ahead.y,
      right.z * ahead.x - right.x * ahead.z,
      right.x * ahead.y - right.y * ahead.x,
    ).normalize();
    if (up.dot(v.dir) < 0.5) up.copy(v.dir);
    // Forward square to up.
    const fwd = ahead.addScaled(up, -ahead.dot(up)).normalize();
    v.forward = [fwd.x, fwd.y, fwd.z];
    v.up = [up.x, up.y, up.z];
    v.pos.copy(base);
  }

  /**
   * Moves v out of woods and water (decision 336): where the forest is denser than
   * OPEN_FOREST or the ground is water, to the nearest open ground within SITE_REACH, on
   * rings SITE_STEP apart; it stays put if there is none. False while the terrain's
   * data there is not resident yet (asked for), so the vehicle waits to be drawn.
   */
  private site(v: PlacedVehicle): boolean {
    const terrain = this.globe.terrain as { groundAt?: TerrainRenderer['groundAt'] };
    if (!terrain.groundAt) {
      v.sited = true;
      return true;
    }
    const open = (d: Readonly<Vec3d>): boolean | null => {
      const g = terrain.groundAt!(d);
      return g === null ? null : g.forest < OPEN_FOREST && !g.water;
    };
    const here = open(v.dir);
    if (here === null) return false;
    if (!here) {
      const p: Dir = [v.dir.x, v.dir.y, v.dir.z];
      search: for (let r = SITE_STEP; r <= SITE_REACH; r += SITE_STEP) {
        const n = Math.max(8, Math.round((2 * Math.PI * r) / SITE_STEP));
        for (let k = 0; k < n; k++) {
          const q = destination(p, v.heading + (2 * Math.PI * k) / n, r, this.radius);
          const d = new Vec3d(q[0], q[1], q[2]);
          const ok = open(d);
          if (ok === null) return false;
          if (ok) {
            v.dir.copy(d);
            break search;
          }
        }
      }
    }
    v.sited = true;
    return true;
  }

  private heightAt(d: Readonly<Vec3d>): number | null {
    const g = this.globe;
    if (!g.terrainReady) return null;
    return g.useTiles ? g.terrain.displaySurfaceAt(d) : g.terrain.displayHeightAt(d);
  }

  /**
   * The instance of v for the frame from `eye`: at VEHICLE_SCALE, and beyond READABLE_FROM
   * grown with distance up to READABLE_MAX times more, so a vehicle keeps its size on
   * screen out to a few kilometers (decision 336; hits keep VEHICLE_SCALE).
   */
  private drawn(v: PlacedVehicle, scheme: string, eye: Readonly<Vec3d>): TrafficAircraft {
    const d = v.pos.distanceTo(eye);
    const grow = Math.min(READABLE_MAX, Math.max(1, d / READABLE_FROM));
    return {
      spec: vehicleSpec(v.type),
      scheme,
      gearDown: true,
      pos: [v.pos.x, v.pos.y, v.pos.z],
      forward: v.forward,
      up: v.up,
      scale: VEHICLE_SCALE * grow,
    };
  }

  // ---- Wrecks ----

  private allWrecks(): VehicleWreck[] {
    return [...this.wrecks, ...this.pending.values()];
  }

  private readonly wreckViews = new Map<string, PlacedVehicle>();

  private wreckVehicle(w: VehicleWreck): PlacedVehicle {
    const key = vehicleKey(w.battalion, w.vehicle);
    let v = this.wreckViews.get(key);
    if (!v) {
      v = this.placed(w.battalion, w.vehicle, w.type, w.side, w.point, w.heading);
      v.sited = true;
      this.wreckViews.set(key, v);
    }
    if (v.ground === null) this.settle(v);
    return v;
  }

  /** The wrecks' burning columns at game time t (decision 329's columns): fading over WRECK_BURN. */
  columns(t: GameTime, near: Readonly<Vec3d> | null): FireColumn[] {
    const out: FireColumn[] = [];
    const c = near ? near.clone().normalize() : null;
    for (const w of this.allWrecks()) {
      const age = t - w.time;
      if (age < 0 || age > WRECK_BURN) continue;
      if (c && this.arc(w.point, [c.x, c.y, c.z]) > WRECK_RANGE) continue;
      out.push({
        key: `wreck:${w.battalion}:${w.vehicle}`,
        at: [w.point[0] * this.radius, w.point[1] * this.radius, w.point[2] * this.radius],
        kind: w.type === 'truck' ? 'fuel' : 'target',
        intensity: 0.15 + 0.35 * (1 - age / WRECK_BURN),
      });
    }
    return out;
  }

  // ---- The ground controller's mark (decision 337) ----

  /** The battalion marked, and its company (roster index mod 3) once promoted. */
  private marked: { side: Side; battalion: number; company?: number } | null = null;

  /**
   * The ground controller's mark for a flight of `side` at `at` (decision 337): the
   * nearest enemy fighting battalion (tank, mechanized or air defense) whose anchor lies
   * within MARK_RANGE, held while it has vehicles left. Promoted, the mark is the middle
   * of its company nearest the aircraft, of the vehicles still alive; otherwise its
   * anchor. Null when none is near. `fresh` is true the first time a battalion is marked.
   */
  controllerMark(
    side: Side,
    at: Readonly<Vec3d>,
  ): { point: Dir; label: string; battalion: number; fresh: boolean } | null {
    const here = at.clone().normalize();
    const c: Dir = [here.x, here.y, here.z];
    const enemy = side === 'alliance' ? 'pact' : 'alliance';
    const candidate = (b: BattalionPicture) =>
      b.side === enemy &&
      b.strength > 0 &&
      MARK_KINDS.has(b.kind) &&
      this.arc(b.point, c) <= MARK_RANGE &&
      this.markPoint(b, here) !== null;
    let fresh = false;
    let b =
      this.marked?.side === side
        ? this.battalions.find((x) => x.id === this.marked!.battalion)
        : undefined;
    if (!b || !candidate(b)) {
      b = undefined;
      let best = Infinity;
      for (const x of this.battalions) {
        if (!candidate(x)) continue;
        const d = this.arc(x.point, c);
        if (d < best) {
          best = d;
          b = x;
        }
      }
      this.marked = b ? { side, battalion: b.id } : null;
      fresh = !!b;
    }
    if (!b) return null;
    return {
      point: this.markPoint(b, here)!,
      label: MARK_LABELS[b.kind] ?? 'TROOPS',
      battalion: b.id,
      fresh,
    };
  }

  /** Where battalion b is marked: its nearest company's alive vehicles' middle, or its anchor; null if none is left. */
  private markPoint(b: BattalionPicture, here: Readonly<Vec3d>): Dir | null {
    const pr = this.promoted.get(b.id);
    if (!pr) return [...b.point] as Dir;
    const alive = pr.vehicles.filter(
      (v) => v.sited && v.type !== 'truck' && !this.damage.destroyed(v.key),
    );
    const pool = alive.length > 0 ? alive : pr.vehicles.filter((v) => v.sited);
    if (pool.length === 0) return null;
    // The company marked holds while it has a vehicle left; else the nearest one's.
    const held = this.marked?.battalion === b.id ? this.marked.company : undefined;
    const ofHeld = pool.filter((v) => v.type !== 'truck' && v.index % 3 === held);
    const nearest =
      ofHeld[0] ?? pool.reduce((a, v) => (v.dir.distanceTo(here) < a.dir.distanceTo(here) ? v : a));
    if (this.marked?.battalion === b.id && nearest.type !== 'truck')
      this.marked.company = nearest.index % 3;
    const company = pool.filter((v) => v.type !== 'truck' && v.index % 3 === nearest.index % 3);
    const group = company.length > 0 && nearest.type !== 'truck' ? company : [nearest];
    const m = new Vec3d();
    for (const v of group) m.add(v.dir);
    m.normalize();
    return [m.x, m.y, m.z];
  }

  // ---- Targets and hits ----

  /** The alive promoted vehicles within TARGET_RANGE of `at`, as the rack's ground targets. */
  targets(at: Readonly<Vec3d>): GroundTarget[] {
    const out: GroundTarget[] = [];
    for (const pr of this.promoted.values())
      for (const v of pr.vehicles) {
        if (v.ground === null || !v.sited || this.damage.destroyed(v.key)) continue;
        const pos = v.pos.clone().addScaled(v.dir, VEHICLE_CENTER);
        if (pos.distanceTo(at) > TARGET_RANGE) continue;
        out.push({ id: v.key, pos, kind: VEHICLE_TARGETS[v.type] });
      }
    return out;
  }

  /**
   * A hit on a promoted vehicle (decision 334): its damage adds up, and at 1 it is
   * destroyed: it cooks off, turns into a wreck, and goes to the worker. Returns the
   * destroyed vehicle's type, or null.
   */
  hit(h: Readonly<Hit>, by: number | null): VehicleType | null {
    const id = parseVehicleKey(h.target);
    if (!id) return null;
    const pr = this.promoted.get(id.battalion);
    const v = pr?.vehicles.find((x) => x.index === id.index);
    if (!pr || !v || !this.damage.hit(v.key, h.amount)) return null;
    pr.vehicles = pr.vehicles.filter((x) => x !== v);
    const point: Dir = [v.dir.x, v.dir.y, v.dir.z];
    const wreck: VehicleWreck = {
      battalion: v.battalion,
      vehicle: v.index,
      type: v.type,
      side: v.side,
      point,
      heading: v.heading,
      time: this.time,
    };
    this.pending.set(v.key, wreck);
    this.wreckViews.set(v.key, { ...v, dir: v.dir.clone(), pos: v.pos.clone() });
    this.globe.effects.explode(
      v.pos.clone().addScaled(v.dir, VEHICLE_CENTER),
      COOK_OFF[v.type],
      'fuel',
    );
    this.post({
      kind: 'vehicle-destroyed',
      battalion: v.battalion,
      vehicle: v.index,
      point,
      heading: v.heading,
      by,
    });
    this.onWrecks?.();
    return v.type;
  }

  /** The heading tangent of a vehicle (for tools): its forward direction on the sphere. */
  static tangent(v: Readonly<PlacedVehicle>): Dir {
    return headingTangent([v.dir.x, v.dir.y, v.dir.z], v.heading);
  }

  dispose(): void {
    this.globe.vehicles.remove(this.layer.group);
    this.layer.dispose();
  }
}

const specs = new Map<VehicleType, ModelSpec>();
function vehicleSpec(t: VehicleType): ModelSpec {
  let s = specs.get(t);
  if (!s) {
    s = modelSpec(VEHICLE_MODELS[t]);
    specs.set(t, s);
  }
  return s;
}
