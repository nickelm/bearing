/**
 * Settlements in the simulation view from their plans (proposal 0009 Phase 6,
 * decisions 266–269).
 *
 * - **Plans** come from the settlement worker (or in process where there are no Web
 *   Workers), nearest settlement first, one in flight at a time, cached and released
 *   when far.
 * - **Ground.** Each planned town near the camera takes one of the terrain's plan slots
 *   (`CityGround`); its chunks within FIELD_RANGE get feature fields from the worker.
 * - **Meshes** per 1 km chunk by distance: a kit within `kitRange`, boxes within
 *   `boxRange`, and beyond, up to `prismRange`, the chunk's blocks as prisms merged into
 *   one mesh per settlement. One material for all, so a chunk is one draw call.
 * - **Night.** Windows light in the wall shader; streetlights are points along the
 *   streets of near chunks, one instanced mesh per settlement, scaled by the
 *   settlement's lighting level (`setLighting`: lit, dimmed, blacked out), which a game
 *   layer sets.
 * - **Damage** (decision 269): `setDamage` changes one building's state and rebuilds
 *   only its chunk.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  attribute,
  cameraWorldMatrix,
  clamp,
  dot,
  time,
  float,
  floor,
  fract,
  Fn,
  length,
  mix,
  modelWorldMatrix,
  normalize,
  positionWorld,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { placeCameraRelative } from '../../common/cameraRelative';
import { sphereOutsideView } from '../../common/terrain/quadtree';
import type { CullView } from '../../common/terrain/quadtree';
import { dataTileFor, surfaceSampler } from '../../common/terrain/tileMesh';
import { directionToCubeFace } from '../../../core/coords';
import type { CubeFaceUv } from '../../../core/coords';
import { MAX_TILE_LEVEL, TILE_TEXELS, tileForDirection, tileKeyString } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import type { WorldSeed } from '../../../core/rng';
import { canopySeed } from '../../../worldgen/canopy';
import { globalMapSampler } from '../../../worldgen/edits/airfields';
import type { RiverSegments } from '../../../worldgen/riverIndex';
import { SettlementFrame } from '../../../worldgen/settlements/frame';
import { settlementInput, settlementWorld } from '../../../worldgen/settlements/fromGraph';
import type { SettlementWorld } from '../../../worldgen/settlements/fromGraph';
import { BUILDING_FIELDS, CHUNK } from '../../../worldgen/settlements/pack';
import type { PackedPlan } from '../../../worldgen/settlements/pack';
import { StreetKind } from '../../../worldgen/settlements/types';
import type { StrategicGraph } from '../../../worldgen/strategic/graph';
import type { FromCityWorker, ToCityWorker } from '../../../workers/cityProtocol';
import { CityCore } from '../../../workers/cityCore';
import { LIGHT_KINDS, lightPointMaterial, lightQuad } from '../infra/lightPoints';
import { nightFactor } from '../infra/roadShading';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { TerrainRenderer } from '../terrain/terrainRenderer';
import { CHUNKS_PER_PLAN, FIELD_SLOTS, PLAN_SLOTS } from './cityGround';
import {
  Damage,
  GeometryWriter,
  Lod,
  patchRange,
  writeBuilding,
  writeLandmark,
  writePrisms,
} from './cityMesh';
import type { GroundAt } from './cityMesh';

type V3 = Node<'vec3'>;

/** Field chunks are built within this distance (m) of the camera. */
const FIELD_RANGE = 4500;
/** Plans are kept this far beyond the prism range (m), then released. */
const RELEASE = 6000;

/** What the layer needs from the world. */
export interface CityWorld {
  graph: StrategicGraph;
  radius: number;
  seed: WorldSeed;
  height: Float32Array;
  lake: Float32Array;
  n: number;
  /** Biome of settlement i (from the coarse world's map at its cell). */
  biomeOf: (i: number) => number;
  rivers: RiverSegments | null;
  /** Light record index of settlement i in the terrain's light tables, or −1. */
  recordOf: (i: number) => number;
}

interface Chunk {
  ci: number;
  cj: number;
  lod: Lod;
  mesh: Mesh | null;
  center: Vec3d;
  origin: Vec3d;
  dirty: boolean;
  field: number;
  fieldRequested: boolean;
  /** Buildings and blocks whose centers lie in the chunk. */
  buildings: number[];
  blocks: number[];
  landmarks: number[];
}

interface PlanState {
  index: number;
  plan: PackedPlan | null;
  frame: SettlementFrame;
  chunks: Map<number, Chunk>;
  i0: number;
  j0: number;
  across: number;
  down: number;
  slot: number;
  prisms: Mesh | null;
  prismKey: string;
  lights: Mesh | null;
  lightKey: string;
  plumes: Mesh | null;
  plumesTried: boolean;
  coverage: Float32Array | null;
  damage: Uint8Array | null;
  lastUsed: number;
}

/** A planner over the worker, or in process. */
class Planner {
  private worker: Worker | null = null;
  private readonly core: CityCore | null = null;
  private readonly queue: ToCityWorker[] = [];
  inFlight = 0;

  constructor(private readonly onReply: (r: FromCityWorker) => void) {
    if (typeof Worker !== 'undefined' && typeof window !== 'undefined') {
      try {
        this.worker = new Worker(new URL('../../../workers/city.worker.ts', import.meta.url), {
          type: 'module',
        });
        this.worker.onmessage = (e: MessageEvent<FromCityWorker>) => {
          this.inFlight--;
          this.onReply(e.data);
        };
      } catch {
        this.worker = null;
      }
    }
    if (!this.worker) this.core = new CityCore();
  }

  get async(): boolean {
    return this.worker !== null;
  }

  send(msg: ToCityWorker): void {
    if (msg.type !== 'init') this.inFlight++;
    if (this.worker) this.worker.postMessage(msg);
    else this.queue.push(msg);
  }

  /** In process: handles queued messages within `budgetMs`. */
  poll(budgetMs: number): void {
    if (!this.core) return;
    const t0 = performance.now();
    while (
      this.queue.length &&
      (performance.now() - t0 < budgetMs || this.queue[0]!.type === 'init')
    ) {
      const msg = this.queue.shift()!;
      const { reply } = this.core.handle(msg);
      if (msg.type !== 'init') this.inFlight--;
      if (reply) this.onReply(reply);
    }
  }

  dispose(): void {
    this.worker?.terminate();
  }
}

/** Light record index of each settlement in an InfraScene's light tables (sites are in record order). */
export function recordsOf(sites: readonly { key: string }[]): (i: number) => number {
  const map = new Map<number, number>();
  sites.forEach((s, k) => {
    if (s.key.startsWith('town-')) map.set(Number(s.key.slice(5)), k);
  });
  return (i) => map.get(i) ?? -1;
}

export class CityLayer {
  readonly group = new Group();
  enabled = false;
  /** Detail ranges (m from the camera to a chunk's nearest point). */
  kitRange = 600;
  boxRange = 2000;
  prismRange = 12_000;
  maxAltitude = 15_000;
  buildBudgetMs = 6;
  /** Spacing (m) of streetlights. */
  lightSpacing = 40;
  readonly stats = { plans: 0, chunks: 0, triangles: 0, draws: 0, pending: 0, planMs: 0 };
  private world: CityWorld | null = null;
  private sw: SettlementWorld | null = null;
  private planner: Planner | null = null;
  private readonly plans = new Map<number, PlanState>();
  private readonly levels = new Map<number, number>();
  private readonly fieldOwners: ({ plan: number; chunk: number } | null)[] = new Array(
    FIELD_SLOTS,
  ).fill(null);
  private fieldClock: number[] = new Array(FIELD_SLOTS).fill(0);
  private readonly planSlots: (number | null)[] = new Array(PLAN_SLOTS).fill(null);
  private readonly material: MeshBasicNodeMaterial;
  private readonly lightMaterial: MeshBasicNodeMaterial;
  private readonly quad = lightQuad();
  private frame = 0;
  private nextId = 1;
  private points: Float64Array = new Float64Array(0);
  private reach: Float32Array = new Float32Array(0);
  private lastGround: unknown = null;
  /** Settlements to plan when the worker is idle (the strategic map's cities). */
  private prefetchQueue: number[] = [];
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  /** Called with each plan as it arrives (the strategic map draws cities from blocks). */
  onPlan: ((i: number, plan: PackedPlan) => void) | null = null;
  private readonly delivered = new Set<number>();
  /** Night light strength of streetlights. */
  readonly lightBrightness = uniform(2);
  /** Window detail fades out by this distance (m). */
  readonly windowRange = uniform(1400);

  constructor(
    private readonly terrain: TerrainRenderer,
    private readonly lighting: PlanetLighting,
  ) {
    this.material = this.buildMaterial();
    this.lightMaterial = lightPointMaterial(
      lighting,
      terrain.exaggerationUniform,
      uniform(this.boxRange + 500),
      this.lightBrightness,
    );
  }

  setWorld(world: CityWorld | null): void {
    this.clear();
    this.prefetchQueue = [];
    this.delivered.clear();
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = null;
    this.planner?.dispose();
    this.world = world;
    this.planner = null;
    this.sw = null;
    if (!world) return;
    const height = globalMapSampler(world.height, world.n);
    const lake = globalMapSampler(world.lake, world.n);
    this.sw = settlementWorld(
      world.graph,
      world.radius,
      { height: (d) => height(d), water: (d) => height(d) <= 0 || lake(d) > 0.5 },
      world.biomeOf,
      world.rivers,
    );
    const s = world.graph.settlements;
    this.points = Float64Array.from(s.points);
    this.reach = new Float32Array(s.cells.length);
    for (let i = 0; i < s.cells.length; i++)
      this.reach[i] = Math.min(11_000, 15 * Math.sqrt(s.population[i]!)) + 2000;
    this.planner = new Planner((r) => this.onReply(r));
    this.planner.send({
      type: 'init',
      height: world.height.slice(),
      lake: world.lake.slice(),
      n: world.n,
      radius: world.radius,
      seed: world.seed,
      fieldSeed: canopySeed(world.seed),
    });
  }

  get hasWorld(): boolean {
    return this.world !== null;
  }

  /**
   * Plans settlements `indices` in the background, when no settlement near the camera
   * waits for one (decision 270: the strategic map draws cities from their blocks).
   */
  prefetch(indices: number[]): void {
    this.prefetchQueue.push(...indices.filter((i) => !this.delivered.has(i)));
    if (this.planner?.async && !this.pumpTimer)
      this.pumpTimer = setInterval(() => this.pump(), 400);
  }

  /** Sends the next prefetch when the planner is idle. */
  pump(): void {
    if (!this.planner || !this.sw || this.planner.inFlight > 0) return;
    while (this.prefetchQueue.length) {
      const i = this.prefetchQueue.shift()!;
      if (this.plans.has(i) || this.delivered.has(i)) continue;
      const input = settlementInput(this.sw, i);
      const { ground: _g, ...rest } = input;
      this.plans.set(i, this.emptyState(i, input.center));
      this.planner.send({ type: 'plan', id: this.nextId++, input: rest });
      return;
    }
  }

  private emptyState(i: number, center: [number, number, number]): PlanState {
    return {
      index: i,
      plan: null,
      frame: new SettlementFrame(center, this.world!.radius),
      chunks: new Map(),
      i0: 0,
      j0: 0,
      across: 1,
      down: 1,
      slot: -1,
      prisms: null,
      prismKey: '',
      lights: null,
      lightKey: '',
      plumes: null,
      plumesTried: false,
      coverage: null,
      damage: null,
      lastUsed: this.frame,
    };
  }

  /** Lighting level of settlement `i`: 1 lit, 0.4 dimmed, 0 blacked out (for a game layer). */
  setLighting(i: number, level: number): void {
    this.levels.set(i, Math.max(0, Math.min(1, level)));
    const p = this.plans.get(i);
    if (p) {
      p.lightKey = '';
      for (const c of p.chunks.values()) if (c.mesh) c.mesh.userData.level = this.levels.get(i);
    }
  }

  /** Damage state of building `b` of settlement `i` (Damage.Intact, Damaged, Rubble). */
  setDamage(i: number, b: number, state: number): boolean {
    const p = this.plans.get(i);
    if (!p?.plan) return false;
    p.damage ??= new Uint8Array(p.plan.buildings.length / BUILDING_FIELDS);
    if (b < 0 || b >= p.damage.length) return false;
    p.damage[b] = state;
    const o = b * BUILDING_FIELDS;
    const key = this.chunkKey(
      p,
      Math.floor(p.plan.buildings[o]! / CHUNK),
      Math.floor(p.plan.buildings[o + 1]! / CHUNK),
    );
    const c = p.chunks.get(key);
    if (c && !this.patchDamage(p, c, b, state)) c.dirty = true;
    if (p.plumes) p.plumes.userData.dirty = true;
    else p.plumesTried = false;
    return true;
  }

  /** Rewrites one building of a built chunk in place (decision 269); false to rebuild the chunk. */
  private patchDamage(p: PlanState, c: Chunk, b: number, state: number): boolean {
    const mesh = c.mesh;
    const range = (mesh?.userData.ranges as Map<number, [number, number]> | undefined)?.get(b);
    if (!mesh || !range) return false;
    const w = this.writer(p, c);
    if (!writeBuilding(w, p.plan!, b, mesh.userData.lod as Lod, this.groundAt(p), state))
      return false;
    const geo = mesh.geometry;
    const attr = (name: string) => geo.getAttribute(name) as BufferAttribute;
    const target = {
      position: attr('position').array as Float32Array,
      normal: attr('normal').array as Float32Array,
      color: attr('color').array as Float32Array,
      ground: attr('cityGround').array as Float32Array,
      wall: attr('cityWall').array as Float32Array,
      triangles: 0,
    };
    if (!patchRange(target, range[0], range[1], w.finish())) return false;
    for (const [name, k] of [
      ['position', 3],
      ['normal', 3],
      ['color', 3],
      ['cityGround', 1],
      ['cityWall', 4],
    ] as const) {
      const a = attr(name);
      a.addUpdateRange(range[0] * 3 * k, range[1] * 3 * k);
      a.needsUpdate = true;
    }
    return true;
  }

  /** The packed plan of settlement i, if built (colliders, targets, landmarks). */
  plan(i: number): PackedPlan | null {
    return this.plans.get(i)?.plan ?? null;
  }

  private chunkKey(p: PlanState, ci: number, cj: number): number {
    return (cj - p.j0) * p.across + (ci - p.i0);
  }

  private onReply(r: FromCityWorker): void {
    if (r.type === 'error') return;
    for (const p of this.plans.values()) {
      if (r.type === 'plan' && !p.plan && p.frame && `s${p.index}` === r.plan.key) {
        this.stats.planMs = r.ms;
        this.attachPlan(p, r.plan);
        return;
      }
      if (r.type === 'field' && p.plan?.key === r.key) {
        const c = p.chunks.get(this.chunkKey(p, r.ci, r.cj));
        if (!c) return;
        const ground = this.terrain.cityGround;
        if (!ground || p.slot < 0) return;
        const slot = this.freeFieldSlot();
        ground.writeField(slot, r.data);
        this.fieldOwners[slot] = { plan: p.index, chunk: this.chunkKey(p, r.ci, r.cj) };
        this.fieldClock[slot] = this.frame;
        c.field = slot;
        ground.setChunk(p.slot, this.chunkKey(p, r.ci, r.cj), slot);
        return;
      }
    }
  }

  private freeFieldSlot(): number {
    let best = 0;
    for (let s = 0; s < FIELD_SLOTS; s++) {
      if (!this.fieldOwners[s]) return s;
      if (this.fieldClock[s]! < this.fieldClock[best]!) best = s;
    }
    const owner = this.fieldOwners[best]!;
    const p = this.plans.get(owner.plan);
    const c = p?.chunks.get(owner.chunk);
    if (p && c) {
      c.field = -1;
      c.fieldRequested = false;
      if (p.slot >= 0) this.terrain.cityGround?.setChunk(p.slot, owner.chunk, -1);
    }
    this.fieldOwners[best] = null;
    return best;
  }

  private attachPlan(p: PlanState, plan: PackedPlan): void {
    p.plan = plan;
    if (!this.delivered.has(p.index)) {
      this.delivered.add(p.index);
      this.onPlan?.(p.index, plan);
    }
    const [x0, y0, x1, y1] = plan.bounds;
    p.i0 = Math.floor(x0 / CHUNK);
    p.j0 = Math.floor(y0 / CHUNK);
    p.across = Math.floor(x1 / CHUNK) - p.i0 + 1;
    p.down = Math.floor(y1 / CHUNK) - p.j0 + 1;
    const R = this.world!.radius;
    const chunkOf = (x: number, y: number) => {
      const ci = Math.floor(x / CHUNK);
      const cj = Math.floor(y / CHUNK);
      const key = this.chunkKey(p, ci, cj);
      let c = p.chunks.get(key);
      if (!c) {
        const d = p.frame.toSphere((ci + 0.5) * CHUNK, (cj + 0.5) * CHUNK);
        const center = new Vec3d(d[0] * R, d[1] * R, d[2] * R);
        c = {
          ci,
          cj,
          lod: Lod.None,
          mesh: null,
          center,
          origin: center.clone(),
          dirty: false,
          field: -1,
          fieldRequested: false,
          buildings: [],
          blocks: [],
          landmarks: [],
        };
        p.chunks.set(key, c);
      }
      return c;
    };
    const b = plan.buildings;
    const nb = b.length / BUILDING_FIELDS;
    for (let i = 0; i < nb; i++)
      chunkOf(b[i * BUILDING_FIELDS]!, b[i * BUILDING_FIELDS + 1]!).buildings.push(i);
    const { blockPoints: bp, blockOffsets: bo } = plan;
    const nblocks = bo.length - 1;
    const coverage = new Float32Array(nblocks);
    for (let i = 0; i < nb; i++) {
      const blk = b[i * BUILDING_FIELDS + 12]!;
      if (blk >= 0 && blk < nblocks)
        coverage[blk]! += 4 * b[i * BUILDING_FIELDS + 3]! * b[i * BUILDING_FIELDS + 4]!;
    }
    for (let k = 0; k < nblocks; k++) {
      let cx = 0;
      let cy = 0;
      const n = (bo[k + 1]! - bo[k]!) / 2;
      for (let i = bo[k]!; i < bo[k + 1]!; i += 2) {
        cx += bp[i]!;
        cy += bp[i + 1]!;
      }
      chunkOf(cx / n, cy / n).blocks.push(k);
      coverage[k] = coverage[k]! / Math.max(1, plan.blockInfo[k * 4 + 3]!);
    }
    p.coverage = coverage;
    plan.landmarks.forEach((l, i) => chunkOf(l.x, l.y).landmarks.push(i));
  }

  /** Builds and places the settlements around `eye`. */
  update(eye: Readonly<Vec3d>, heightAboveGround: number, view?: CullView): void {
    this.frame++;
    const world = this.world;
    const opts = this.terrain.meshOptions();
    const ground = this.terrain.cityGround;
    if (ground !== this.lastGround) {
      // A new terrain world: its buffers start empty.
      this.lastGround = ground;
      this.planSlots.fill(null);
      this.fieldOwners.fill(null);
      for (const p of this.plans.values()) {
        p.slot = -1;
        for (const c of p.chunks.values()) {
          c.field = -1;
          c.fieldRequested = false;
        }
      }
    }
    const show =
      this.enabled &&
      world !== null &&
      opts !== null &&
      opts.mode === 'biome' &&
      heightAboveGround < this.maxAltitude;
    this.group.visible = show;
    this.planner?.poll(this.buildBudgetMs);
    if (!show || !this.sw) {
      this.pump();
      return;
    }
    const R = world.radius;
    const nadir = eye.clone().normalize();
    // Settlements in reach, nearest first.
    const near: { i: number; d: number }[] = [];
    const pts = this.points;
    for (let i = 0; i < this.reach.length; i++) {
      const dot = nadir.x * pts[i * 3]! + nadir.y * pts[i * 3 + 1]! + nadir.z * pts[i * 3 + 2]!;
      const d = Math.acos(Math.min(1, dot)) * R;
      if (d < this.prismRange + this.reach[i]!) near.push({ i, d });
    }
    near.sort((a, b) => a.d - b.d);
    for (const { i } of near) {
      let p = this.plans.get(i);
      if (!p) {
        if (this.planner && this.planner.inFlight > 0) continue;
        const input = settlementInput(this.sw, i);
        const { ground: _g, ...rest } = input;
        p = this.emptyState(i, input.center);
        this.plans.set(i, p);
        this.planner?.send({ type: 'plan', id: this.nextId++, input: rest });
      }
      p.lastUsed = this.frame;
    }
    // Release far plans.
    for (const [i, p] of this.plans) {
      const pt = new Vec3d(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
      const d = Math.acos(Math.min(1, pt.dot(nadir))) * R;
      if (d > this.prismRange + this.reach[i]! + RELEASE && p.plan) this.releasePlan(p);
    }
    // Ground slots for the nearest planned settlements.
    const planned = near.filter((x) => this.plans.get(x.i)?.plan).slice(0, PLAN_SLOTS);
    const want = new Set(planned.map((x) => x.i));
    for (let s = 0; s < PLAN_SLOTS; s++) {
      const owner = this.planSlots[s];
      if (owner !== null && owner !== undefined && !want.has(owner)) {
        const p = this.plans.get(owner);
        if (p) this.dropSlot(p);
      }
    }
    if (ground) {
      for (const { i } of planned) {
        const p = this.plans.get(i)!;
        if (p.slot >= 0 || p.across * p.down > CHUNKS_PER_PLAN) continue;
        const free = this.planSlots.indexOf(null);
        if (free < 0) break;
        p.slot = free;
        this.planSlots[free] = i;
        ground.setPlan(free, p.i0, p.j0, p.across);
        ground.setRecord(world.recordOf(i), free);
      }
    }
    // Chunks: detail by distance, fields near the camera, meshes within the budget.
    const t0 = performance.now();
    let pending = 0;
    let triangles = 0;
    let draws = 0;
    let chunks = 0;
    for (const { i } of near) {
      const p = this.plans.get(i);
      if (!p?.plan) {
        pending++;
        continue;
      }
      const prismChunks: Chunk[] = [];
      const lit: Chunk[] = [];
      for (const [key, c] of p.chunks) {
        const d = eye.distanceTo(c.center) - CHUNK * 0.7;
        const lod: Lod =
          d < this.kitRange
            ? Lod.Kit
            : d < this.boxRange
              ? Lod.Box
              : d < this.prismRange
                ? Lod.Prism
                : Lod.None;
        if (
          ground &&
          p.slot >= 0 &&
          d < FIELD_RANGE &&
          c.field < 0 &&
          !c.fieldRequested &&
          this.planner
        ) {
          c.fieldRequested = true;
          this.planner.send({
            type: 'field',
            id: this.nextId++,
            key: p.plan.key,
            ci: c.ci,
            cj: c.cj,
          });
        }
        if (c.field >= 0) this.fieldClock[c.field] = this.frame;
        if (lod === Lod.Prism) prismChunks.push(c);
        if (lod === Lod.Box || lod === Lod.Kit) lit.push(c);
        if (lod !== c.lod || c.dirty) {
          if (lod === Lod.Box || lod === Lod.Kit) {
            if (performance.now() - t0 > this.buildBudgetMs) {
              pending++;
            } else {
              const mesh = this.buildChunk(p, c, lod);
              if (mesh) {
                this.dropMesh(c.mesh);
                c.mesh = mesh;
                c.lod = lod;
                c.dirty = false;
              } else pending++;
            }
          } else {
            this.dropMesh(c.mesh);
            c.mesh = null;
            c.lod = lod;
            c.dirty = false;
          }
        }
        void key;
        if (c.mesh) {
          const seen = !view || !sphereOutsideView(c.center, CHUNK, view);
          placeCameraRelative(c.mesh, c.origin, eye);
          c.mesh.visible = seen;
          if (seen) {
            draws++;
            chunks++;
            triangles += c.mesh.userData.triangles as number;
          }
        }
      }
      // Prisms of the far chunks, merged per settlement.
      const pk = prismChunks
        .map((c) => this.chunkKey(p, c.ci, c.cj))
        .sort((a, b) => a - b)
        .join(',');
      if (pk !== p.prismKey && performance.now() - t0 < this.buildBudgetMs) {
        const mesh = pk ? this.buildPrisms(p, prismChunks) : null;
        if (mesh || !pk) {
          this.dropMesh(p.prisms);
          p.prisms = mesh;
          p.prismKey = pk;
        }
      }
      if (p.prisms) {
        placeCameraRelative(p.prisms, p.prisms.userData.origin as Vec3d, eye);
        p.prisms.visible = true;
        draws++;
        triangles += p.prisms.userData.triangles as number;
      }
      // Streetlights of the near chunks.
      const lk = lit
        .map((c) => this.chunkKey(p, c.ci, c.cj))
        .sort((a, b) => a - b)
        .join(',');
      if (lk !== p.lightKey) {
        this.dropMesh(p.lights);
        p.lights = lk ? this.buildLights(p, lit) : null;
        p.lightKey = lk;
      }
      if (p.lights) {
        placeCameraRelative(p.lights, p.lights.userData.origin as Vec3d, eye);
        p.lights.visible = true;
        draws++;
      }
      // Smoke and steam over stacks and cooling towers (and burning landmarks, decision 269).
      if (
        (!p.plumesTried || p.plumes?.userData.dirty) &&
        performance.now() - t0 < this.buildBudgetMs
      ) {
        const mesh = this.buildPlumes(p);
        if (mesh !== undefined) {
          this.dropMesh(p.plumes);
          p.plumes = mesh;
          p.plumesTried = true;
        }
      }
      if (p.plumes) {
        placeCameraRelative(p.plumes, p.plumes.userData.origin as Vec3d, eye);
        p.plumes.visible = true;
        draws++;
      }
    }
    this.stats.plans = [...this.plans.values()].filter((p) => p.plan).length;
    this.stats.chunks = chunks;
    this.stats.triangles = triangles;
    this.stats.draws = draws;
    this.stats.pending = pending + (this.planner?.inFlight ?? 0);
  }

  private dropSlot(p: PlanState): void {
    if (p.slot < 0) return;
    const ground = this.terrain.cityGround;
    ground?.setRecord(this.world!.recordOf(p.index), -1);
    this.planSlots[p.slot] = null;
    for (let s = 0; s < FIELD_SLOTS; s++) {
      if (this.fieldOwners[s]?.plan === p.index) this.fieldOwners[s] = null;
    }
    for (const c of p.chunks.values()) {
      c.field = -1;
      c.fieldRequested = false;
    }
    p.slot = -1;
  }

  private releasePlan(p: PlanState): void {
    this.dropSlot(p);
    for (const c of p.chunks.values()) this.dropMesh(c.mesh);
    this.dropMesh(p.prisms);
    this.dropMesh(p.lights);
    this.dropMesh(p.plumes);
    this.plans.delete(p.index);
  }

  private dropMesh(m: Mesh | null): void {
    if (!m) return;
    this.group.remove(m);
    m.geometry.dispose();
  }

  /** The drawn ground (m) at local (x, y) of a plan, or null until its tile data is in. */
  private groundAt(p: PlanState): GroundAt {
    const opts = this.terrain.meshOptions()!;
    const samplers = new Map<
      string,
      ((sx: number, sy: number, d: Readonly<Vec3d>) => number) | null
    >();
    const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
    const d = new Vec3d();
    const tmp: [number, number, number] = [0, 0, 0];
    return (x, y) => {
      p.frame.toSphere(x, y, tmp);
      d.set(tmp[0], tmp[1], tmp[2]);
      const t = tileForDirection(d, MAX_TILE_LEVEL);
      const key = tileKeyString(t);
      let s = samplers.get(key);
      if (s === undefined) {
        const data = this.terrain.dataTile(dataTileFor(t));
        if (!data) {
          this.terrain.requestDataTile(dataTileFor(t), 1);
          s = null;
        } else s = surfaceSampler(t, t.level, data, opts);
        samplers.set(key, s);
      }
      if (!s) return null;
      directionToCubeFace(d, uv);
      const size = TILE_TEXELS * (1 << t.level);
      return Math.max(0, s(uv.u * size - t.x * TILE_TEXELS, uv.v * size - t.y * TILE_TEXELS, d));
    };
  }

  private writer(p: PlanState, c: { origin: Vec3d }): GeometryWriter {
    return new GeometryWriter(p.frame, [c.origin.x, c.origin.y, c.origin.z]);
  }

  private buildChunk(p: PlanState, c: Chunk, lod: Lod): Mesh | null {
    const plan = p.plan!;
    const ground = this.groundAt(p);
    const w = this.writer(p, c);
    // Each building's triangle range, so a damage state patches it in place.
    const ranges = new Map<number, [number, number]>();
    for (const b of c.buildings) {
      const start = w.triangles;
      if (!writeBuilding(w, plan, b, lod, ground, p.damage?.[b] ?? Damage.Intact)) return null;
      ranges.set(b, [start, w.triangles - start]);
    }
    for (const l of c.landmarks) if (!writeLandmark(w, plan, l, lod, ground)) return null;
    const mesh = this.toMesh(w, c.origin, p);
    mesh.userData.ranges = ranges;
    mesh.userData.lod = lod;
    return mesh;
  }

  private buildPrisms(p: PlanState, chunks: Chunk[]): Mesh | null {
    const origin = chunks[0]!.origin;
    const ground = this.groundAt(p);
    const w = this.writer(p, { origin });
    const blocks = chunks.flatMap((c) => c.blocks);
    if (!writePrisms(w, p.plan!, blocks, p.coverage!, ground)) return null;
    // Towers and stacks stay in view from afar.
    for (const c of chunks)
      for (const l of c.landmarks) writeLandmark(w, p.plan!, l, Lod.Prism, ground);
    const mesh = this.toMesh(w, origin, p);
    mesh.userData.origin = origin;
    return mesh;
  }

  private toMesh(w: GeometryWriter, origin: Vec3d, p: PlanState): Mesh {
    const g = w.finish();
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(g.position, 3));
    geo.setAttribute('normal', new BufferAttribute(g.normal, 3));
    geo.setAttribute('color', new BufferAttribute(g.color, 3));
    geo.setAttribute('cityGround', new BufferAttribute(g.ground, 1));
    geo.setAttribute('cityWall', new BufferAttribute(g.wall, 4));
    const mesh = new Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    const up = origin.clone().normalize();
    mesh.userData.up = new Vector3(up.x, up.y, up.z);
    mesh.userData.triangles = g.triangles;
    mesh.userData.level = this.levels.get(p.index) ?? 1;
    this.group.add(mesh);
    return mesh;
  }

  private buildLights(p: PlanState, chunks: Chunk[]): Mesh | null {
    const plan = p.plan!;
    const level = this.levels.get(p.index) ?? 1;
    if (level <= 0) return null;
    const origin = chunks[0]!.origin;
    const keys = new Set(chunks.map((c) => this.chunkKey(p, c.ci, c.cj)));
    const ground = this.groundAt(p);
    const { streetPoints: sp, streetOffsets: so, streetKinds: sk } = plan;
    const kind = LIGHT_KINDS.window!;
    const color = [1, 0.72, 0.38].map((v) => v * level * (level < 1 ? 0.6 : 1));
    const R = this.world!.radius;
    const base: number[] = [];
    const up: number[] = [];
    const offset: number[] = [];
    const col: number[] = [];
    const tmp: [number, number, number] = [0, 0, 0];
    for (let s = 0; s < sk.length; s++) {
      if (sk[s]! > StreetKind.Minor) continue;
      let carry = 0;
      for (let i = so[s]!; i + 3 < so[s + 1]!; i += 2) {
        const ax = sp[i]!;
        const ay = sp[i + 1]!;
        const L = Math.hypot(sp[i + 2]! - ax, sp[i + 3]! - ay);
        for (let t = carry; t < L; t += this.lightSpacing) {
          const x = ax + ((sp[i + 2]! - ax) * t) / L;
          const y = ay + ((sp[i + 3]! - ay) * t) / L;
          if (!keys.has(this.chunkKey(p, Math.floor(x / CHUNK), Math.floor(y / CHUNK)))) continue;
          const h = ground(x, y);
          if (h === null) continue;
          p.frame.toSphere(x, y, tmp);
          base.push(tmp[0] * R - origin.x, tmp[1] * R - origin.y, tmp[2] * R - origin.z);
          up.push(tmp[0], tmp[1], tmp[2]);
          offset.push(tmp[0] * 7, tmp[1] * 7, tmp[2] * 7, h);
          col.push(color[0]!, color[1]!, color[2]!, kind.size * 1.3);
        }
        carry = (carry - L) % this.lightSpacing;
        if (carry < 0) carry += this.lightSpacing;
      }
    }
    const n = base.length / 3;
    if (n === 0) return null;
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', this.quad.getAttribute('position'));
    g.setIndex(this.quad.getIndex());
    g.setAttribute('lBase', new InstancedBufferAttribute(Float32Array.from(base), 3));
    g.setAttribute('lUp', new InstancedBufferAttribute(Float32Array.from(up), 3));
    g.setAttribute('lOffset', new InstancedBufferAttribute(Float32Array.from(offset), 4));
    g.setAttribute('lColor', new InstancedBufferAttribute(Float32Array.from(col), 4));
    g.instanceCount = n;
    const mesh = new Mesh(g, this.lightMaterial);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.userData.origin = origin;
    this.group.add(mesh);
    return mesh;
  }

  /** Puffs per plume. */
  static readonly PUFFS = 10;

  /**
   * Plumes (Phase 7, decision 268): PUFFS soft billboards per source rising from its top
   * and drifting downwind, cycling in age; smoke from stacks, steam from cooling towers,
   * dark smoke from damaged landmarks and targets. Undefined while the ground is missing.
   */
  private buildPlumes(p: PlanState): Mesh | null | undefined {
    const plan = p.plan!;
    const sources: { x: number; y: number; top: number; kind: number }[] = [];
    for (const li of plan.plumes) {
      const l = plan.landmarks[li]!;
      sources.push({ x: l.x, y: l.y, top: l.height, kind: l.kind === 8 ? 1 : 0 });
    }
    // Fires: damaged or ruined landmark buildings and targets smoke (decision 269).
    if (p.damage) {
      plan.landmarks.forEach((l) => {
        if (l.building >= 0 && p.damage![l.building])
          sources.push({ x: l.x, y: l.y, top: 6, kind: 2 });
      });
      for (const t of plan.targets) {
        let hit = false;
        const b = plan.buildings;
        for (let i = 0; i < p.damage.length && !hit; i++) {
          if (!p.damage[i]) continue;
          if (Math.hypot(b[i * BUILDING_FIELDS]! - t.x, b[i * BUILDING_FIELDS + 1]! - t.y) < 60)
            hit = true;
        }
        if (hit) sources.push({ x: t.x, y: t.y, top: 8, kind: 2 });
      }
    }
    if (sources.length === 0) return null;
    const ground = this.groundAt(p);
    const R = this.world!.radius;
    const d0 = p.frame.toSphere(sources[0]!.x, sources[0]!.y);
    const origin = new Vec3d(d0[0] * R, d0[1] * R, d0[2] * R);
    const n = sources.length * CityLayer.PUFFS;
    const base = new Float32Array(n * 3);
    const params = new Float32Array(n * 4);
    const tmp: [number, number, number] = [0, 0, 0];
    let k = 0;
    for (const s of sources) {
      const h = ground(s.x, s.y);
      if (h === null) return undefined;
      p.frame.toSphere(s.x, s.y, tmp);
      for (let q = 0; q < CityLayer.PUFFS; q++, k++) {
        base.set([tmp[0] * R - origin.x, tmp[1] * R - origin.y, tmp[2] * R - origin.z], k * 3);
        params.set([h + s.top, q / CityLayer.PUFFS, s.kind, ((k * 0.6180339) % 1) * 6.283], k * 4);
      }
    }
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', this.quad.getAttribute('position'));
    g.setIndex(this.quad.getIndex());
    g.setAttribute('pBase', new InstancedBufferAttribute(base, 3));
    g.setAttribute('pParams', new InstancedBufferAttribute(params, 4));
    g.instanceCount = n;
    const mesh = new Mesh(g, this.plumeMaterial);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    const up = origin.clone().normalize();
    mesh.userData.up = new Vector3(up.x, up.y, up.z);
    mesh.userData.origin = origin;
    this.group.add(mesh);
    return mesh;
  }

  /** The wind (world, m/s) that carries the plumes; the scene sets it from the weather. */
  readonly wind = uniform(new Vector3(0, 0, 0));
  private plumeMaterialCache: MeshBasicNodeMaterial | null = null;

  private get plumeMaterial(): MeshBasicNodeMaterial {
    if (this.plumeMaterialCache) return this.plumeMaterialCache;
    const L = this.lighting;
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const upU = uniform(new Vector3(0, 1, 0)).onObjectUpdate(
      ({ object }) => (object?.userData.up as Vector3 | undefined) ?? new Vector3(0, 1, 0),
    );
    const base = attribute('pBase', 'vec3');
    const prm = attribute('pParams', 'vec4');
    const corner = attribute('position', 'vec3');
    const vCorner = varyingProperty('vec3', 'vPlumeCorner');
    const vAge = varyingProperty('float', 'vPlumeAge');
    const vKind = varyingProperty('float', 'vPlumeKind');
    const vWorld = varyingProperty('vec3', 'vPlumeWorld');
    const ex = this.terrain.exaggerationUniform;
    m.positionNode = Fn(() => {
      // Age cycles over 40 s; a puff rises 60 m and drifts with the wind (at least a breeze).
      const age = fract(time.mul(0.025).add(prm.y));
      const wind = this.wind.add(upU.mul(0)).toVar();
      const breeze = select(length(wind).lessThan(0.5), vec3(2, 0, 0), wind);
      const steam = prm.z.equal(1);
      const rise = select(steam, float(90), float(60));
      const center = base
        .add(upU.mul(prm.x.mul(ex).add(age.mul(rise))))
        .add(breeze.mul(age.mul(40)))
        .add(vec3(sin(prm.w), 0, sin(prm.w.mul(1.7))).mul(age.mul(8)));
      const size = select(steam, float(14), float(8)).mul(age.mul(3).add(1));
      const right = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
      const camUp = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
      vCorner.assign(corner);
      vAge.assign(age);
      vKind.assign(prm.z);
      const p = center
        .add(right.mul(corner.x.mul(size).mul(0.5)))
        .add(camUp.mul(corner.y.mul(size).mul(0.5)));
      vWorld.assign(modelWorldMatrix.mul(vec4(p, 1)).xyz);
      return p;
    })();
    m.colorNode = Fn(() => {
      const r2 = dot(vCorner.xy, vCorner.xy);
      const soft = clamp(float(1).sub(r2), 0, 1).pow(1.5);
      const fade = smoothstep(0, 0.08, vAge).mul(float(1).sub(vAge));
      const color = select(
        vKind.equal(1),
        vec3(0.92, 0.92, 0.94),
        select(vKind.equal(2), vec3(0.12, 0.11, 0.1), vec3(0.55, 0.53, 0.5)),
      );
      const lit = L.shadeDiffuse(color as V3, normalize(upU) as unknown as V3, vWorld as V3);
      const alpha = soft.mul(fade).mul(select(vKind.equal(1), float(0.55), float(0.7)));
      return vec4(lit, alpha);
    })();
    this.plumeMaterialCache = m;
    return m;
  }

  /**
   * One material for all city meshes: the ground height exaggerated as the terrain is,
   * flat facets lit like the buildings, window bands from world position within
   * `windowRange`, and lit windows at night by the settlement's lighting level.
   */
  private buildMaterial(): MeshBasicNodeMaterial {
    const L = this.lighting;
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const ex = this.terrain.exaggerationUniform;
    const upU = uniform(new Vector3(0, 1, 0)).onObjectUpdate(
      ({ object }) => (object?.userData.up as Vector3 | undefined) ?? new Vector3(0, 1, 0),
    );
    const level = uniform(1).onObjectUpdate(
      ({ object }) => (object?.userData.level as number | undefined) ?? 1,
    );
    const apIn = varyingProperty('vec3', 'vCityInscatter');
    const apTr = varyingProperty('vec3', 'vCityTransmittance');
    const groundH = attribute('cityGround', 'float');
    m.positionNode = Fn(() => {
      const p = attribute('position', 'vec3').add(upU.mul(groundH.mul(ex)));
      const ap = L.atmosphere.aerialPerspective(modelWorldMatrix.mul(vec4(p, 1)).xyz as V3, 6);
      apIn.assign(ap.inscatter);
      apTr.assign(ap.transmittance);
      return p;
    })();
    const normal = normalize(attribute('normal', 'vec3')) as V3;
    const wall = attribute('cityWall', 'vec4');
    m.colorNode = Fn(() => {
      const albedo = attribute('color', 'vec3').toVar();
      const dist = length(positionWorld);
      // Window bands: 3 m floors, 3.2 m bays; panes in the middle of each.
      const u = wall.x;
      const v = wall.y;
      const pane = step(0.32, fract(v.div(3)))
        .mul(step(fract(v.div(3)), 0.74))
        .mul(step(0.28, fract(u.div(3.2))))
        .mul(step(fract(u.div(3.2)), 0.72))
        .mul(step(0.8, v))
        .mul(wall.z);
      const near = float(1).sub(smoothstep(this.windowRange.mul(0.7), this.windowRange, dist));
      const glass = vec3(0.09, 0.1, 0.12);
      albedo.assign(mix(albedo, glass, pane.mul(near).mul(0.7)));
      const shaded = L.shadeDiffuse(albedo as unknown as V3, normal, positionWorld as V3);
      // Lit windows at night: about a third of panes, by floor, bay and building.
      const cell = floor(v.div(3))
        .mul(57.3)
        .add(floor(u.div(3.2)).mul(13.7))
        .add(wall.w.mul(311.1));
      const lit = step(fract(sin(cell).mul(43758.5453)), level.mul(0.35));
      const night = nightFactor(upU as unknown as V3, L.sunDirection);
      // Far away a window is a sub-pixel speck: its mean glow instead.
      const glowNear = pane.mul(lit);
      const glowFar = wall.z.mul(0.25).mul(level).mul(step(0.8, v));
      const glow = mix(glowFar, glowNear, near).mul(night);
      const emissive = vec3(1, 0.72, 0.4)
        .mul(glow)
        .mul(select(abs(normal.dot(upU)).lessThan(0.5), 0.9, 0));
      return L.applyAerial(shaded.add(emissive) as V3, apIn as V3, apTr as V3);
    })();
    void clamp;
    return m;
  }

  clear(): void {
    for (const p of [...this.plans.values()]) this.releasePlan(p);
    this.plans.clear();
    this.planSlots.fill(null);
    this.fieldOwners.fill(null);
  }

  dispose(): void {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.clear();
    this.planner?.dispose();
    this.material.dispose();
    this.lightMaterial.dispose();
    this.plumeMaterialCache?.dispose();
  }
}
