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
  clamp,
  float,
  fwidth,
  Fn,
  If,
  length,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  step,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import { placeCameraRelative } from '../../common/cameraRelative';
import { directionToCubeFace } from '../../../core/coords';
import type { CubeFaceUv } from '../../../core/coords';
import { Noise3 } from '../../../core/noise';
import { rng } from '../../../core/rng';
import type { WorldSeed } from '../../../core/rng';
import {
  MAX_TILE_LEVEL,
  parentTile,
  tileForDirection,
  tileKey,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import { MAX_BAKED_LEVEL } from '../../../worldgen/gpu/tileSynth';
import type { TileData, TileSynthesizer } from '../../../worldgen/gpu/tileSynth';
import { ClimateTexture } from '../../common/climateTexture';
import { PlanetLighting } from '../lighting/planetLighting';
import { RiverShading, RiverStyle } from '../../common/water/riverShading';
import { RiverTables } from '../../common/water/riverTables';
import { WAVE_PERIOD, WaterShading } from '../water/waterShading';
import type { RiverIndex } from '../../../worldgen/riverIndex';
import type { InfraScene } from '../infra/infraScene';
import type { SurfaceGrading } from '../../common/terrain/grading';
import { HabitabilityTexture } from '../../common/habitabilityTexture';
import {
  builtAlbedo,
  LightShading,
  LightTables,
  nightFactor,
  RoadShading,
  RoadStyle,
  ruralSpeckle,
} from '../infra/roadShading';
import { LandShading } from './landShading';
import { DEFAULT_LOD, selectTiles } from '../../common/terrain/quadtree';
import type { LodOptions, LodView } from '../../common/terrain/quadtree';
import { TileCache, TileLoader, TileRequestQueue } from '../../common/terrain/tileCache';
import {
  buildTileIndex,
  buildTileMesh,
  dataTileFor,
  lakeSampler,
  surfaceSampler,
  TILE_VERTEX_COUNT,
} from '../../common/terrain/tileMesh';
import type { MeshOptions, TileViewMode } from '../../common/terrain/tileMesh';

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
  /** Quadtree nodes visited by the last selection. */
  visited: number;
}

export interface TerrainWorld {
  synth: TileSynthesizer;
  seed: WorldSeed;
  radius: number;
  reliefScale: number;
  /** River segments to draw (decision 46); none when absent. */
  rivers?: RiverIndex;
  /** Roads, airfield pavement and settlement lights (decision 65); none when absent. */
  infra?: InfraScene;
  /** Airfields graded into the terrain (V3); none when absent. */
  grading?: SurfaceGrading;
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
    visited: 0,
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
  private material: MeshBasicNodeMaterial;
  private rivers: RiverTables | null = null;
  private roads: RiverTables | null = null;
  private lights: LightTables | null = null;
  private habitability = new HabitabilityTexture(null, 1);
  /** Road, pavement and night-light settings (decision 65). */
  readonly roadStyle = new RoadStyle();
  /** Sea and lake shading inside the terrain material (decision 37). */
  readonly water: WaterShading;
  /** River drawing settings (decision 46). */
  readonly riverStyle = new RiverStyle();
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

  constructor(
    readonly lighting = new PlanetLighting(),
    readonly climate = new ClimateTexture(),
  ) {
    this.water = new WaterShading(lighting);
    this.material = this.buildMaterial();
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

  /** The terrain material for the current world (its river tables are baked into storage buffers). */
  private buildMaterial(): MeshBasicNodeMaterial {
    const morph = uniform(1).onObjectUpdate(({ object }) => {
      const m = (object as Mesh | undefined)?.userData.morph as number | undefined;
      return m ?? 1;
    });
    // Unlit material: the color node computes radiance itself (decision 34).
    const material = new MeshBasicNodeMaterial({ side: DoubleSide });
    // Exaggeration and geomorphing in the vertex shader (see TileMeshData):
    // changing the exaggeration is a uniform update, not a rebuild.
    const exaggeration = this.exaggerationUniform;
    const up = attribute('up', 'vec3');
    // Packed per-vertex scalars (WebGPU allows 8 vertex buffers): raw height,
    // signed lake depth, coast distance, forest density.
    const surfaceAttr = attribute('surface', 'vec4');
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
    // Rivers from vector data (decision 46): each mesh's range in the segment lists.
    const rivers = new RiverShading(this.rivers, this.world?.radius ?? 1e6, this.riverStyle);
    const riverStart = uniform(0).onObjectUpdate(
      ({ object }) =>
        ((object as Mesh | undefined)?.userData.riverStart as number | undefined) ?? 0,
    );
    const riverCount = uniform(0).onObjectUpdate(
      ({ object }) =>
        ((object as Mesh | undefined)?.userData.riverCount as number | undefined) ?? 0,
    );
    const radius = this.world?.radius ?? 1e6;
    const roads = new RoadShading(this.roads, radius, this.roadStyle);
    const lights = new LightShading(this.lights, radius);
    const objectUniform = (key: string) =>
      uniform(0).onObjectUpdate(
        ({ object }) => ((object as Mesh | undefined)?.userData[key] as number | undefined) ?? 0,
      );
    const roadStart = objectUniform('roadStart');
    const roadCount = objectUniform('roadCount');
    const lightStart = objectUniform('lightStart');
    const lightCount = objectUniform('lightCount');
    const wrapOrigin = uniform(new Vector3()).onObjectUpdate(
      ({ object }) => ((object as Mesh | undefined)?.userData.wrap as Vector3 | undefined) ?? ZERO,
    );
    const local = varyingProperty('vec3', 'vLocal');
    material.positionNode = Fn(() => {
      const p = mix(parent, own, morph);
      local.assign(p);
      const relative = modelWorldMatrix.mul(vec4(p, 1)).xyz;
      const ap = this.lighting.atmosphere.aerialPerspective(relative);
      apInscatter.assign(ap.inscatter);
      apTransmittance.assign(ap.transmittance);
      return p;
    })();
    // Meshes carry no rotation or scale, so object space is world space.
    const normal = normalize(up.sub(attribute('slope', 'vec3').mul(exaggeration)));
    const radial = normalize(up);
    const wrapped = wrapOrigin.add(local);
    const L = this.lighting;
    material.colorNode = Fn(() => {
      // Derivatives first, in uniform control flow: the layers below branch
      // per fragment (decision 69) and must not take derivatives themselves.
      const footprint = length(fwidth(positionWorld)).toVar();
      const heightWidth = max(fwidth(rawHeight), 1e-3).toVar();
      const planet = L.planetPosition(positionWorld);
      // Sunlight, cloud shadow and sky light once for every layer shaded here.
      const at = L.at(positionWorld);
      const climateHere = this.climate.sample(radial);
      const bed = attribute('color', 'vec3');
      // Rivers draw on land only: skip their loop out at sea.
      const offshore = rawHeight.lessThan(heightWidth.negate());
      const river = rivers.coverage(planet, riverStart, riverCount, footprint, offshore.not());
      const dry = step(0.5, rawHeight).mul(step(lakeDepth, 0)).mul(this.land.enabled).toVar();
      const isDry = dry.greaterThan(0);
      // Towns and industry as built-up patches, and their night lights, in one
      // pass over the light list (decision 71); dry land only.
      const built = vec4(0).toVar();
      If(isDry.and(lightCount.greaterThan(0)), () => {
        built.assign(
          lights.sample(planet, lightStart, lightCount, footprint, ruralSpeckle(planet, 2000)),
        );
      });
      const builtCover = clamp(built.x.add(built.y), 0, 1).mul(dry);
      const landAlbedo = mix(
        this.land.albedo({
          albedo: bed,
          slope: attribute('slope', 'vec3'),
          height: rawHeight,
          up: radial,
          climate: climateHere,
          wrapped,
          forest: surfaceAttr.w,
        }),
        builtAlbedo(planet, footprint, built.y.div(max(built.x.add(built.y), 1e-4))),
        builtCover,
      );
      const surface = this.water.shade({
        albedo: landAlbedo as unknown as typeof normal,
        bed,
        temperature: this.land.surfaceTemperature(climateHere, rawHeight, radial),
        normal,
        height: rawHeight,
        lake: lakeDepth,
        river,
        shore: surfaceAttr.z,
        up: radial,
        relative: positionWorld,
        wavePosition: wrapped,
        light: at,
      });
      // Roads and pavement over dry land and rivers (a road over a river reads as a bridge).
      const paved = roads.coverage(planet, roadStart, roadCount, footprint, isDry).toVar();
      // Habitability peaks near 0.6 and is under 0.1 on half the land: 0.4 and up count as fully settled.
      const hab = clamp(this.habitability.sample(radial).div(0.4), 0, 1).toVar();
      // Road color from docs/visual-style.md (#7A7062, linear).
      const asphalt = vec3(0.195, 0.162, 0.122);
      const concrete = vec3(0.4, 0.39, 0.36);
      const concreteShare = clamp(paved.y.div(max(paved.x, 1e-4)), 0, 1);
      // Runway and taxiway paint on the concrete (V3): white, and yellow where negative.
      const paintWhite = vec3(0.8, 0.79, 0.74);
      const paintYellow = vec3(0.7, 0.45, 0.06);
      const painted = mix(
        mix(concrete, paintWhite, clamp(built.w, 0, 1)),
        paintYellow,
        clamp(built.w.negate(), 0, 1),
      );
      const roadAlbedo = mix(asphalt, painted, concreteShare) as unknown as typeof normal;
      const roadRadiance = L.shadeDiffuse(roadAlbedo, normal, positionWorld, at);
      const withRoads = mix(surface, roadRadiance, paved.x.mul(dry));
      // Settlement lights on the night side (sodium orange), plus a glow along paved roads.
      // By day, at sea and with lights off, none of it runs.
      const night = nightFactor(radial, L.sunDirection);
      const glow = float(0).toVar();
      If(night.mul(dry).mul(this.roadStyle.lights).greaterThan(0), () => {
        // Rural glow: habitability² broken into village-sized speckles, faded out
        // where pixels are much larger than the speckles so orbit views keep a mean.
        // Two scales: village dots (2.5 km) inside clusters of settled land (30 km);
        // where pixels outgrow the dots, their mean takes over within the clusters.
        const dots = clamp(ruralSpeckle(planet).sub(0.5).mul(3), 0, 1);
        const clusters = clamp(ruralSpeckle(planet, 30_000).sub(0.45).mul(3), 0, 1);
        const resolved = clamp(footprint.div(1500), 0, 1);
        const villages = mix(dots, float(0.15), resolved).mul(clusters);
        const rural = pow(hab, 1.5).mul(villages).mul(0.9);
        glow.assign(
          built.z
            .add(rural)
            .add(paved.x.mul(0.12))
            .mul(night)
            .mul(dry)
            .mul(this.roadStyle.lights)
            .mul(0.12),
        );
      });
      const lit = withRoads.add(vec3(1, 0.7, 0.38).mul(glow));
      return L.applyAerial(lit, apInscatter, apTransmittance);
    })();
    return material;
  }

  /** The current world (null before one is set). */
  get currentWorld(): TerrainWorld | null {
    return this.world;
  }

  /** Mesh-building options for the current world, e.g. to sample the drawn surface. */
  meshOptions(): MeshOptions | null {
    const w = this.world;
    if (!w) return null;
    return {
      radius: w.radius,
      reliefScale: w.reliefScale,
      mode: this.mode,
      detail: this.detail,
      grading: w.grading ?? null,
    };
  }

  /**
   * Asks for a data tile that a layer drawn on the terrain needs (trees and
   * buildings, decision 69): the terrain may draw that area from coarser
   * tiles and never load it itself. Requests last one frame; ask every frame.
   * `priority` is compared with the terrain's own screen-space errors (pixels).
   */
  requestDataTile(key: TileKey, priority: number): void {
    if (this.world && !this.data.has(key)) this.queue.request(key, priority);
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
    this.rivers = world?.rivers ? new RiverTables(world.rivers, world.radius) : null;
    this.roads = world?.infra
      ? new RiverTables(world.infra, world.radius, { coarseMinWidth: 0, coarseCap: 300 })
      : null;
    this.lights = world?.infra
      ? new LightTables(world.infra.lights, world.radius, world.infra.outlines)
      : null;
    const oldHabitability = this.habitability;
    this.habitability = world?.infra
      ? new HabitabilityTexture(world.infra.habitability, world.infra.habitabilityResolution)
      : new HabitabilityTexture(null, 1);
    const old = this.material;
    this.material = this.buildMaterial();
    old.dispose();
    oldHabitability.dispose();
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
      grading: w.grading ?? null,
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.base, 3));
    g.setAttribute('up', new BufferAttribute(m.up, 3));
    const surface = new Float32Array(TILE_VERTEX_COUNT * 4);
    for (let v = 0; v < TILE_VERTEX_COUNT; v++) {
      surface[v * 4] = m.height[v]!;
      surface[v * 4 + 1] = m.water[v]!;
      surface[v * 4 + 2] = m.shore[v]!;
      surface[v * 4 + 3] = m.forest[v]!;
    }
    g.setAttribute('surface', new BufferAttribute(surface, 4));
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
    // Displayed height range before exaggeration: tight bounds for LOD selection.
    mesh.userData.minHeight = m.minHeight;
    mesh.userData.maxHeight = m.maxHeight;
    const river = this.rivers?.rangeFor(t);
    mesh.userData.riverStart = river?.start ?? 0;
    mesh.userData.riverCount = river?.count ?? 0;
    const road = this.roads?.rangeFor(t);
    mesh.userData.roadStart = road?.start ?? 0;
    mesh.userData.roadCount = road?.count ?? 0;
    const light = this.lights?.rangeFor(t);
    mesh.userData.lightStart = light?.start ?? 0;
    mesh.userData.lightCount = light?.count ?? 0;
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

    const ready = (t: TileKey) => this.meshes.has(t);
    const x = this.exaggeration;
    const heightRange = (t: TileKey): [number, number] | null => {
      const mesh = this.meshes.peek(t);
      if (!mesh) return null;
      const u = mesh.userData as { minHeight: number; maxHeight: number };
      return [Math.max(0, u.minHeight) * x, Math.max(0, u.maxHeight) * x];
    };
    let sel = selectTiles(v, ready, this.lod, heightRange);
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
    if (built > 0) sel = selectTiles(v, ready, this.lod, heightRange);
    for (const w of sel.wanted) if (!this.sources(w.tile)) this.requestData(w.tile, w.priority);

    // Place drawn meshes camera-relative and keep their data alive.
    const now = new Set<Mesh>();
    let deepest = 0;
    for (const d of sel.draw) {
      const mesh = this.meshes.get(d.tile);
      if (!mesh) continue;
      this.sources(d.tile);
      const o = mesh.userData.origin as Vec3d;
      placeCameraRelative(mesh, o, view.eye);
      mesh.userData.morph = this.geomorph ? d.morph : 1;
      mesh.visible = true;
      now.add(mesh);
      deepest = Math.max(deepest, d.tile.level);
    }
    for (const m of this.visible) if (!now.has(m)) m.visible = false;
    this.visible = now;

    // Generates what this frame asked for, plus the requests trees and buildings made
    // after the last update; then starts collecting the next frame's requests.
    void this.loader.update();
    this.queue.beginFrame();
    this.meshes.evict();
    this.data.evict();

    const s = this.stats;
    s.drawn = now.size;
    s.dataTiles = this.data.size;
    s.meshes = this.meshes.size;
    s.generated = this.loader.generated;
    s.pending = this.loader.pending;
    s.deepest = deepest;
    s.visited = sel.visited;
  }

  /**
   * Physical terrain height (m, not exaggerated; ≤ 0 is sea) under a
   * direction, from the finest cached tile data and graded like the meshes,
   * or null if none is cached.
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
      const raw =
        (h[i]! * (1 - tx) + h[i + 1]! * tx) * (1 - ty) +
        (h[i + TILE_STRIDE]! * (1 - tx) + h[i + TILE_STRIDE + 1]! * tx) * ty;
      return this.world?.grading ? this.world.grading.apply(dir, raw) : raw;
    }
    return null;
  }

  /**
   * Displayed height (m, exaggerated, sea and lakes flat) of the finest surface
   * under a direction: the level-MAX_TILE_LEVEL surface the finest meshes, trees
   * and buildings use (render detail and grading included), so an eye a couple
   * of meters up stays above the drawn ground. Asks for the data tile it needs;
   * falls back to `displayHeightAt` until it has loaded.
   */
  displaySurfaceAt(dir: Readonly<Vec3d>): number | null {
    const opts = this.meshOptions();
    if (!opts) return null;
    const t = tileForDirection(dir, MAX_TILE_LEVEL);
    const key = dataTileFor(t);
    const data = this.data.get(key);
    if (!data) {
      this.requestDataTile(key, 1e6);
      return this.displayHeightAt(dir);
    }
    const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
    directionToCubeFace(dir, uv);
    const size = TILE_TEXELS * (1 << t.level);
    const sx = uv.u * size - t.x * TILE_TEXELS;
    const sy = uv.v * size - t.y * TILE_TEXELS;
    const h = surfaceSampler(t, t.level, data, opts)(sx, sy, dir);
    const lake = lakeSampler(t, data)(sx, sy);
    return Math.max(0, h, lake) * this.exaggeration;
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
