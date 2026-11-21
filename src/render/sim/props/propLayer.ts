/**
 * Landform props in the simulation view (W7; decisions 204, 225): tower karst,
 * sandstone pillars and inselbergs, placed by `worldgen/props.ts`.
 *
 * - **Chunks.** A level-7 data tile (about 12 km) is one chunk, placed once on
 *   the CPU when it comes within reach: one candidate per PROP_STRIDE² samples.
 * - **Sites.** Height and slope from the tile's samples; rock, province and
 *   biome from the global grid; lakes, river water, towns, roads and airfields
 *   keep props off.
 * - **Drawing.** One instanced mesh per kind and level of detail: the full
 *   model within PROP_NEAR, the far one out to PROP_FAR, nothing beyond or
 *   while the eye is higher than PROP_CEILING. Each prop sinks a little into
 *   the ground, so it stands on slopes. Flat-shaded under the planet's light,
 *   with aerial perspective, anchored at the eye (rule 4).
 */
import {
  BufferAttribute,
  FrontSide,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute,
  cos,
  cross,
  Fn,
  mix,
  modelWorldMatrix,
  normalize,
  positionWorld,
  sin,
  vec3,
  vec4,
  varyingProperty,
} from 'three/tsl';
import { placeCameraRelative } from '../../common/cameraRelative';
import { cubeFaceUvToDirection, directionToCubeFace } from '../../../core/coords';
import type { CubeFaceUv } from '../../../core/coords';
import {
  tileForDirection,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import type { TileData } from '../../../worldgen/gpu/tileSynth';
import { MAX_BAKED_LEVEL, NO_LAKE } from '../../../worldgen/gpu/tileSynth';
import { Rock, rockOf } from '../../../worldgen/lithology';
import { PROP_KINDS, PROP_SIZE, PROP_STRIDE, propInCell, propSeed } from '../../../worldgen/props';
import type { PropKind, PropSite } from '../../../worldgen/props';
import type { WorldSeed } from '../../../core/rng';
import { buildModel } from '../../common/models/builder';
import { MODEL_SPECS } from '../../common/models/library';
import type { InfraScene } from '../infra/infraScene';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { TerrainRenderer } from '../terrain/terrainRenderer';

type V3 = Node<'vec3'>;

/** Full models within this (m), far ones to PROP_FAR, none beyond. */
export const PROP_NEAR = 2500;
export const PROP_FAR = 8000;
/** No props while the eye is higher than this above the ground (m). */
export const PROP_CEILING = 9000;
/** Floats per item: base (3), displacement per exaggeration (3), up (3), scale, yaw, shade. */
const FLOATS = 12;

/** The global maps placement reads (the eroded grid, n per face). */
export interface PropWorldMaps {
  n: number;
  province: Uint8Array;
  lithology: Uint8Array;
  biome: Uint8Array;
  /** Karst-bay and pillar-forest wonders, as unit directions (decision 225). */
  karstWonders: readonly Vec3d[];
  pillarWonders: readonly Vec3d[];
}

/**
 * A tile's props as obstacles (decision 225): per prop cell the index of its prop in
 * `items`, or −1; per prop its axis (unit direction), foot and top heights (m) and its
 * collision radius (m): a cylinder of the footprint up to the top.
 */
export interface PropObstacles {
  cells: Int32Array;
  items: Float64Array;
}
/** Floats per obstacle. */
const OBSTACLE_FLOATS = 6;
/** The collision radius as a share of a kind's widest ring, at scale 1 (m). */
export const PROP_COLLISION_RADIUS: Readonly<Record<PropKind, number>> = {
  'prop-karst-tower': 21,
  'prop-pillar': 16,
  'prop-inselberg': 105,
};

interface Chunk {
  origin: Vec3d;
  lists: Map<string, Float32Array>;
  obstacles: PropObstacles;
  lastUsed: number;
}

/** What a tile placer returns: instance lists by kind (FLOATS per item) and obstacles. */
export interface PlacedTile {
  origin: Vec3d;
  lists: Map<string, Float32Array>;
  obstacles: PropObstacles;
}

/**
 * What an instanced tile layer draws (decision 299): the landform props by default, and
 * the rock dressing with its own kinds, ranges, cell stride and placer.
 */
export interface TileLayerOptions {
  /** Model ids; each also has a far model `${kind}-lod`. */
  kinds: readonly string[];
  /** Full models within `near` (m), far ones to `far`, none while the eye is above `ceiling`. */
  near: number;
  far: number;
  ceiling: number;
  /** Level-7 samples per cell (the obstacles' lattice). */
  stride: number;
  /** The layer's hash seed for a world. */
  seedOf: (worldSeed: WorldSeed) => number;
  /**
   * How far shading normals lean toward the instance's up, 0..1 (default 0): rock dressing
   * shades like the ground it sits on (decision 299; see the report's known issues).
   */
  normalToUp?: number;
  place: (
    data: TileData,
    maps: PropWorldMaps,
    seed: number,
    radius: number,
    clear?: (d: Readonly<Vec3d>, extra?: number) => boolean,
  ) => PlacedTile;
}

/** The landform props (decision 225). */
export const PROP_LAYER: TileLayerOptions = {
  kinds: PROP_KINDS,
  near: PROP_NEAR,
  far: PROP_FAR,
  ceiling: PROP_CEILING,
  stride: PROP_STRIDE,
  seedOf: propSeed,
  place: placePropTile,
};

/** Places the props of a level-7 data tile. Pure: no GPU. */
export function placePropTile(
  data: TileData,
  maps: PropWorldMaps,
  seed: number,
  radius: number,
  /** True in a clearing (InfraScene.isClear): no prop there. */
  clear?: (d: Readonly<Vec3d>, extra?: number) => boolean,
): PlacedTile {
  const t = data.key;
  const size = TILE_TEXELS * (1 << t.level);
  const sampleM = ((Math.PI / 2) * radius) / size;
  const n = maps.n;
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const cellOf = (d: Readonly<Vec3d>) => {
    directionToCubeFace(d, uv);
    const i = Math.min(n - 1, Math.max(0, Math.floor(uv.u * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(uv.v * n)));
    return (uv.face * n + j) * n + i;
  };
  const idx = (sx: number, sy: number) =>
    (Math.min(TILE_TEXELS + TILE_BORDER - 1, Math.max(-TILE_BORDER, sy)) + TILE_BORDER) *
      TILE_STRIDE +
    Math.min(TILE_TEXELS + TILE_BORDER - 1, Math.max(-TILE_BORDER, sx)) +
    TILE_BORDER;
  const dirAt = (sx: number, sy: number, out: Vec3d) =>
    cubeFaceUvToDirection(
      t.face,
      (t.x * TILE_TEXELS + sx) / size,
      (t.y * TILE_TEXELS + sy) / size,
      out,
    );
  const origin = dirAt(TILE_TEXELS / 2, TILE_TEXELS / 2, new Vec3d()).scale(radius);
  const lists = new Map<PropKind, number[]>();
  const cellIndex = new Int32Array((TILE_TEXELS / PROP_STRIDE) ** 2).fill(-1);
  const obstacles: number[] = [];
  const d = new Vec3d();
  const nb = new Vec3d();
  const cells = TILE_TEXELS / PROP_STRIDE;
  const gx0 = (t.x * TILE_TEXELS) / PROP_STRIDE;
  const gy0 = (t.y * TILE_TEXELS) / PROP_STRIDE;
  const minDist = (p: Readonly<Vec3d>, list: readonly Vec3d[]) => {
    let best = Infinity;
    for (const w of list) best = Math.min(best, w.distanceTo(p) * radius);
    return best;
  };
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const sx = cx * PROP_STRIDE + PROP_STRIDE / 2;
      const sy = cy * PROP_STRIDE + PROP_STRIDE / 2;
      const o = idx(sx, sy);
      const h = data.height[o]!;
      const lake = data.lake[o]!;
      const mat = data.material[o]!;
      dirAt(sx, sy, d);
      const c = cellOf(d);
      const dx = (data.height[idx(sx + 1, sy)]! - data.height[idx(sx - 1, sy)]!) / (2 * sampleM);
      const dy = (data.height[idx(sx, sy + 1)]! - data.height[idx(sx, sy - 1)]!) / (2 * sampleM);
      // Limestone on land within about a global cell, for drowned towers.
      let karstNear = false;
      if (h < 0) {
        for (let k = 0; k < 8 && !karstNear; k++) {
          const a = (k / 8) * 2 * Math.PI;
          nb.copy(d);
          const { east, north } = frame(d);
          nb.addScaled(east, (1500 * Math.cos(a)) / radius).addScaled(
            north,
            (1500 * Math.sin(a)) / radius,
          );
          const cc = cellOf(nb.normalize());
          karstNear = rockOf(maps.lithology[cc]!) === Rock.Limestone;
        }
      }
      const site: PropSite = {
        height: h,
        slope: Math.hypot(dx, dy),
        lithology: maps.lithology[c]!,
        province: maps.province[c]!,
        biome: maps.biome[c]!,
        karstNear,
        karstWonder: maps.karstWonders.length ? minDist(d, maps.karstWonders) : Infinity,
        pillarWonder: maps.pillarWonders.length ? minDist(d, maps.pillarWonders) : Infinity,
        // Lakes and river water (the material's river coverage, bits 8–15).
        blocked: (lake > NO_LAKE / 2 && h < lake) || ((mat >>> 8) & 0xff) > 0,
      };
      const item = propInCell(seed, t.face, gx0 + cx, gy0 + cy, site);
      if (!item) continue;
      const px = cx * PROP_STRIDE + item.fx * PROP_STRIDE;
      const py = cy * PROP_STRIDE + item.fy * PROP_STRIDE;
      dirAt(px, py, d);
      const half = (PROP_SIZE[item.kind].height * item.scale) / 4;
      // In a clearing (towns, roads, airfields, widened by the prop's footprint): none.
      if (clear && clear(d, half)) continue;
      // Sunk to the lowest ground under its footprint, so it stands on a slope.
      const r = Math.max(1, Math.round(half / sampleM));
      let low = Infinity;
      for (const [ox, oy] of [
        [0, 0],
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ])
        low = Math.min(low, data.height[idx(Math.round(px) + ox!, Math.round(py) + oy!)]!);
      const ground = low - 2 * item.scale;
      let l = lists.get(item.kind);
      if (!l) lists.set(item.kind, (l = []));
      const base = d.clone().scale(radius).sub(origin);
      l.push(base.x, base.y, base.z, d.x * ground, d.y * ground, d.z * ground, d.x, d.y, d.z);
      l.push(item.scale, item.yaw, 0.88 + 0.24 * item.fy);
      cellIndex[cy * cells + cx] = obstacles.length / OBSTACLE_FLOATS;
      obstacles.push(
        d.x,
        d.y,
        d.z,
        ground,
        ground + PROP_SIZE[item.kind].height * item.scale,
        PROP_COLLISION_RADIUS[item.kind] * item.scale,
      );
    }
  }
  const out = new Map<string, Float32Array>();
  for (const [k, l] of lists) out.set(k, Float32Array.from(l));
  return {
    origin,
    lists: out,
    obstacles: { cells: cellIndex, items: Float64Array.from(obstacles) },
  };
}

/**
 * The top (m) of the prop whose column holds unit direction `dir` in a tile's
 * obstacles, or null; (cx, cy) is the direction's prop cell in the tile.
 */
function obstacleTop(
  o: PropObstacles,
  dir: Readonly<Vec3d>,
  cx: number,
  cy: number,
  radius: number,
  stride: number,
): number | null {
  const cells = TILE_TEXELS / stride;
  let top: number | null = null;
  for (let j = cy - 1; j <= cy + 1; j++) {
    for (let i = cx - 1; i <= cx + 1; i++) {
      if (i < 0 || j < 0 || i >= cells || j >= cells) continue;
      const k = o.cells[j * cells + i]!;
      if (k < 0) continue;
      const b = k * OBSTACLE_FLOATS;
      const dx = dir.x - o.items[b]!;
      const dy = dir.y - o.items[b + 1]!;
      const dz = dir.z - o.items[b + 2]!;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) * radius > o.items[b + 5]!) continue;
      top = Math.max(top ?? -Infinity, o.items[b + 4]!);
    }
  }
  return top;
}

function frame(p: Readonly<Vec3d>): { east: Vec3d; north: Vec3d } {
  const east = new Vec3d(0, 1, 0).cross(p);
  if (east.length() < 1e-9) east.set(1, 0, 0);
  east.normalize();
  return { east, north: p.clone().cross(east) };
}

/** The far model of a kind. */
const lodOf = (k: string) => `${k}-lod`;

export class PropLayer {
  readonly group = new Group();
  /** Props on (decision 225). */
  enabled = true;
  /** Milliseconds per frame spent placing tiles (at least one per frame). */
  buildBudgetMs = 4;
  readonly stats = { chunks: 0, instances: 0, triangles: 0, draws: 0, pending: 0 };

  private readonly chunks = new Map<string, Chunk>();
  private readonly meshes = new Map<string, Mesh>();
  private readonly material: MeshBasicNodeMaterial;
  private maps: PropWorldMaps | null = null;
  private clear: ((d: Readonly<Vec3d>, extra?: number) => boolean) | undefined;
  private lastWorld: unknown = null;
  private seed = 0;
  private frame = 0;
  private dirty = true;
  private readonly anchor = new Vec3d();
  private filledAt: Vec3d | null = null;

  /** Ranges (m): full models within `near`, far ones to `far` (a quality tier may change them). */
  near: number;
  far: number;

  constructor(
    private readonly terrain: TerrainRenderer,
    lighting: PlanetLighting,
    private readonly layer: TileLayerOptions = PROP_LAYER,
  ) {
    this.material = this.buildMaterial(lighting);
    this.near = layer.near;
    this.far = layer.far;
  }

  /** Places every chunk again (after a change to what the placer reads, e.g. a density). */
  invalidate(): void {
    this.reset();
  }

  /** The global maps of the current world (null: no props). */
  setMaps(maps: PropWorldMaps | null): void {
    this.maps = maps;
    this.reset();
  }

  setInfrastructure(scene: InfraScene | null): void {
    this.clear = scene ? (d, extra = 0) => scene.isClear(d, false, extra) : undefined;
    this.reset();
  }

  private buildMaterial(lighting: PlanetLighting): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ side: FrontSide });
    const base = attribute('iBase', 'vec3');
    const disp = attribute('iDisp', 'vec3');
    const up = normalize(attribute('iUp', 'vec3'));
    const params = attribute('iParams', 'vec3'); // scale, yaw, shade
    const ex = this.terrain.exaggerationUniform;
    const t0 = normalize(cross(up, vec3(0.0001, 1, 0.0002)));
    const t1 = cross(up, t0);
    const ca = cos(params.y);
    const sa = sin(params.y);
    const ax = t0.mul(ca).add(t1.mul(sa));
    const az = t0.mul(sa).sub(t1.mul(ca));
    const local = attribute('position', 'vec3');
    const foot = base.add(disp.mul(ex));
    const apInscatter = varyingProperty('vec3', 'vPropInscatter');
    const apTransmittance = varyingProperty('vec3', 'vPropTransmittance');
    m.positionNode = Fn(() => {
      const p = foot.add(ax.mul(local.x).add(up.mul(local.y)).add(az.mul(local.z)).mul(params.x));
      const ap = lighting.atmosphere.aerialPerspective(
        modelWorldMatrix.mul(vec4(p, 1)).xyz as V3,
        3,
      );
      apInscatter.assign(ap.inscatter);
      apTransmittance.assign(ap.transmittance);
      return p;
    })();
    const n0 = attribute('normal', 'vec3');
    const modelNormal = normalize(ax.mul(n0.x).add(up.mul(n0.y)).add(az.mul(n0.z)));
    const normal = normalize(mix(modelNormal, up, this.layer.normalToUp ?? 0)) as V3;
    const albedo = attribute('color', 'vec3').mul(params.z) as V3;
    m.colorNode = lighting.applyAerial(
      lighting.shadeDiffuse(albedo, normal, positionWorld as V3),
      apInscatter as V3,
      apTransmittance as V3,
    );
    return m;
  }

  private reset(): void {
    this.chunks.clear();
    this.dirty = true;
    for (const m of this.meshes.values()) m.visible = false;
  }

  update(eye: Readonly<Vec3d>, heightAboveGround: number): void {
    this.frame++;
    const world = this.terrain.currentWorld;
    const opts = this.terrain.meshOptions();
    if (world !== this.lastWorld) {
      this.reset();
      this.lastWorld = world;
      this.seed = world ? this.layer.seedOf(world.seed) : 0;
    }
    const show =
      this.enabled &&
      world !== null &&
      opts !== null &&
      opts.mode === 'biome' &&
      this.maps !== null &&
      heightAboveGround < this.layer.ceiling;
    this.group.visible = show;
    if (!show) return;
    const R = opts.radius;
    // The level-7 tiles within reach of the eye's ground point.
    const radial = eye.clone().normalize();
    const { east, north } = frame(radial);
    const wanted = new Map<string, TileKey>();
    const step = 3000;
    const n = Math.ceil(this.far / step);
    const d = new Vec3d();
    for (let j = -n; j <= n; j++)
      for (let i = -n; i <= n; i++) {
        if ((i * i + j * j) * step * step > (this.far + step) ** 2) continue;
        d.copy(radial)
          .addScaled(east, (i * step) / R)
          .addScaled(north, (j * step) / R)
          .normalize();
        const k = tileForDirection(d, MAX_BAKED_LEVEL);
        wanted.set(tileKeyString(k), k);
      }
    const t0 = performance.now();
    let pending = 0;
    let placed = 0;
    for (const [s, k] of wanted) {
      const c = this.chunks.get(s);
      if (c) {
        c.lastUsed = this.frame;
        continue;
      }
      const data = this.terrain.dataTile(k);
      if (!data) {
        this.terrain.requestDataTile(k, 2);
        pending++;
        continue;
      }
      // At least one tile per frame, more within the budget.
      if (placed > 0 && performance.now() - t0 > this.buildBudgetMs) {
        pending++;
        continue;
      }
      this.chunks.set(s, {
        ...this.layer.place(data, this.maps!, this.seed, R, this.clear),
        lastUsed: this.frame,
      });
      placed++;
      this.dirty = true;
    }
    for (const [s, c] of this.chunks)
      if (!wanted.has(s) && this.frame - c.lastUsed > 120) this.chunks.delete(s);
    this.stats.pending = pending;
    const moved = !this.filledAt || this.filledAt.distanceTo(eye) > 50;
    if (this.dirty || moved) this.fill(eye);
    let draws = 0;
    for (const mesh of this.meshes.values()) {
      if (!mesh.visible) continue;
      draws++;
      placeCameraRelative(mesh, this.anchor, eye);
    }
    this.stats.chunks = this.chunks.size;
    this.stats.draws = draws;
  }

  private fill(eye: Readonly<Vec3d>): void {
    this.dirty = false;
    this.filledAt = (this.filledAt ?? new Vec3d()).copy(eye);
    this.anchor.copy(eye);
    const ex = this.terrain.exaggerationUniform.value;
    let instances = 0;
    let triangles = 0;
    for (const kind of this.layer.kinds) {
      // [near, far] lists.
      const near: number[] = [];
      const far: number[] = [];
      for (const c of this.chunks.values()) {
        const data = c.lists.get(kind);
        if (!data) continue;
        const ox = c.origin.x - eye.x;
        const oy = c.origin.y - eye.y;
        const oz = c.origin.z - eye.z;
        for (let o = 0; o < data.length; o += FLOATS) {
          const bx = ox + data[o]!;
          const by = oy + data[o + 1]!;
          const bz = oz + data[o + 2]!;
          const px = bx + data[o + 3]! * ex;
          const py = by + data[o + 4]! * ex;
          const pz = bz + data[o + 5]! * ex;
          const dist = Math.sqrt(px * px + py * py + pz * pz);
          if (dist > this.far) continue;
          const list = dist < this.near ? near : far;
          list.push(bx, by, bz);
          for (let k = 3; k < FLOATS; k++) list.push(data[o + k]!);
        }
      }
      for (const [id, list] of [
        [kind, near],
        [lodOf(kind), far],
      ] as const) {
        const count = list.length / FLOATS;
        const mesh = this.meshFor(id, count);
        if (!mesh) continue;
        const g = mesh.geometry as InstancedBufferGeometry;
        const buffer = mesh.userData.buffer as InstancedInterleavedBuffer;
        (buffer.array as Float32Array).set(list);
        g.instanceCount = count;
        buffer.clearUpdateRanges();
        buffer.addUpdateRange(0, list.length);
        buffer.needsUpdate = true;
        mesh.visible = count > 0;
        instances += count;
        triangles += count * (mesh.userData.triangles as number);
      }
    }
    this.stats.instances = instances;
    this.stats.triangles = triangles;
  }

  private meshFor(id: string, capacity: number): Mesh | null {
    let mesh = this.meshes.get(id) ?? null;
    if (capacity === 0) {
      if (mesh) mesh.visible = false;
      return null;
    }
    if (mesh && (mesh.userData.capacity as number) >= capacity) return mesh;
    const cap = Math.max(64, 2 ** Math.ceil(Math.log2(capacity)));
    const model = buildModel(MODEL_SPECS[id]!);
    const color = new Float32Array(model.triangles * 9);
    for (let t = 0; t < model.triangles; t++)
      for (let v = 0; v < 3; v++)
        for (let c = 0; c < 3; c++)
          color[t * 9 + v * 3 + c] = model.color[t * 9 + v * 3 + c]! * model.ao[t * 3 + v]!;
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(model.position.slice(), 3));
    g.setAttribute('normal', new BufferAttribute(model.normal.slice(), 3));
    g.setAttribute('color', new BufferAttribute(color, 3));
    const buffer = new InstancedInterleavedBuffer(new Float32Array(cap * FLOATS), FLOATS);
    g.setAttribute('iBase', new InterleavedBufferAttribute(buffer, 3, 0));
    g.setAttribute('iDisp', new InterleavedBufferAttribute(buffer, 3, 3));
    g.setAttribute('iUp', new InterleavedBufferAttribute(buffer, 3, 6));
    g.setAttribute('iParams', new InterleavedBufferAttribute(buffer, 3, 9));
    g.instanceCount = 0;
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = g;
    } else {
      mesh = new Mesh(g, this.material);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meshes.set(id, mesh);
    }
    mesh.userData.capacity = cap;
    mesh.userData.buffer = buffer;
    mesh.userData.triangles = model.triangles;
    return mesh;
  }

  /**
   * The top (m) of a prop standing over unit direction `dir`, or null (decision 225):
   * for the flight model's ground, the camera's clearance and line of sight. Only
   * tiles already placed near the eye answer, and a prop on a neighbouring tile is
   * missed within its first cell of the edge.
   */
  obstacleAt(dir: Readonly<Vec3d>): number | null {
    if (!this.group.visible && this.chunks.size === 0) return null;
    const k = tileForDirection(dir, MAX_BAKED_LEVEL);
    const c = this.chunks.get(tileKeyString(k));
    if (!c) return null;
    const uv = directionToCubeFace(dir);
    const size = TILE_TEXELS * (1 << MAX_BAKED_LEVEL);
    const stride = this.layer.stride;
    const cx = Math.floor((uv.u * size - k.x * TILE_TEXELS) / stride);
    const cy = Math.floor((uv.v * size - k.y * TILE_TEXELS) / stride);
    const R = this.terrain.meshOptions()?.radius ?? 1e6;
    return obstacleTop(c.obstacles, dir, cx, cy, R, stride);
  }

  dispose(): void {
    for (const m of this.meshes.values()) m.geometry.dispose();
    this.meshes.clear();
    this.chunks.clear();
    this.material.dispose();
  }
}
