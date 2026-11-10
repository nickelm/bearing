/**
 * The tiled LOD terrain (milestone 2). Each frame:
 *
 *  1. Select tiles by screen-space error (quadtree.ts). A tile only splits
 *     once its children's meshes exist, so the view never has holes.
 *  2. Build missing meshes from cached tile data, within a per-frame time
 *     budget, highest priority first (tileMesh.ts).
 *  3. Request missing tile data from the GPU synthesizer in batches
 *     (tileCache.ts loader), one batch in flight.
 *  4. Place drawn meshes camera-relative: mesh.position = origin − eye in
 *     float64 (rule 4), and set each mesh's morph factor.
 *  5. Evict least-recently-used data and meshes over budget.
 *
 * Two caches: TileData (CPU heights and materials, levels ≤ 7, also used for
 * ground-height queries) and meshes (GPU buffers, any level).
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import {
  attribute,
  Fn,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  positionLocal,
  positionWorld,
  uniform,
  varyingProperty,
  vec4,
} from 'three/tsl';
import { directionToCubeFace } from '../../core/coords';
import type { CubeFaceUv } from '../../core/coords';
import { Noise3 } from '../../core/noise';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import {
  parentTile,
  tileKey,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { Vec3d } from '../../core/vec3d';
import { MAX_BAKED_LEVEL } from '../../worldgen/gpu/tileSynth';
import type { TileData, TileSynthesizer } from '../../worldgen/gpu/tileSynth';
import { ClimateTexture } from '../climateTexture';
import { PlanetLighting } from '../lighting/planetLighting';
import { WAVE_PERIOD, WaterShading } from '../water/waterShading';
import { LandShading } from './landShading';
import { DEFAULT_LOD, selectTiles } from './quadtree';
import type { LodOptions, LodView } from './quadtree';
import { TileCache, TileLoader, TileRequestQueue } from './tileCache';
import { buildTileIndex, buildTileMesh, dataTileFor, TILE_VERTEX_COUNT } from './tileMesh';
import type { MeshOptions, TileViewMode } from './tileMesh';

const DATA_BYTES = TILE_STRIDE * TILE_STRIDE * 8;
const ZERO = new Vector3();
/**
 * Share of the tile memory budget for CPU tile data; the rest holds meshes.
 * Low views draw about 400 meshes plus their fallback parents, against about
 * 200 data tiles (deeper meshes share a level-7 data tile).
 */
const DATA_SHARE = 0.45;
/** A planet coordinate modulo the wave period, in float64 (decision 38). */
const wrapCoordinate = (x: number) => ((x % WAVE_PERIOD) + WAVE_PERIOD) % WAVE_PERIOD;
/** base, up, parentBase, parentDisp, slope, color (vec3) + height, water, shore (float), float32. */
const MESH_BYTES = TILE_VERTEX_COUNT * (6 * 3 + 3) * 4;

export interface TerrainStats {
  drawn: number;
  dataTiles: number;
  meshes: number;
  generated: number;
  pending: number;
  deepest: number;
}

export interface TerrainWorld {
  synth: TileSynthesizer;
  seed: WorldSeed;
  radius: number;
  reliefScale: number;
}

export class TerrainRenderer {
  readonly group = new Group();
  readonly stats: TerrainStats = {
    drawn: 0,
    dataTiles: 0,
    meshes: 0,
    generated: 0,
    pending: 0,
    deepest: 0,
  };
  lod: LodOptions = { ...DEFAULT_LOD };
  geomorph = true;
  /** Milliseconds per frame spent building meshes. */
  buildBudgetMs = 8;

  private world: TerrainWorld | null = null;
  private exaggeration = 10;
  /** Height exaggeration, shared with layers drawn on the terrain (trees). */
  readonly exaggerationUniform = uniform(10);
  private mode: TileViewMode = 'biome';
  private detail: Noise3 = new Noise3(rng(0, 'render-detail'));
  private readonly index = new BufferAttribute(buildTileIndex(), 1);
  private readonly material: MeshBasicNodeMaterial;
  /** Sea and lake shading inside the terrain material (decision 37). */
  readonly water: WaterShading;
  /** Land albedo: moisture, rock, snow, season and detail (decision 43). */
  readonly land = new LandShading();
  private readonly data = new TileCache<TileData>(DATA_SHARE * 600 * 2 ** 20);
  private readonly meshes = new TileCache<Mesh>((1 - DATA_SHARE) * 600 * 2 ** 20, (e) => {
    this.group.remove(e.value);
    // The index buffer is shared by every tile: detach it, or dispose() would free it for all.
    e.value.geometry.setIndex(null);
    e.value.geometry.dispose();
  });
  private readonly queue = new TileRequestQueue();
  private readonly loader: TileLoader<TileData>;
  private visible = new Set<Mesh>();
  private readonly scratch = new Vec3d();

  constructor(
    readonly lighting = new PlanetLighting(),
    readonly climate = new ClimateTexture(),
  ) {
    const morph = uniform(1).onObjectUpdate(({ object }) => {
      const m = (object as Mesh | undefined)?.userData.morph as number | undefined;
      return m ?? 1;
    });
    // Unlit material: the color node computes radiance itself (decision 34).
    this.material = new MeshBasicNodeMaterial({ side: DoubleSide });
    // Exaggeration and geomorphing in the vertex shader (see TileMeshData):
    // changing the exaggeration is a uniform update, not a rebuild.
    const exaggeration = this.exaggerationUniform;
    const up = attribute('up', 'vec3');
    // Packed per-vertex scalars (WebGPU allows 8 vertex buffers): raw height,
    // signed lake depth, coast distance.
    const surfaceAttr = attribute('surface', 'vec3');
    const rawHeight = surfaceAttr.x;
    const lakeDepth = surfaceAttr.y;
    // The sea is drawn flat at 0 m and lakes flat at their level; the raw height and
    // lake depth still reach the fragment stage (decisions 37, 40).
    const shown = max(rawHeight.add(max(lakeDepth, 0)), 0);
    const own = positionLocal.add(up.mul(shown.mul(exaggeration)));
    const parent = attribute('parentBase', 'vec3').add(
      attribute('parentDisp', 'vec3').mul(exaggeration),
    );
    // Aerial perspective per vertex (decision 35), handed to the fragment stage.
    const apInscatter = varyingProperty('vec3', 'vApInscatter');
    const apTransmittance = varyingProperty('vec3', 'vApTransmittance');
    // Each mesh's origin modulo the wave period (float64 on the CPU): fragments
    // evaluate periodic surface detail on small, precise coordinates (decision 38).
    const wrapOrigin = uniform(new Vector3()).onObjectUpdate(
      ({ object }) => ((object as Mesh | undefined)?.userData.wrap as Vector3 | undefined) ?? ZERO,
    );
    const local = varyingProperty('vec3', 'vLocal');
    this.material.positionNode = Fn(() => {
      const p = mix(parent, own, morph);
      local.assign(p);
      const relative = modelWorldMatrix.mul(vec4(p, 1)).xyz;
      const ap = lighting.atmosphere.aerialPerspective(relative);
      apInscatter.assign(ap.inscatter);
      apTransmittance.assign(ap.transmittance);
      return p;
    })();
    // Meshes carry no rotation or scale, so object space is world space.
    const normal = normalize(up.sub(attribute('slope', 'vec3').mul(exaggeration)));
    this.water = new WaterShading(lighting);
    const radial = normalize(up);
    const wrapped = wrapOrigin.add(local);
    const climateHere = climate.sample(radial);
    const bed = attribute('color', 'vec3');
    const surface = this.water.shade({
      albedo: this.land.albedo({
        albedo: bed,
        slope: attribute('slope', 'vec3'),
        height: rawHeight,
        up: radial,
        climate: climateHere,
        wrapped,
      }),
      bed,
      temperature: this.land.surfaceTemperature(climateHere, rawHeight, radial),
      normal,
      height: rawHeight,
      lake: lakeDepth,
      shore: surfaceAttr.z,
      up: radial,
      relative: positionWorld,
      wavePosition: wrapped,
    });
    this.material.colorNode = lighting.applyAerial(surface, apInscatter, apTransmittance);
    this.loader = new TileLoader<TileData>(
      this.data,
      this.queue,
      async (tiles) => {
        const w = this.world;
        if (!w) return [];
        const out = await w.synth.generate(tiles);
        // A world switched while generating: drop the stale batch.
        if (this.world !== w) return [];
        return out.map((d) => ({ tile: d.key, value: d, bytes: DATA_BYTES }));
      },
      8,
    );
  }

  /** The current world (null before one is set). */
  get currentWorld(): TerrainWorld | null {
    return this.world;
  }

  /** Mesh-building options for the current world, e.g. to sample the drawn surface. */
  meshOptions(): MeshOptions | null {
    const w = this.world;
    if (!w) return null;
    return { radius: w.radius, reliefScale: w.reliefScale, mode: this.mode, detail: this.detail };
  }

  /** Cached tile data (levels ≤ MAX_BAKED_LEVEL), marking it used; undefined if not loaded. */
  dataTile(key: TileKey): TileData | undefined {
    return this.data.get(key);
  }

  /** Shows a world (or nothing). Drops all cached tiles. */
  setWorld(world: TerrainWorld | null): void {
    this.world = world;
    if (world) {
      this.water.reliefScale.value = world.reliefScale;
      this.land.reliefScale.value = world.reliefScale;
    }
    this.detail = new Noise3(rng(world?.seed ?? 0, 'render-detail'));
    this.data.clear();
    this.meshes.clear();
    this.visible.clear();
  }

  /** Applied in the vertex shader: no meshes are rebuilt. */
  setExaggeration(x: number): void {
    this.exaggeration = x;
    this.exaggerationUniform.value = x;
  }

  setMode(mode: TileViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.water.enabled.value = mode === 'biome' ? 1 : 0;
    this.land.enabled.value = mode === 'biome' ? 1 : 0;
    this.meshes.clear();
    this.visible.clear();
  }

  set budgetMiB(mib: number) {
    this.data.budgetBytes = mib * 2 ** 20 * DATA_SHARE;
    this.meshes.budgetBytes = mib * 2 ** 20 * (1 - DATA_SHARE);
  }

  /** Data needed to build tile t's mesh, if cached (marks it used). */
  private sources(t: TileKey): { data: TileData; parentData: TileData | null } | null {
    const data = this.data.get(dataTileFor(t));
    if (!data) return null;
    if (t.level === 0 || t.level > MAX_BAKED_LEVEL) return { data, parentData: null };
    const parentData = this.data.get(parentTile(t)!);
    return parentData ? { data, parentData } : null;
  }

  /** Requests the data tile t's mesh needs. */
  private requestData(t: TileKey, priority: number): void {
    const d = dataTileFor(t);
    if (!this.data.has(d)) this.queue.request(d, priority);
    if (t.level > 0 && t.level <= MAX_BAKED_LEVEL) {
      const p = parentTile(t)!;
      if (!this.data.has(p)) this.queue.request(p, priority);
    }
  }

  private buildMesh(t: TileKey): Mesh | null {
    const w = this.world;
    const src = this.sources(t);
    if (!w || !src) return null;
    const m = buildTileMesh(t, src, {
      radius: w.radius,
      reliefScale: w.reliefScale,
      mode: this.mode,
      detail: this.detail,
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.base, 3));
    g.setAttribute('up', new BufferAttribute(m.up, 3));
    const surface = new Float32Array(TILE_VERTEX_COUNT * 3);
    for (let v = 0; v < TILE_VERTEX_COUNT; v++) {
      surface[v * 3] = m.height[v]!;
      surface[v * 3 + 1] = m.water[v]!;
      surface[v * 3 + 2] = m.shore[v]!;
    }
    g.setAttribute('surface', new BufferAttribute(surface, 3));
    g.setAttribute('parentBase', new BufferAttribute(m.parentBase, 3));
    g.setAttribute('parentDisp', new BufferAttribute(m.parentDisp, 3));
    g.setAttribute('slope', new BufferAttribute(m.slope, 3));
    g.setAttribute('color', new BufferAttribute(m.color, 3));
    g.setIndex(this.index);
    const mesh = new Mesh(g, this.material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = true;
    mesh.userData.origin = m.origin;
    mesh.userData.wrap = new Vector3(
      wrapCoordinate(m.origin.x),
      wrapCoordinate(m.origin.y),
      wrapCoordinate(m.origin.z),
    );
    mesh.userData.morph = 1;
    mesh.visible = false;
    this.group.add(mesh);
    this.meshes.set(t, mesh, MESH_BYTES);
    return mesh;
  }

  /** Selects, builds, requests and places tiles for this frame. */
  update(view: Omit<LodView, 'exaggeration'>): void {
    if (!this.world) {
      for (const m of this.visible) m.visible = false;
      this.visible.clear();
      return;
    }
    const v: LodView = { ...view, exaggeration: this.exaggeration };
    this.data.beginFrame();
    this.meshes.beginFrame();
    this.queue.beginFrame();

    let sel = selectTiles(v, (t) => this.meshes.has(t), this.lod);
    // Build wanted meshes whose data is cached, best first, within the time budget.
    const t0 = performance.now();
    const wanted = [...sel.wanted].sort((a, b) => b.priority - a.priority);
    let built = 0;
    for (const w of wanted) {
      if (this.meshes.has(w.tile)) continue;
      if (this.sources(w.tile)) {
        if (performance.now() - t0 > this.buildBudgetMs && built > 0) continue;
        if (this.buildMesh(w.tile)) built++;
      } else {
        this.requestData(w.tile, w.priority);
      }
    }
    if (built > 0) sel = selectTiles(v, (t) => this.meshes.has(t), this.lod);
    for (const w of sel.wanted) if (!this.sources(w.tile)) this.requestData(w.tile, w.priority);

    // Place drawn meshes camera-relative and keep their data alive.
    const now = new Set<Mesh>();
    let deepest = 0;
    for (const d of sel.draw) {
      const mesh = this.meshes.get(d.tile);
      if (!mesh) continue;
      this.sources(d.tile);
      const o = mesh.userData.origin as Vec3d;
      this.scratch.copy(o).sub(view.eye);
      mesh.position.set(this.scratch.x, this.scratch.y, this.scratch.z);
      mesh.userData.morph = this.geomorph ? d.morph : 1;
      mesh.visible = true;
      now.add(mesh);
      deepest = Math.max(deepest, d.tile.level);
    }
    for (const m of this.visible) if (!now.has(m)) m.visible = false;
    this.visible = now;

    void this.loader.update();
    this.meshes.evict();
    this.data.evict();

    const s = this.stats;
    s.drawn = now.size;
    s.dataTiles = this.data.size;
    s.meshes = this.meshes.size;
    s.generated = this.loader.generated;
    s.pending = this.loader.pending;
    s.deepest = deepest;
  }

  /**
   * Physical terrain height (m, not exaggerated; ≤ 0 is sea) under a
   * direction, from the finest cached tile data, or null if none is cached.
   */
  heightAt(dir: Readonly<Vec3d>): number | null {
    const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
    directionToCubeFace(dir, uv);
    for (let level = MAX_BAKED_LEVEL; level >= 0; level--) {
      const size = 1 << level;
      const x = Math.min(size - 1, Math.floor(uv.u * size));
      const y = Math.min(size - 1, Math.floor(uv.v * size));
      const key = tileKey(uv.face, level, x, y);
      const data = this.data.get(key);
      if (!data) continue;
      const fx = (uv.u * size - x) * TILE_TEXELS;
      const fy = (uv.v * size - y) * TILE_TEXELS;
      const x0 = Math.min(TILE_TEXELS - 1, Math.floor(fx));
      const y0 = Math.min(TILE_TEXELS - 1, Math.floor(fy));
      const tx = fx - x0;
      const ty = fy - y0;
      const i = (y0 + TILE_BORDER) * TILE_STRIDE + x0 + TILE_BORDER;
      const h = data.height;
      return (
        (h[i]! * (1 - tx) + h[i + 1]! * tx) * (1 - ty) +
        (h[i + TILE_STRIDE]! * (1 - tx) + h[i + TILE_STRIDE + 1]! * tx) * ty
      );
    }
    return null;
  }

  /** Displayed height (m, exaggerated, sea flat at 0) under a direction, or null. */
  displayHeightAt(dir: Readonly<Vec3d>): number | null {
    const h = this.heightAt(dir);
    return h === null ? null : Math.max(0, h) * this.exaggeration;
  }

  /** For debugging: string keys of the meshes drawn last frame. */
  drawnKeys(): string[] {
    const out: string[] = [];
    for (const e of this.meshes.values()) if (e.value.visible) out.push(tileKeyString(e.tile));
    return out;
  }

  dispose(): void {
    this.setWorld(null);
    this.material.dispose();
  }
}
