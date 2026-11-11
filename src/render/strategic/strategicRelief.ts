/**
 * The strategic view's relief mesh (visual-style Part II, Base Map; decision 77).
 *
 * The same tiles as the simulation view's terrain: the quadtree selects by
 * screen-space error (common/terrain/quadtree.ts), meshes come from
 * common/terrain/tileMesh.ts and data from the world's TileSynthesizer. What differs:
 *
 * - **Level cap.** `STRATEGIC_MAX_LEVEL` (6, vertices about 380 m apart on the
 *   1,000 km planet). At the 100 km floor on a 1080p screen the selection reaches
 *   level 6 on its own: about 74 tiles there, 16 at the ceiling. The cap keeps
 *   larger screens from going deeper. Every level ≤ 7 is baked, so no tile needs the
 *   render detail noise.
 * - **Exaggeration.** Its own uniform, 4× by default (Part II), applied in the
 *   vertex shader as in the terrain renderer.
 * - **Its own caches.** TileData and meshes are cached apart from the simulation
 *   view's, with a smaller budget; only the active view loads tiles.
 * - **Shading.** The cartographic hillshade (hillshade.ts, decision 78) on the 4×
 *   normals, per fragment: flat ground keeps its fill color, slopes brighten or
 *   darken by the screen's upper-left light.
 * - **Palette.** Land takes the Part II biome fills from a blended cube-face texture
 *   (biomeFill.ts, decision 79), with steep rock on steep displayed slopes. Water has
 *   flat depth bands, a dark coastline and lake outlines (mapWater.ts, decision 82).
 * - **Patterns.** Forest stipple and farmland with its field grid (decision 80), dune
 *   ripples, tundra tussocks, ice cracks, wetland reeds and steep-rock hatching
 *   (decision 81), all from patterns.ts, anchored to the ground and sized on screen.
 *
 * Geomorphing works as in the terrain renderer, so splits do not pop.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute,
  float,
  Fn,
  If,
  fwidth,
  length,
  max,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  select,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import { Noise3 } from '../../core/noise';
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import { parentTile, TILE_STRIDE } from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import { Vec3d } from '../../core/vec3d';
import type { TileData, TileSynthesizer } from '../../worldgen/gpu/tileSynth';
import { MAX_BAKED_LEVEL } from '../../worldgen/gpu/tileSynth';
import { placeCameraRelative } from '../common/cameraRelative';
import { HabitabilityTexture } from '../common/habitabilityTexture';
import { BiomeFillTexture, hexToLinear, STEEP_ROCK_FILL } from './biomeFill';
import { CoastDistanceTexture } from './coastDistance';
import { mapWaterNode } from './mapWater';
import {
  crackNode,
  duneNode,
  gridNode,
  hatchNode,
  planeCoordsNode,
  reedNode,
  stippleNode,
  tussockNode,
} from './patterns';
import { DEFAULT_HILLSHADE, hillshadeNode } from './hillshade';
import { DEFAULT_LOD, selectTiles } from '../common/terrain/quadtree';
import type { LodOptions, LodView } from '../common/terrain/quadtree';
import { TileCache, TileLoader, TileRequestQueue } from '../common/terrain/tileCache';
import {
  buildTileIndex,
  buildTileMesh,
  dataTileFor,
  TILE_VERTEX_COUNT,
} from '../common/terrain/tileMesh';
import type { TileViewMode } from '../common/terrain/tileMesh';

/** Deepest tile level the map draws (see the header). */
export const STRATEGIC_MAX_LEVEL = 6;
/** Default relief exaggeration on the map (Part II, Base Map; tunable). */
export const STRATEGIC_EXAGGERATION = 4;
/** Tile memory for the map's caches (MiB): data and meshes. */
const DATA_BUDGET_MIB = 80;
const MESH_BUDGET_MIB = 120;

const DATA_BYTES = TILE_STRIDE * TILE_STRIDE * 8;
/** position, up, parentBase, parentDisp, slope, color (vec3) + surface (vec4), float32. */
const MESH_BYTES = TILE_VERTEX_COUNT * (6 * 3 + 4) * 4;
/** Part II farmland fill and field-grid line colors (decision 80). */
const FARM_FILL = hexToLinear(0xc9b57a);
const FARM_LINE = hexToLinear(0xb3a066);
/**
 * Forest stipple: dots of the canopy color times this (linear). Part II's stipple
 * colors are about 0.78 of their fills in sRGB for all three forest rows.
 */
const STIPPLE_DARKEN = 0.58;
/** Part II pattern marks (decision 81): dune ripples, tussocks, ice cracks, reeds, rock hatching. */
const DUNE_MARK = hexToLinear(0xc9aa7a);
const TUSSOCK_MARK = hexToLinear(0x99957c);
const CRACK_MARK = hexToLinear(0xc9d3d8);
const REED_MARK = hexToLinear(0x6f8366);
const HATCH_MARK = hexToLinear(0x7e766d);

export interface StrategicReliefWorld {
  synth: TileSynthesizer;
  seed: WorldSeed;
  radius: number;
  reliefScale: number;
  /** Biome per global cell and the global grid's cells per face edge, for the map palette. */
  biome: Uint8Array;
  biomeResolution: number;
  /** Global heights (m) on the same grid, for the coast distance (decision 83). */
  height: Float32Array;
}

export interface StrategicReliefStats {
  drawn: number;
  meshes: number;
  dataTiles: number;
  pending: number;
  deepest: number;
  visited: number;
}

export class StrategicRelief {
  readonly group = new Group();
  readonly stats: StrategicReliefStats = {
    drawn: 0,
    meshes: 0,
    dataTiles: 0,
    pending: 0,
    deepest: 0,
    visited: 0,
  };
  lod: LodOptions = { ...DEFAULT_LOD, maxLevel: STRATEGIC_MAX_LEVEL };
  /** Milliseconds per frame spent building meshes. */
  buildBudgetMs = 6;
  /** Relief exaggeration, applied in the vertex shader. */
  readonly exaggeration = uniform(STRATEGIC_EXAGGERATION);
  /** The camera's screen right, world frame (set by the scene each frame). */
  readonly screenRight = uniform(new Vector3(1, 0, 0));
  /** The camera's screen up, world frame (set by the scene each frame). */
  readonly screenUp = uniform(new Vector3(0, 1, 0));
  /** Hillshade settings (decision 78). */
  readonly hillshadeElevation = uniform(DEFAULT_HILLSHADE.elevation);
  readonly hillshadeStrength = uniform(DEFAULT_HILLSHADE.strength);
  /** Darkest a slope facing away from the light gets, relative to flat ground. */
  readonly ambient = uniform(DEFAULT_HILLSHADE.ambient);

  private world: StrategicReliefWorld | null = null;
  private mode: TileViewMode = 'biome';
  /** 1 in the biome view (map palette and water), 0 in debug color modes. */
  private readonly biomeMode = uniform(1);
  /** Part II land fills by direction, blended across biome boundaries (decision 79). */
  readonly biomeFill = new BiomeFillTexture();
  /** Sea-to-land distance for the coastal halo and lines (decision 83). */
  readonly coastDistance = new CoastDistanceTexture();
  /** Built on the map's first frame, so a hidden map costs nothing (about 0.6 s at 1024²). */
  private coastPending = false;
  /** The strategic graph's habitability, for farmland (decision 80). */
  readonly habitability = new HabitabilityTexture(null, 1);
  /** Camera eye, planet-centered (set by the scene each frame): patterns are anchored to the ground. */
  readonly eye = uniform(new Vector3());
  /** Field-grid visibility: the Theater and Region bands' fades (set by the scene). */
  readonly gridVisibility = uniform(0);
  /** The world's relief scale, for reference water depths (decision 14). */
  readonly reliefScale = uniform(1);
  /** 1 draws the map patterns (forest stipple, farmland), 0 hides them. */
  readonly patterns = uniform(1);
  private detail = new Noise3(rng(0, 'render-detail'));
  private readonly index = new BufferAttribute(buildTileIndex(), 1);
  private readonly material: MeshBasicNodeMaterial;
  private readonly data = new TileCache<TileData>(DATA_BUDGET_MIB * 2 ** 20);
  private readonly meshes = new TileCache<Mesh>(MESH_BUDGET_MIB * 2 ** 20, (e) => {
    this.group.remove(e.value);
    // The index buffer is shared by every tile: detach it before disposing.
    e.value.geometry.setIndex(null);
    e.value.geometry.dispose();
  });
  private readonly queue = new TileRequestQueue();
  private readonly loader: TileLoader<TileData>;
  private visible = new Set<Mesh>();

  constructor() {
    this.material = this.buildMaterial();
    this.loader = new TileLoader<TileData>(
      this.data,
      this.queue,
      async (tiles) => {
        const w = this.world;
        if (!w) return [];
        const out = await w.synth.generate(tiles);
        if (this.world !== w) return [];
        return out.map((d) => ({ tile: d.key, value: d, bytes: DATA_BYTES }));
      },
      8,
    );
  }

  private buildMaterial(): MeshBasicNodeMaterial {
    const morph = uniform(1).onObjectUpdate(
      ({ object }) => ((object as Mesh | undefined)?.userData.morph as number | undefined) ?? 1,
    );
    const material = new MeshBasicNodeMaterial();
    const ex = this.exaggeration;
    const up = attribute('up', 'vec3');
    // Packed per-vertex scalars: raw height, signed lake depth, forest density, coast
    // distance (decision 39).
    const surface = attribute('surface', 'vec4');
    const rawHeight = surface.x;
    const lakeDepth = surface.y;
    const forest = surface.z;
    const shore = surface.w;
    // Sea flat at 0 m and lakes flat at their level, as in the terrain renderer.
    const shown = max(rawHeight.add(max(lakeDepth, 0)), 0);
    const own = positionLocal.add(up.mul(shown.mul(ex)));
    const parent = attribute('parentBase', 'vec3').add(attribute('parentDisp', 'vec3').mul(ex));
    material.positionNode = mix(parent, own, morph);
    // Meshes carry no rotation or scale: object space is world space.
    const normal = normalize(up.sub(attribute('slope', 'vec3').mul(ex)));
    const radial = normalize(up);
    const slope = attribute('slope', 'vec3');
    const rgb = (c: readonly number[]) => vec3(c[0]!, c[1]!, c[2]!);
    const rock = rgb(hexToLinear(STEEP_ROCK_FILL));
    material.colorNode = Fn(() => {
      // Derivatives first, in uniform control flow: the pixel footprint (m per px)
      // sizes the patterns on screen (decision 80).
      const footprint = max(length(fwidth(positionWorld)), 1e-3).toVar();
      const plane = planeCoordsNode(positionWorld.add(this.eye), radial).toVar();
      // Water depth and its change per pixel, for the bands and outlines (decision 82):
      // reference depth, lake depth in lakes and sea depth elsewhere.
      const lakeWidth = max(fwidth(lakeDepth), 1e-3).toVar();
      const waterDepth = max(
        select(lakeDepth.greaterThan(0), lakeDepth, rawHeight.negate()),
        0,
      ).div(this.reliefScale);
      const depth = waterDepth.toVar();
      const depthWidth = fwidth(waterDepth).toVar();
      // Map palette: the blended biome fill, and steep rock where the displayed (4×)
      // slope passes about 31° to 45° (decision 79). Debug modes keep the vertex colors.
      const fill = this.biomeFill.sample(radial);
      const steep = smoothstep(0.6, 1.0, length(slope).mul(ex)).toVar();
      const open = steep.oneMinus().mul(this.patterns).toVar();
      const forestCover = smoothstep(0.35, 0.65, forest).toVar();
      // Farmland: farmable biomes (fill alpha) on settled land, outside forests and off
      // steep slopes, with the field grid from the Theater band down.
      const settled = smoothstep(0.25, 0.45, this.habitability.sample(radial));
      const farm = settled.mul(fill.a).mul(forestCover.oneMinus()).mul(open).toVar();
      const fields = mix(fill.rgb, rgb(FARM_FILL), farm);
      // Each pattern runs only where its mask is on: no derivatives below this point,
      // so branching per fragment is safe, and most pixels pay for one pattern or none.
      const masked = (mask: Node<'float'>, pattern: () => Node<'float'>) => {
        const out = float(0).toVar();
        If(mask.greaterThan(1e-3), () => {
          out.assign(pattern().mul(mask));
        });
        return out;
      };
      const grid = masked(farm.mul(this.gridVisibility), () => gridNode(plane, footprint));
      const farmed = mix(fields, rgb(FARM_LINE), grid);
      // Forest stipple: darker dots of the canopy color, at every band.
      const dots = masked(forestCover.mul(open), () => stippleNode(plane, footprint));
      const stippled = mix(farmed, farmed.mul(STIPPLE_DARKEN), dots);
      // Biome patterns by the blended masks (decision 81): dune ripples on sand desert,
      // tussocks on tundra, cracks on ice caps, reeds on wetlands.
      const masks = this.biomeFill.sampleMasks(radial);
      const dunes = masked(masks.x.mul(open), () => duneNode(plane, footprint));
      const tussocks = masked(masks.y.mul(open), () => tussockNode(plane, footprint));
      const cracks = masked(masks.z.mul(open), () => crackNode(plane, footprint));
      const reeds = masked(masks.w.mul(open), () => reedNode(plane, footprint));
      const marked = mix(
        mix(
          mix(mix(stippled, rgb(DUNE_MARK), dunes), rgb(TUSSOCK_MARK), tussocks),
          rgb(CRACK_MARK),
          cracks,
        ),
        rgb(REED_MARK),
        reeds,
      );
      // Steep rock with its hatching.
      const hatch = masked(steep.mul(this.patterns), () => hatchNode(plane, footprint));
      const mapLand = mix(mix(marked, rock, steep), rgb(HATCH_MARK), hatch);
      const land = mix(attribute('color', 'vec3'), mapLand, this.biomeMode);
      // Water: flat depth bands with a dark coastline and lake outlines (decision 82);
      // no relief light. Debug color modes show the vertex colors only.
      const water = mapWaterNode({
        lake: lakeDepth,
        lakeWidth,
        shore,
        footprint,
        depthWidth,
        depth,
        coastField: this.coastDistance.sample(radial),
      });
      const wet = water.wet.mul(this.biomeMode);
      const shade = hillshadeNode(normal, radial, {
        right: this.screenRight,
        up: this.screenUp,
        elevation: this.hillshadeElevation,
        strength: this.hillshadeStrength,
        ambient: this.ambient,
      });
      const surfaceColor = mix(land.mul(shade), water.color, wet);
      return mix(surfaceColor, water.outlineColor, water.outline.mul(this.biomeMode));
    })();
    return material;
  }

  get hasWorld(): boolean {
    return this.world !== null;
  }

  /** Shows a world (or nothing). Drops all cached tiles. */
  setWorld(world: StrategicReliefWorld | null): void {
    this.world = world;
    if (world) {
      this.biomeFill.setBiomes(world.biome, world.biomeResolution);
      this.reliefScale.value = world.reliefScale;
      this.coastPending = true;
    }
    this.detail = new Noise3(rng(world?.seed ?? 0, 'render-detail'));
    this.data.clear();
    this.meshes.clear();
    this.visible.clear();
  }

  /** Tile coloring (debug modes rebuild the meshes). */
  setMode(mode: TileViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.biomeMode.value = mode === 'biome' ? 1 : 0;
    this.meshes.clear();
    this.visible.clear();
  }

  private sources(t: TileKey): { data: TileData; parentData: TileData | null } | null {
    const data = this.data.get(dataTileFor(t));
    if (!data) return null;
    if (t.level === 0 || t.level > MAX_BAKED_LEVEL) return { data, parentData: null };
    const parentData = this.data.get(parentTile(t)!);
    return parentData ? { data, parentData } : null;
  }

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
    const surface = new Float32Array(TILE_VERTEX_COUNT * 4);
    for (let v = 0; v < TILE_VERTEX_COUNT; v++) {
      surface[v * 4] = m.height[v]!;
      surface[v * 4 + 1] = m.water[v]!;
      surface[v * 4 + 2] = m.forest[v]!;
      surface[v * 4 + 3] = m.shore[v]!;
    }
    g.setAttribute('surface', new BufferAttribute(surface, 4));
    g.setAttribute('parentBase', new BufferAttribute(m.parentBase, 3));
    g.setAttribute('parentDisp', new BufferAttribute(m.parentDisp, 3));
    g.setAttribute('slope', new BufferAttribute(m.slope, 3));
    g.setAttribute('color', new BufferAttribute(m.color, 3));
    g.setIndex(this.index);
    const mesh = new Mesh(g, this.material);
    mesh.frustumCulled = false;
    mesh.userData.origin = m.origin;
    mesh.userData.morph = 1;
    mesh.userData.minHeight = m.minHeight;
    mesh.userData.maxHeight = m.maxHeight;
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
    if (this.coastPending) {
      this.coastPending = false;
      const w = this.world;
      this.coastDistance.setHeights(w.height, w.biomeResolution, w.radius);
    }
    const x = this.exaggeration.value;
    const v: LodView = { ...view, exaggeration: x };
    this.data.beginFrame();
    this.meshes.beginFrame();
    const ready = (t: TileKey) => this.meshes.has(t);
    const heightRange = (t: TileKey): [number, number] | null => {
      const mesh = this.meshes.peek(t);
      if (!mesh) return null;
      const u = mesh.userData as { minHeight: number; maxHeight: number };
      return [Math.max(0, u.minHeight) * x, Math.max(0, u.maxHeight) * x];
    };
    let sel = selectTiles(v, ready, this.lod, heightRange);
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

    const now = new Set<Mesh>();
    let deepest = 0;
    for (const d of sel.draw) {
      const mesh = this.meshes.get(d.tile);
      if (!mesh) continue;
      this.sources(d.tile);
      placeCameraRelative(mesh, mesh.userData.origin as Vec3d, view.eye);
      mesh.userData.morph = d.morph;
      mesh.visible = true;
      now.add(mesh);
      deepest = Math.max(deepest, d.tile.level);
    }
    for (const m of this.visible) if (!now.has(m)) m.visible = false;
    this.visible = now;

    void this.loader.update();
    this.queue.beginFrame();
    this.meshes.evict();
    this.data.evict();

    const s = this.stats;
    s.drawn = now.size;
    s.meshes = this.meshes.size;
    s.dataTiles = this.data.size;
    s.pending = this.loader.pending;
    s.deepest = deepest;
    s.visited = sel.visited;
  }

  dispose(): void {
    this.setWorld(null);
    this.material.dispose();
    this.biomeFill.dispose();
    this.habitability.dispose();
    this.coastDistance.dispose();
  }
}
