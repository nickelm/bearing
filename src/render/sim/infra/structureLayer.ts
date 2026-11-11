/**
 * Instanced buildings near the camera (milestone 5, decision 65): town
 * clusters scaled by population, airbase hangars, shelters and towers, and
 * industrial plants with stacks.
 *
 * - Placed per level-9 tile within `range` of the camera and below
 *   `maxAltitude`, like the trees (decision 45), on the same level-10 surface.
 * - **Towns:** candidates on a jittered 45 m lattice from
 *   rng(seed, "buildings").fork(tileKey); every candidate draws all its
 *   values. A candidate is kept with probability 0.55 × exp(−2 (d / r)²)
 *   within the urban radius r of the nearest town, off roads and water.
 *   Cities get taller buildings in their core.
 * - **Airbases and industry:** a fixed layout per site from
 *   rng(seed, "buildings").fork(site key); a building is placed by the tile
 *   that contains it.
 * - Buildings keep their real size; only the ground point is exaggerated.
 */
import {
  BufferAttribute,
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
import { APRON_LENGTH, APRON_OFFSET, offsetPoint, TAXIWAY_OFFSET } from './infraScene';
import type { BuiltSite, InfraScene } from './infraScene';

type V3 = Node<'vec3'>;

export const BUILDING_TILE_LEVEL = 9;
const GROUND_LEVEL = 10;
const LATTICE = 45;

/** Per instance: base xyz (relative to origin), up xyz, ground height, width, depth, angle, height, r, g, b. */
export const BUILDING_FLOATS = 14;

export interface BuildingInstances {
  tile: TileKey;
  origin: Vec3d;
  data: Float32Array;
}

interface Building {
  d: Vec3d;
  w: number;
  depth: number;
  angle: number;
  height: number;
  rgb: [number, number, number];
}

function townBuilding(r: Rng, core: boolean, city: boolean): Omit<Building, 'd'> {
  const tall = core && city && r.chance(0.3);
  const w = tall ? r.range(18, 40) : r.range(9, 22);
  const shade = r.range(0.55, 0.85);
  const brick = r.chance(0.35);
  return {
    w,
    depth: w * r.range(0.6, 1.4),
    angle: r.range(0, Math.PI),
    height: tall ? r.range(20, 60) : r.range(5, core ? 16 : 10),
    rgb: brick ? [shade * 0.75, shade * 0.5, shade * 0.4] : [shade, shade * 0.97, shade * 0.92],
  };
}

/** Fixed buildings of an airbase or industrial site (all of them, wherever they fall). */
function siteBuildings(site: BuiltSite, radius: number, seed: WorldSeed): Building[] {
  const r = rng(seed, 'buildings').fork(site.key);
  const out: Building[] = [];
  const p = site.point;
  const h = site.heading;
  const at = (along: number, across: number) => offsetPoint(p, h, along, across, radius);
  if (site.kind === 'airbase') {
    const concrete: [number, number, number] = [0.5, 0.5, 0.47];
    const green: [number, number, number] = [0.3, 0.34, 0.26];
    // Hangars behind the apron.
    const hangars = 3 + r.int(4);
    for (let i = 0; i < hangars; i++) {
      const along = -APRON_LENGTH / 2 + ((i + 0.5) * APRON_LENGTH) / hangars;
      out.push({
        d: at(along, APRON_OFFSET + 140),
        w: 60,
        depth: 45,
        angle: h,
        height: 16,
        rgb: concrete,
      });
    }
    out.push({
      d: at(APRON_LENGTH / 2 + 80, APRON_OFFSET),
      w: 8,
      depth: 8,
      angle: h,
      height: 28,
      rgb: [0.7, 0.7, 0.68],
    });
    // Hardened shelters dispersed along both ends of the taxiway.
    const shelters = 8 + r.int(8);
    for (let i = 0; i < shelters; i++) {
      const end = i % 2 === 0 ? -1 : 1;
      const along = end * (site.runwayLength / 2 - r.range(100, 700));
      out.push({
        d: at(along, TAXIWAY_OFFSET + r.range(120, 450)),
        w: 24,
        depth: 30,
        angle: h + r.range(-0.6, 0.6),
        height: 8,
        rgb: green,
      });
    }
  } else if (site.kind === 'industry') {
    const halls = 6 + r.int(6);
    for (let i = 0; i < halls; i++) {
      out.push({
        d: at(r.range(-500, 500), r.range(-350, 350)),
        w: r.range(40, 110),
        depth: r.range(25, 60),
        angle: h,
        height: r.range(10, 24),
        rgb: [r.range(0.45, 0.6), r.range(0.43, 0.55), r.range(0.4, 0.5)],
      });
    }
    const stacks = 1 + r.int(3);
    for (let i = 0; i < stacks; i++) {
      out.push({
        d: at(r.range(-200, 200), r.range(-150, 150)),
        w: 6,
        depth: 6,
        angle: 0,
        height: r.range(60, 120),
        rgb: [0.55, 0.35, 0.3],
      });
    }
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
  const out: number[] = [];
  if (sites.length === 0) return { tile: t, origin, data: new Float32Array(0) };
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
    out.push(
      b.d.x * R - origin.x,
      b.d.y * R - origin.y,
      b.d.z * R - origin.z,
      b.d.x,
      b.d.y,
      b.d.z,
      h,
      b.w,
      b.depth,
      b.angle,
      b.height,
      ...b.rgb,
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
        for (const s of towns) {
          const dist = Math.acos(Math.min(1, s.point.dot(d))) * R;
          const f = dist / s.radius;
          const p = 0.55 * Math.exp(-2 * f * f);
          if (f < 1.3 && p > bestF) {
            bestF = p;
            best = s;
          }
        }
        if (!best || keep >= bestF) continue;
        if (scene.isClear(d, true)) continue;
        const dist = Math.acos(Math.min(1, best.point.dot(d))) * R;
        const shape = townBuilding(
          r.fork(`${a},${b}`),
          dist < 0.3 * best.radius,
          best.population >= 200_000,
        );
        emit({ d: d.clone(), ...shape });
      }
    }
  }
  return { tile: t, origin, data: Float32Array.from(out) };
}

/** A unit box, bottom 3 m under the ground point, top at 1: position and normal, 36 vertices. */
function unitBox(): { position: Float32Array; normal: Float32Array } {
  const pos: number[] = [];
  const nrm: number[] = [];
  const y0 = -0.15;
  const faces: [number[], number[][]][] = [
    [
      [1, 0, 0],
      [
        [0.5, y0, -0.5],
        [0.5, 1, -0.5],
        [0.5, 1, 0.5],
        [0.5, y0, 0.5],
      ],
    ],
    [
      [-1, 0, 0],
      [
        [-0.5, y0, 0.5],
        [-0.5, 1, 0.5],
        [-0.5, 1, -0.5],
        [-0.5, y0, -0.5],
      ],
    ],
    [
      [0, 0, 1],
      [
        [0.5, y0, 0.5],
        [0.5, 1, 0.5],
        [-0.5, 1, 0.5],
        [-0.5, y0, 0.5],
      ],
    ],
    [
      [0, 0, -1],
      [
        [-0.5, y0, -0.5],
        [-0.5, 1, -0.5],
        [0.5, 1, -0.5],
        [0.5, y0, -0.5],
      ],
    ],
    [
      [0, 1, 0],
      [
        [-0.5, 1, -0.5],
        [-0.5, 1, 0.5],
        [0.5, 1, 0.5],
        [0.5, 1, -0.5],
      ],
    ],
  ];
  for (const [n, q] of faces) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(...q[i]!);
      nrm.push(...n);
    }
  }
  return { position: Float32Array.from(pos), normal: Float32Array.from(nrm) };
}

interface BuiltTile {
  mesh: Mesh | null;
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
  private readonly box = unitBox();
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
    const m = new MeshBasicNodeMaterial();
    const base = attribute('iBase', 'vec3');
    const up = normalize(attribute('iUp', 'vec3'));
    const params = attribute('iParams', 'vec4'); // ground height, width, depth, angle
    const style = attribute('iStyle', 'vec4'); // height, r, g, b
    const ex = this.terrain.exaggerationUniform;
    const t0 = normalize(cross(up, vec3(0.0001, 1, 0.0002)));
    const t1 = cross(up, t0);
    const ca = cos(params.w);
    const sa = sin(params.w);
    const ax = t0.mul(ca).add(t1.mul(sa));
    const az = t1.mul(ca).sub(t0.mul(sa));
    const local = attribute('position', 'vec3');
    const ground = base.add(up.mul(max(params.x, 0).mul(ex)));
    const apIn = varyingProperty('vec3', 'vBuildInscatter');
    const apTr = varyingProperty('vec3', 'vBuildTransmittance');
    m.positionNode = Fn(() => {
      // Shrink buildings away toward the edge of the range, like the trees.
      const dist = modelWorldMatrix.mul(vec4(ground, 1)).xyz.length();
      const k = smoothstep(this.range, this.range.sub(this.fade), dist);
      const p = ground
        .add(ax.mul(local.x.mul(params.y).mul(k)))
        .add(up.mul(local.y.mul(style.x).mul(k)))
        .add(az.mul(local.z.mul(params.z).mul(k)));
      const ap = lighting.atmosphere.aerialPerspective(
        modelWorldMatrix.mul(vec4(p, 1)).xyz as V3,
        6,
      );
      apIn.assign(ap.inscatter);
      apTr.assign(ap.transmittance);
      return p;
    })();
    const n0 = attribute('normal', 'vec3');
    const normal = normalize(ax.mul(n0.x).add(up.mul(n0.y)).add(az.mul(n0.z))) as V3;
    const roof = dot(normal, up).greaterThan(0.5);
    const albedo = style.yzw.mul(roof.select(0.8, 1)) as V3;
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
      const m = tile.mesh;
      if (wanted.has(s)) {
        tile.lastUsed = this.frame;
        if (m) {
          instances += (m.geometry as InstancedBufferGeometry).instanceCount;
          placeCameraRelative(m, tile.origin, eye);
          m.visible = true;
        }
      } else {
        if (m) m.visible = false;
        if (this.frame - tile.lastUsed > 120) {
          if (m) {
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

  private build(inst: BuildingInstances): BuiltTile {
    const count = inst.data.length / BUILDING_FLOATS;
    if (count === 0) return { mesh: null, origin: inst.origin, lastUsed: this.frame };
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.box.position, 3));
    g.setAttribute('normal', new BufferAttribute(this.box.normal, 3));
    const base = new Float32Array(count * 3);
    const up = new Float32Array(count * 3);
    const params = new Float32Array(count * 4);
    const style = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const o = i * BUILDING_FLOATS;
      base.set(inst.data.subarray(o, o + 3), i * 3);
      up.set(inst.data.subarray(o + 3, o + 6), i * 3);
      params.set(inst.data.subarray(o + 6, o + 10), i * 4);
      style.set(inst.data.subarray(o + 10, o + 14), i * 4);
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
    return { mesh, origin: inst.origin, lastUsed: this.frame };
  }

  clear(): void {
    for (const tile of this.tiles.values()) {
      if (tile.mesh) {
        this.group.remove(tile.mesh);
        tile.mesh.geometry.dispose();
      }
    }
    this.tiles.clear();
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
