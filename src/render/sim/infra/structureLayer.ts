/**
 * Instanced buildings near the camera (milestone 5, decision 65): town
 * clusters scaled by population, airbase hangars, shelters and towers, and
 * industrial plants with stacks. Every building is an instance of a model built
 * from a spec (render/common/models, decision 106), turned and scaled per
 * instance, one instanced mesh per model and tile.
 *
 * - Placed per level-9 tile within `range` of the camera and below
 *   `maxAltitude`, like the trees (decision 45), on the same level-10 surface.
 * - **Towns:** candidates on a jittered 45 m lattice from
 *   rng(seed, "buildings").fork(tileKey); every candidate draws all its
 *   values. A candidate is kept with probability 0.55 × exp(−2 (d / r)²)
 *   within the town's urban extent, r its radius toward the candidate
 *   (decision 103's polygon), off roads and water. Houses in the outskirts,
 *   apartment blocks in town cores, tower blocks in city cores.
 * - **Airbases and industry:** a fixed layout per site from
 *   rng(seed, "buildings").fork(site key); a building is placed by the tile
 *   that contains it.
 * - Buildings keep their real size; only the ground point is exaggerated.
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
  cos,
  cross,
  dot,
  Fn,
  max,
  modelWorldMatrix,
  mul,
  normalize,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { placeCameraRelative } from '../../common/cameraRelative';
import { cubeFaceUvToDirection, directionToCubeFace } from '../../../core/coords';
import { rng } from '../../../core/rng';
import type { Rng, WorldSeed } from '../../../core/rng';
import { tileForDirection, tileKeyString, TILE_TEXELS } from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import { NO_LAKE } from '../../../worldgen/gpu/tileSynth';
import type { TileData } from '../../../worldgen/gpu/tileSynth';
import { treeDataTile } from '../forest/forestLayer';
import type { PlanetLighting } from '../lighting/planetLighting';
import type { TerrainRenderer } from '../terrain/terrainRenderer';
import { lakeSampler, surfaceSampler } from '../../common/terrain/tileMesh';
import type { MeshOptions } from '../../common/terrain/tileMesh';
import { nightFactor } from './roadShading';
import {
  APRON_LENGTH,
  APRON_OFFSET,
  offsetPoint,
  TAXIWAY_OFFSET,
  townRadiusToward,
} from './infraScene';
import { libraryModel } from '../../common/models/threeModel';
import type { BuiltSite, InfraScene } from './infraScene';

type V3 = Node<'vec3'>;

export const BUILDING_TILE_LEVEL = 9;
const GROUND_LEVEL = 10;
const LATTICE = 45;

/** Per instance: base xyz (relative to origin), up xyz, ground height, angle, scale x, y, z, tint. */
export const BUILDING_FLOATS = 12;

/** Building models from the spec library (decision 106). */
export const BUILDING_MODELS = [
  'house',
  'house-large',
  'block',
  'tower-block',
  'hangar',
  'shelter',
  'tower',
  'radar-mast',
  'radar-dome',
  'fuel-tank',
  'revetment',
  'factory-hall',
  'stack',
] as const;
export type BuildingModel = (typeof BUILDING_MODELS)[number];

export interface BuildingInstances {
  tile: TileKey;
  origin: Vec3d;
  /** BUILDING_FLOATS per instance, by model. */
  data: Map<BuildingModel, Float32Array>;
}

interface Building {
  d: Vec3d;
  model: BuildingModel;
  /** Shader angle (see `angleForHeading`). */
  angle: number;
  scale: [number, number, number];
  /** Brightness multiplier for variety. */
  tint: number;
}

/**
 * The instance angle that points a model's +x (its front) along a compass heading
 * (rad clockwise from north). The shader measures angles from its own tangent pair,
 * west then south (see the material).
 */
export function angleForHeading(heading: number): number {
  return -Math.PI / 2 - heading;
}

function townBuilding(r: Rng, core: boolean, city: boolean): Omit<Building, 'd'> {
  const tall = core && city && r.chance(0.3);
  const block = !tall && core && r.chance(city ? 0.7 : 0.35);
  const large = !tall && !block && r.chance(0.35);
  const s = r.range(0.8, 1.3);
  const angle = r.range(0, 2 * Math.PI);
  const tint = r.range(0.85, 1.12);
  if (tall) return { model: 'tower-block', angle, scale: [s, r.range(0.6, 1.5), s], tint };
  if (block) return { model: 'block', angle, scale: [s, r.range(0.7, 1.2), s], tint };
  return { model: large ? 'house-large' : 'house', angle, scale: [s, s, s], tint };
}

/** Fixed buildings of an airbase or industrial site (all of them, wherever they fall). */
function siteBuildings(site: BuiltSite, radius: number, seed: WorldSeed): Building[] {
  const r = rng(seed, 'buildings').fork(site.key);
  const out: Building[] = [];
  const p = site.point;
  const h = site.heading;
  const at = (along: number, across: number) => offsetPoint(p, h, along, across, radius);
  const put = (d: Vec3d, model: BuildingModel, heading: number) =>
    out.push({ d, model, angle: angleForHeading(heading), scale: [1, 1, 1], tint: 1 });
  // Toward the runway: the left of the runway heading (buildings stand on its right).
  const facing = h - Math.PI / 2;
  if (site.kind === 'airbase') {
    // Hangars behind the apron, doors toward the runway.
    const hangars = 3 + r.int(4);
    for (let i = 0; i < hangars; i++) {
      const along = -APRON_LENGTH / 2 + ((i + 0.5) * APRON_LENGTH) / hangars;
      put(at(along, APRON_OFFSET + 140), 'hangar', facing);
    }
    put(at(APRON_LENGTH / 2 + 80, APRON_OFFSET), 'tower', facing);
    put(at(-APRON_LENGTH / 2 - 120, APRON_OFFSET + 60), 'fuel-tank', 0);
    put(at(-APRON_LENGTH / 2 - 120, APRON_OFFSET + 150), 'fuel-tank', 0);
    put(at(APRON_LENGTH / 2 + 260, APRON_OFFSET + 180), 'radar-dome', 0);
    put(at(site.runwayLength / 2 + 350, 350), 'radar-mast', facing + r.range(-1, 1));
    // Hardened shelters dispersed along both ends of the taxiway, doors toward it,
    // with revetments between them.
    const shelters = 8 + r.int(8);
    for (let i = 0; i < shelters; i++) {
      const end = i % 2 === 0 ? -1 : 1;
      const along = end * (site.runwayLength / 2 - r.range(100, 700));
      const across = TAXIWAY_OFFSET + r.range(120, 450);
      const turn = r.range(-0.6, 0.6);
      put(at(along, across), i % 4 === 3 ? 'revetment' : 'shelter', facing + turn);
    }
  } else if (site.kind === 'industry') {
    const halls = 6 + r.int(6);
    for (let i = 0; i < halls; i++) {
      out.push({
        d: at(r.range(-500, 500), r.range(-350, 350)),
        model: 'factory-hall',
        angle: angleForHeading(h),
        scale: [r.range(0.7, 1.8), r.range(0.8, 1.6), r.range(0.8, 1.6)],
        tint: r.range(0.85, 1.1),
      });
    }
    const stacks = 1 + r.int(3);
    for (let i = 0; i < stacks; i++) {
      const tall = r.range(0.75, 1.5);
      out.push({
        d: at(r.range(-200, 200), r.range(-150, 150)),
        model: 'stack',
        angle: 0,
        scale: [1, tall, 1],
        tint: 1,
      });
    }
    const tanks = r.int(4);
    for (let i = 0; i < tanks; i++) put(at(r.range(-600, -450), -200 + i * 60), 'fuel-tank', 0);
  }
  return out;
}

/** Places the buildings of level-9 tile `t`, deterministically. Pure: no GPU. */
export function placeBuildings(
  t: TileKey,
  data: TileData,
  opts: MeshOptions,
  scene: InfraScene,
  seed: WorldSeed,
): BuildingInstances {
  const R = opts.radius;
  const size = TILE_TEXELS * (1 << t.level);
  const sampleM = ((Math.PI / 2) * R) / size;
  const center = cubeFaceUvToDirection(
    t.face,
    (t.x + 0.5) / (1 << t.level),
    (t.y + 0.5) / (1 << t.level),
  );
  const origin = center.clone().scale(R);
  const tileRadius = (TILE_TEXELS * sampleM) / Math.SQRT2 + 200;
  const sites = scene.sitesNear(center, tileRadius);
  const out = new Map<BuildingModel, number[]>();
  const result = (): BuildingInstances => ({
    tile: t,
    origin,
    data: new Map([...out].map(([m, v]) => [m, Float32Array.from(v)])),
  });
  if (sites.length === 0) return result();
  const ground = surfaceSampler(t, GROUND_LEVEL, data, opts);
  const lake = lakeSampler(t, data);
  const uv = { face: 0, u: 0, v: 0 } as ReturnType<typeof directionToCubeFace>;
  const emit = (b: Building) => {
    directionToCubeFace(b.d, uv);
    if (uv.face !== t.face) return;
    const sx = uv.u * size - t.x * TILE_TEXELS;
    const sy = uv.v * size - t.y * TILE_TEXELS;
    if (sx < 0 || sy < 0 || sx >= TILE_TEXELS || sy >= TILE_TEXELS) return;
    const h = ground(sx, sy, b.d);
    const level = lake(sx, sy);
    if (h <= 0 || (level > NO_LAKE / 2 && level > h)) return;
    let list = out.get(b.model);
    if (!list) out.set(b.model, (list = []));
    list.push(
      b.d.x * R - origin.x,
      b.d.y * R - origin.y,
      b.d.z * R - origin.z,
      b.d.x,
      b.d.y,
      b.d.z,
      h,
      b.angle,
      ...b.scale,
      b.tint,
    );
  };

  for (const site of sites)
    if (site.kind !== 'town') for (const b of siteBuildings(site, R, seed)) emit(b);

  const towns = sites.filter((s) => s.kind === 'town');
  if (towns.length > 0) {
    const r = rng(seed, 'buildings').fork(tileKeyString(t));
    const step = LATTICE / sampleM;
    const cells = Math.ceil(TILE_TEXELS / step);
    const d = new Vec3d();
    for (let b = 0; b < cells; b++) {
      for (let a = 0; a < cells; a++) {
        const jx = r.nextFloat();
        const jy = r.nextFloat();
        const keep = r.nextFloat();
        const sx = Math.min(TILE_TEXELS, (a + 0.15 + 0.7 * jx) * step);
        const sy = Math.min(TILE_TEXELS, (b + 0.15 + 0.7 * jy) * step);
        cubeFaceUvToDirection(
          t.face,
          (t.x * TILE_TEXELS + sx) / size,
          (t.y * TILE_TEXELS + sy) / size,
          d,
        );
        let best: BuiltSite | null = null;
        let bestF = 0;
        let bestR = 1;
        for (const s of towns) {
          const dist = Math.acos(Math.min(1, s.point.dot(d))) * R;
          const reach = townRadiusToward(s, d);
          const f = dist / reach;
          const p = 0.55 * Math.exp(-2 * f * f);
          if (f < 1.3 && p > bestF) {
            bestF = p;
            best = s;
            bestR = reach;
          }
        }
        if (!best || keep >= bestF) continue;
        if (scene.isClear(d, true)) continue;
        const dist = Math.acos(Math.min(1, best.point.dot(d))) * R;
        const shape = townBuilding(
          r.fork(`${a},${b}`),
          dist < 0.3 * bestR,
          best.population >= 200_000,
        );
        emit({ d: d.clone(), ...shape });
      }
    }
  }
  return result();
}

interface BuiltTile {
  meshes: Mesh[];
  origin: Vec3d;
  lastUsed: number;
}

export class StructureLayer {
  readonly group = new Group();
  /** Off by default: the strategic view draws towns as built-up patches on the terrain (decision 71). */
  enabled = false;
  /** Buildings appear within this distance of the camera (m). */
  readonly range = uniform(12_000);
  /** Buildings shrink away over this last stretch of the range (m). */
  readonly fade = uniform(2500);
  /** Above this height over the ground, no buildings are built or drawn (m). */
  maxAltitude = 15_000;
  buildBudgetMs = 4;
  readonly stats = { tiles: 0, instances: 0, pending: 0 };
  private scene: InfraScene | null = null;
  private readonly tiles = new Map<string, BuiltTile>();
  private readonly material: MeshBasicNodeMaterial;
  private frame = 0;
  private lastWorld: unknown = null;

  constructor(
    private readonly terrain: TerrainRenderer,
    lighting: PlanetLighting,
  ) {
    this.material = this.buildMaterial(lighting);
  }

  setScene(scene: InfraScene | null): void {
    this.scene = scene;
    this.clear();
  }

  private buildMaterial(lighting: PlanetLighting): MeshBasicNodeMaterial {
    // Double-sided like the other simulation layers; shading uses the builder's outward
    // face normals, so either side shades the same.
    const m = new MeshBasicNodeMaterial({ side: DoubleSide });
    const base = attribute('iBase', 'vec3');
    const up = normalize(attribute('iUp', 'vec3'));
    const params = attribute('iParams', 'vec4'); // ground height, angle, scale x, scale y
    const style = attribute('iStyle', 'vec4'); // scale z, tint
    const ex = this.terrain.exaggerationUniform;
    // Tangents west (t0) and south (t1); the model's +x turns by the angle from t0,
    // its +z is to the right of +x (right-handed, as specs are).
    const t0 = normalize(cross(up, vec3(0.0001, 1, 0.0002)));
    const t1 = cross(up, t0);
    const ca = cos(params.y);
    const sa = sin(params.y);
    const ax = t0.mul(ca).add(t1.mul(sa));
    const az = t0.mul(sa).sub(t1.mul(ca));
    const local = attribute('position', 'vec3');
    // A little below the ground point, so bases do not float on slopes.
    const ground = base.add(up.mul(max(params.x, 0).mul(ex).sub(1.5)));
    const apIn = varyingProperty('vec3', 'vBuildInscatter');
    const apTr = varyingProperty('vec3', 'vBuildTransmittance');
    m.positionNode = Fn(() => {
      // Shrink buildings away toward the edge of the range, like the trees.
      const dist = modelWorldMatrix.mul(vec4(ground, 1)).xyz.length();
      const k = smoothstep(this.range, this.range.sub(this.fade), dist);
      const p = ground
        .add(ax.mul(local.x.mul(params.z).mul(k)))
        .add(up.mul(local.y.mul(params.w).mul(k)))
        .add(az.mul(local.z.mul(style.x).mul(k)));
      const ap = lighting.atmosphere.aerialPerspective(
        modelWorldMatrix.mul(vec4(p, 1)).xyz as V3,
        6,
      );
      apIn.assign(ap.inscatter);
      apTr.assign(ap.transmittance);
      return p;
    })();
    // The face normal under the instance's non-uniform scale (inverse transpose).
    const n0 = attribute('normal', 'vec3');
    const normal = normalize(
      ax
        .mul(n0.x.div(params.z))
        .add(up.mul(n0.y.div(params.w)))
        .add(az.mul(n0.z.div(style.x))),
    ) as V3;
    const roof = dot(normal, up).greaterThan(0.5);
    // Spec colors with their baked ambient occlusion, varied per instance.
    const albedo = attribute('color', 'vec3').mul(attribute('ao', 'float')).mul(style.y) as V3;
    // Lit windows on walls at night.
    const night = nightFactor(up as V3, lighting.sunDirection);
    const glow = mul(night, roof.select(0, 0.004));
    const shaded = lighting
      .shadeDiffuse(albedo, normal, positionWorld as V3)
      .add(vec3(1, 0.75, 0.45).mul(glow));
    m.colorNode = lighting.applyAerial(shaded as V3, apIn as V3, apTr as V3);
    return m;
  }

  update(eye: Readonly<Vec3d>, heightAboveGround: number): void {
    this.frame++;
    const world = this.terrain.currentWorld;
    const opts = this.terrain.meshOptions();
    if (world !== this.lastWorld) {
      this.clear();
      this.lastWorld = world;
    }
    const scene = this.scene;
    const show =
      this.enabled &&
      scene !== null &&
      world !== null &&
      opts !== null &&
      opts.mode === 'biome' &&
      heightAboveGround < this.maxAltitude;
    this.group.visible = show;
    if (!show) return;
    const R = opts.radius;
    const tileSize = ((Math.PI / 2) * R) / (1 << BUILDING_TILE_LEVEL);
    const reach = this.range.value + tileSize;
    const radial = eye.clone().normalize();
    const near = scene.sitesNear(radial, reach);
    const wanted = new Map<string, TileKey>();
    if (near.length > 0) {
      const east = new Vec3d(0, 1, 0).cross(radial);
      if (east.length() < 1e-6) east.set(1, 0, 0);
      east.normalize();
      const north = radial.clone().cross(east);
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
          if (!near.some((s) => Math.acos(Math.min(1, s.point.dot(d))) * R <= s.radius + tileSize))
            continue;
          const k = tileForDirection(d, BUILDING_TILE_LEVEL);
          wanted.set(tileKeyString(k), k);
        }
      }
    }
    const t0 = performance.now();
    let pending = 0;
    for (const [s, k] of wanted) {
      if (this.tiles.has(s)) continue;
      const data = this.terrain.dataTile(treeDataTile(k));
      // Low priority: after the terrain's own tiles (whose priorities are pixels of error).
      if (!data) this.terrain.requestDataTile(treeDataTile(k), 1);
      if (!data || performance.now() - t0 > this.buildBudgetMs) {
        pending++;
        continue;
      }
      this.tiles.set(s, this.build(placeBuildings(k, data, opts, scene, world.seed)));
    }
    this.stats.pending = pending;
    let instances = 0;
    for (const [s, tile] of this.tiles) {
      if (wanted.has(s)) {
        tile.lastUsed = this.frame;
        for (const m of tile.meshes) {
          instances += (m.geometry as InstancedBufferGeometry).instanceCount;
          placeCameraRelative(m, tile.origin, eye);
          m.visible = true;
        }
      } else {
        for (const m of tile.meshes) m.visible = false;
        if (this.frame - tile.lastUsed > 120) {
          this.dropTile(tile);
          this.tiles.delete(s);
        }
      }
    }
    this.stats.tiles = this.tiles.size;
    this.stats.instances = instances;
  }

  private build(inst: BuildingInstances): BuiltTile {
    const meshes: Mesh[] = [];
    for (const [model, data] of inst.data) {
      const count = data.length / BUILDING_FLOATS;
      if (count === 0) continue;
      const m = libraryModel(model);
      const g = new InstancedBufferGeometry();
      g.setAttribute('position', new BufferAttribute(m.position, 3));
      g.setAttribute('normal', new BufferAttribute(m.normal, 3));
      g.setAttribute('color', new BufferAttribute(m.color, 3));
      g.setAttribute('ao', new BufferAttribute(m.ao, 1));
      const base = new Float32Array(count * 3);
      const up = new Float32Array(count * 3);
      const params = new Float32Array(count * 4);
      const style = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const o = i * BUILDING_FLOATS;
        base.set(data.subarray(o, o + 3), i * 3);
        up.set(data.subarray(o + 3, o + 6), i * 3);
        params.set(data.subarray(o + 6, o + 10), i * 4);
        style.set(data.subarray(o + 10, o + 12), i * 4);
      }
      g.setAttribute('iBase', new InstancedBufferAttribute(base, 3));
      g.setAttribute('iUp', new InstancedBufferAttribute(up, 3));
      g.setAttribute('iParams', new InstancedBufferAttribute(params, 4));
      g.setAttribute('iStyle', new InstancedBufferAttribute(style, 4));
      g.instanceCount = count;
      const mesh = new Mesh(g, this.material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      meshes.push(mesh);
    }
    return { meshes, origin: inst.origin, lastUsed: this.frame };
  }

  private dropTile(tile: BuiltTile): void {
    for (const m of tile.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
  }

  clear(): void {
    for (const tile of this.tiles.values()) this.dropTile(tile);
    this.tiles.clear();
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
