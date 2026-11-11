/**
 * Instanced tree clumps near the camera (decision 45).
 *
 * - Trees are placed per level-9 tile (about 3 km across), within `range` of
 *   the camera and below `maxAltitude`. Candidates sit on a jittered 40 m
 *   lattice drawn from `rng(seed, "trees").fork(tileKey)`, and a candidate is
 *   kept where a draw falls below the forest density (decision 44), sampled
 *   from the level-7 tile data.
 * - The ground height is the same function the terrain mesh evaluates at
 *   level 10: bilinear level-7 data plus render-detail noise. Trunks reach a
 *   few meters below the ground to hide the rest.
 * - Per instance: ground point (relative to the tile's origin), up vector,
 *   and (raw height, scale, rotation, kind). The vertex shader applies the
 *   terrain's height exaggeration, builds the tree frame, and shrinks clumps
 *   to nothing over the last `fade` meters. Trees themselves are not
 *   exaggerated.
 * - Shading matches the terrain: planet lighting, aerial perspective per
 *   vertex, broadleaf crowns browning in autumn and bare in winter, snow on
 *   upward-facing crowns.
 * - Meshes are camera-relative (rule 4): a tile's mesh sits at origin − eye.
 */
import {
  BufferAttribute,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute,
  clamp,
  cos,
  cross,
  dot,
  Fn,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { cubeFaceUvToDirection } from '../../core/coords';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import {
  tileForDirection,
  tileKey,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { Vec3d } from '../../core/vec3d';
import { Biome } from '../../worldgen/biomes';
import { MAX_BAKED_LEVEL, NO_LAKE } from '../../worldgen/gpu/tileSynth';
import type { TileData } from '../../worldgen/gpu/tileSynth';
import type { ClimateTexture } from '../climateTexture';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { LandShading } from '../terrain/landShading';
import type { TerrainRenderer } from '../terrain/terrainRenderer';
import { lakeSampler, mapSample, surfaceSampler } from '../terrain/tileMesh';
import type { MeshOptions } from '../terrain/tileMesh';
import { treeClump } from './treeGeometry';
import type { TreeGeometryData, TreeKind } from './treeGeometry';

type V3 = Node<'vec3'>;

/** Level of the tiles trees are placed per. */
export const TREE_TILE_LEVEL = 9;
/** Instance lattice spacing (m). */
export const TREE_SPACING = 40;
/** Level whose mesh surface the trees stand on. */
const GROUND_LEVEL = 10;

/** Instances of one tile, per kind: 10 floats each (base xyz, up xyz, height, scale, angle, kind). */
export interface TreeInstances {
  tile: TileKey;
  origin: Vec3d;
  conifer: Float32Array;
  broadleaf: Float32Array;
}

export const INSTANCE_FLOATS = 10;

/** Bilinear forest density (0..1) at fractional sample coordinates of a data tile. */
function forestAt(data: TileData, fx: number, fy: number): number {
  const lo = -TILE_BORDER;
  const hi = TILE_TEXELS + TILE_BORDER;
  const x = Math.min(hi, Math.max(lo, fx));
  const y = Math.min(hi, Math.max(lo, fy));
  const x0 = Math.min(hi - 1, Math.floor(x));
  const y0 = Math.min(hi - 1, Math.floor(y));
  const tx = x - x0;
  const ty = y - y0;
  const m = data.material;
  const i = (y0 + TILE_BORDER) * TILE_STRIDE + x0 + TILE_BORDER;
  const f = (k: number) => (m[k]! >>> 24) / 255;
  return (
    (f(i) * (1 - tx) + f(i + 1) * tx) * (1 - ty) +
    (f(i + TILE_STRIDE) * (1 - tx) + f(i + TILE_STRIDE + 1) * tx) * ty
  );
}

/** The level-7 data tile that holds `t`'s samples. */
export function treeDataTile(t: TileKey): TileKey {
  const s = t.level - MAX_BAKED_LEVEL;
  return tileKey(t.face, MAX_BAKED_LEVEL, t.x >> s, t.y >> s);
}

/** Places the tree clumps of level-9 tile `t`, deterministically. Pure: no GPU. */
export function placeTrees(
  t: TileKey,
  data: TileData,
  opts: MeshOptions,
  seed: WorldSeed,
  /** Directions where no tree may stand (towns, airfields, roads; decision 65). */
  clear?: (d: Readonly<Vec3d>) => boolean,
): TreeInstances {
  const R = opts.radius;
  const size = TILE_TEXELS * (1 << t.level);
  const sampleM = ((Math.PI / 2) * R) / size;
  const step = TREE_SPACING / sampleM;
  const cells = Math.ceil(TILE_TEXELS / step);
  const ground = surfaceSampler(t, GROUND_LEVEL, data, opts);
  const lake = lakeSampler(t, data);
  const r = rng(seed, 'trees').fork(tileKeyString(t));
  const origin = cubeFaceUvToDirection(
    t.face,
    (t.x * TILE_TEXELS + TILE_TEXELS / 2) / size,
    (t.y * TILE_TEXELS + TILE_TEXELS / 2) / size,
  ).scale(R);
  const out: Record<TreeKind, number[]> = { conifer: [], broadleaf: [] };
  const d = new Vec3d();
  for (let b = 0; b < cells; b++) {
    for (let a = 0; a < cells; a++) {
      // Draw every value for every candidate, so results never depend on rejections.
      const jx = r.nextFloat();
      const jy = r.nextFloat();
      const keep = r.nextFloat();
      const scale = r.range(0.8, 1.2);
      const angle = r.range(0, 2 * Math.PI);
      const mix = r.nextFloat();
      const sx = Math.min(TILE_TEXELS, (a + jx) * step);
      const sy = Math.min(TILE_TEXELS, (b + jy) * step);
      const [fx, fy] = mapSample(t, data.key, sx, sy);
      if (keep >= forestAt(data, fx, fy)) continue;
      cubeFaceUvToDirection(
        t.face,
        (t.x * TILE_TEXELS + sx) / size,
        (t.y * TILE_TEXELS + sy) / size,
        d,
      );
      const h = ground(sx, sy, d);
      const level = lake(sx, sy);
      if (h <= 0 || (level > NO_LAKE / 2 && level > h)) continue;
      if (clear?.(d)) continue;
      // Conifers in taiga and temperate rainforest, a few in temperate forest.
      const biome =
        data.material[
          (Math.round(fy) + TILE_BORDER) * TILE_STRIDE + Math.round(fx) + TILE_BORDER
        ]! & 0xff;
      const conifer =
        biome === Biome.Taiga ||
        biome === Biome.TemperateRainforest ||
        (biome === Biome.TemperateForest && mix < 0.3);
      out[conifer ? 'conifer' : 'broadleaf'].push(
        d.x * R - origin.x,
        d.y * R - origin.y,
        d.z * R - origin.z,
        d.x,
        d.y,
        d.z,
        h,
        scale,
        angle,
        conifer ? 1 : 0,
      );
    }
  }
  return {
    tile: t,
    origin,
    conifer: Float32Array.from(out.conifer),
    broadleaf: Float32Array.from(out.broadleaf),
  };
}

interface TreeTile {
  meshes: Mesh[];
  origin: Vec3d;
  lastUsed: number;
}

export class ForestLayer {
  readonly group = new Group();
  enabled = true;
  /** Trees appear within this distance of the camera (m). */
  readonly range = uniform(5000);
  /** Clumps shrink away over this last stretch of the range (m). */
  readonly fade = uniform(1200);
  /** Above this height over the ground, no trees are built or drawn (m). */
  maxAltitude = 8000;
  /** Milliseconds per frame spent placing trees. */
  buildBudgetMs = 4;
  /** Built tiles, drawn clumps, and wanted tiles still waiting to be built. */
  readonly stats = { tiles: 0, instances: 0, pending: 0 };

  private readonly tiles = new Map<string, TreeTile>();
  private readonly materials: Record<TreeKind, MeshBasicNodeMaterial>;
  private readonly geometries: Record<TreeKind, TreeGeometryData>;
  private frame = 0;
  private readonly scratch = new Vec3d();
  private lastWorld: unknown = null;
  private clearings: ((d: Readonly<Vec3d>) => boolean) | undefined;

  constructor(
    private readonly terrain: TerrainRenderer,
    lighting: PlanetLighting,
    climate: ClimateTexture,
    land: LandShading,
  ) {
    this.geometries = { conifer: treeClump('conifer'), broadleaf: treeClump('broadleaf') };
    const make = () => this.material(lighting, climate, land);
    this.materials = { conifer: make(), broadleaf: make() };
  }

  private material(
    lighting: PlanetLighting,
    climate: ClimateTexture,
    land: LandShading,
  ): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const base = attribute('iBase', 'vec3');
    const up = normalize(attribute('iUp', 'vec3'));
    const params = attribute('iParams', 'vec4'); // height, scale, angle, kind
    const ex = this.terrain.exaggerationUniform;
    // Tree frame: up, and two tangents rotated by the instance angle.
    const t0 = normalize(cross(up, vec3(0.0001, 1, 0.0002)));
    const t1 = cross(up, t0);
    const ca = cos(params.z);
    const sa = sin(params.z);
    const ax = t0.mul(ca).add(t1.mul(sa));
    const az = t1.mul(ca).sub(t0.mul(sa));
    const local = attribute('position', 'vec3');
    const ground = base.add(up.mul(max(params.x, 0).mul(ex)));

    const apInscatter = varyingProperty('vec3', 'vTreeInscatter');
    const apTransmittance = varyingProperty('vec3', 'vTreeTransmittance');
    m.positionNode = Fn(() => {
      // Shrink clumps away toward the edge of the range.
      const groundRel = modelWorldMatrix.mul(vec4(ground, 1)).xyz;
      const dist = groundRel.length();
      const s = params.y.mul(smoothstep(this.range, this.range.sub(this.fade), dist));
      const p = ground.add(ax.mul(local.x).add(up.mul(local.y)).add(az.mul(local.z)).mul(s));
      const ap = lighting.atmosphere.aerialPerspective(
        modelWorldMatrix.mul(vec4(p, 1)).xyz as V3,
        6,
      );
      apInscatter.assign(ap.inscatter);
      apTransmittance.assign(ap.transmittance);
      return p;
    })();

    const n0 = attribute('normal', 'vec3');
    const normal = normalize(ax.mul(n0.x).add(up.mul(n0.y)).add(az.mul(n0.z))) as V3;
    const color = attribute('color', 'vec3');
    // Season (decision 43): broadleaf crowns brown, then go bare; snow settles on crowns.
    const crown = clamp(color.y.sub(color.x).mul(20), 0, 1);
    const sample = climate.sample(up as V3);
    const t = land.surfaceTemperature(sample, params.x, up as V3);
    const broadleaf = params.w.oneMinus();
    const autumn = smoothstep(10, 3, t).mul(crown).mul(broadleaf);
    const bare = smoothstep(2, -2, t).mul(crown).mul(broadleaf);
    let albedo: V3 = mix(color, land.autumnColor, autumn.mul(0.85)) as V3;
    albedo = mix(albedo, vec3(0.06, 0.05, 0.04), bare.mul(0.8)) as V3;
    const snow = smoothstep(0, -5, t)
      .mul(crown)
      .mul(clamp(dot(normal, up).mul(1.5), 0, 1));
    albedo = mix(albedo, land.snowColor, snow.mul(0.8)) as V3;
    m.colorNode = lighting.applyAerial(
      lighting.shadeDiffuse(albedo, normal, positionWorld as V3),
      apInscatter as V3,
      apTransmittance as V3,
    );
    return m;
  }

  /** Sets where trees must not stand, and rebuilds the trees. */
  setClearings(clear: ((d: Readonly<Vec3d>) => boolean) | undefined): void {
    this.clearings = clear;
    this.clear();
  }

  /** Builds, places and evicts tree tiles around the camera. Call once per frame after the terrain. */
  update(eye: Readonly<Vec3d>, heightAboveGround: number): void {
    this.frame++;
    const world = this.terrain.currentWorld;
    const opts = this.terrain.meshOptions();
    if (world !== this.lastWorld) {
      this.clear();
      this.lastWorld = world;
    }
    const show =
      this.enabled &&
      world !== null &&
      opts !== null &&
      opts.mode === 'biome' &&
      heightAboveGround < this.maxAltitude;
    this.group.visible = show;
    if (!show) return;

    // Tiles whose center lies within reach: sample directions over a disk around the camera.
    const R = opts.radius;
    const range = this.range.value;
    const tileSize = ((Math.PI / 2) * R) / (1 << TREE_TILE_LEVEL);
    const reach = range + tileSize;
    const radial = this.scratch.copy(eye).normalize();
    const east = new Vec3d(0, 1, 0).cross(radial);
    if (east.length() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = radial.clone().cross(east);
    const wanted = new Map<string, TileKey>();
    const step = tileSize / 2;
    const n = Math.ceil(reach / step);
    const d = new Vec3d();
    for (let j = -n; j <= n; j++) {
      for (let i = -n; i <= n; i++) {
        if ((i * i + j * j) * step * step > reach * reach) continue;
        d.copy(radial)
          .addScaled(east, (i * step) / R)
          .addScaled(north, (j * step) / R)
          .normalize();
        const k = tileForDirection(d, TREE_TILE_LEVEL);
        wanted.set(tileKeyString(k), k);
      }
    }

    // Build missing tiles (nearest first) within the time budget.
    const t0 = performance.now();
    const missing = [...wanted.entries()].filter(([s]) => !this.tiles.has(s));
    let pending = 0;
    for (const [s, k] of missing) {
      const data = this.terrain.dataTile(treeDataTile(k));
      // Low priority: after the terrain's own tiles (whose priorities are pixels of error).
      if (!data) this.terrain.requestDataTile(treeDataTile(k), 1);
      if (!data || performance.now() - t0 > this.buildBudgetMs) {
        pending++;
        continue;
      }
      this.tiles.set(s, this.build(placeTrees(k, data, opts, world.seed, this.clearings)));
    }
    this.stats.pending = pending;

    // Place, and evict tiles not wanted for a while.
    let instances = 0;
    for (const [s, tile] of this.tiles) {
      if (wanted.has(s)) {
        tile.lastUsed = this.frame;
        for (const m of tile.meshes) {
          const g = m.geometry as InstancedBufferGeometry;
          instances += g.instanceCount;
          m.position.set(tile.origin.x - eye.x, tile.origin.y - eye.y, tile.origin.z - eye.z);
          m.visible = true;
        }
      } else {
        for (const m of tile.meshes) m.visible = false;
        if (this.frame - tile.lastUsed > 120) {
          for (const m of tile.meshes) {
            this.group.remove(m);
            m.geometry.dispose();
          }
          this.tiles.delete(s);
        }
      }
    }
    this.stats.tiles = this.tiles.size;
    this.stats.instances = instances;
  }

  private build(inst: TreeInstances): TreeTile {
    const meshes: Mesh[] = [];
    for (const kind of ['conifer', 'broadleaf'] as const) {
      const data = inst[kind];
      const count = data.length / INSTANCE_FLOATS;
      if (count === 0) continue;
      const g = new InstancedBufferGeometry();
      const geo = this.geometries[kind];
      g.setAttribute('position', new BufferAttribute(geo.position, 3));
      g.setAttribute('normal', new BufferAttribute(geo.normal, 3));
      g.setAttribute('color', new BufferAttribute(geo.color, 3));
      const base = new Float32Array(count * 3);
      const up = new Float32Array(count * 3);
      const params = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const o = i * INSTANCE_FLOATS;
        base.set(data.subarray(o, o + 3), i * 3);
        up.set(data.subarray(o + 3, o + 6), i * 3);
        params.set(data.subarray(o + 6, o + 10), i * 4);
      }
      g.setAttribute('iBase', new InstancedBufferAttribute(base, 3));
      g.setAttribute('iUp', new InstancedBufferAttribute(up, 3));
      g.setAttribute('iParams', new InstancedBufferAttribute(params, 4));
      g.instanceCount = count;
      const mesh = new Mesh(g, this.materials[kind]);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      meshes.push(mesh);
    }
    return { meshes, origin: inst.origin, lastUsed: this.frame };
  }

  /** Drops all trees (world change). */
  clear(): void {
    for (const tile of this.tiles.values()) {
      for (const m of tile.meshes) {
        this.group.remove(m);
        m.geometry.dispose();
      }
    }
    this.tiles.clear();
  }

  dispose(): void {
    this.clear();
    this.materials.conifer.dispose();
    this.materials.broadleaf.dispose();
  }
}
