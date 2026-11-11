/**
 * The strategic view's relief mesh (visual-style Part II, Base Map; decision 77).
 *
 * The same tiles as the simulation view's terrain: the quadtree selects by
 * screen-space error (sim/terrain/quadtree.ts), meshes come from
 * sim/terrain/tileMesh.ts and data from the world's TileSynthesizer. What differs:
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
 *   (biomeFill.ts, decision 79), with steep rock on steep displayed slopes. The sea is
 *   one flat water color until the water task of S1.
 *
 * Geomorphing works as in the terrain renderer, so splits do not pop.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import {
  attribute,
  Fn,
  length,
  max,
  mix,
  normalize,
  positionLocal,
  smoothstep,
  step,
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
import { BiomeFillTexture, hexToLinear, STEEP_ROCK_FILL } from './biomeFill';
import { DEFAULT_HILLSHADE, hillshadeNode } from './hillshade';
import { DEFAULT_LOD, selectTiles } from '../sim/terrain/quadtree';
import type { LodOptions, LodView } from '../sim/terrain/quadtree';
import { TileCache, TileLoader, TileRequestQueue } from '../sim/terrain/tileCache';
import {
  buildTileIndex,
  buildTileMesh,
  dataTileFor,
  TILE_VERTEX_COUNT,
} from '../sim/terrain/tileMesh';
import type { TileViewMode } from '../sim/terrain/tileMesh';

/** Deepest tile level the map draws (see the header). */
export const STRATEGIC_MAX_LEVEL = 6;
/** Default relief exaggeration on the map (Part II, Base Map; tunable). */
export const STRATEGIC_EXAGGERATION = 4;
/** Tile memory for the map's caches (MiB): data and meshes. */
const DATA_BUDGET_MIB = 80;
const MESH_BUDGET_MIB = 120;

const DATA_BYTES = TILE_STRIDE * TILE_STRIDE * 8;
/** position, up, parentBase, parentDisp, slope, color (vec3) + surface (vec2), float32. */
const MESH_BYTES = TILE_VERTEX_COUNT * (6 * 3 + 2) * 4;
/** Placeholder sea color until the water task: Part II mid-depth water. */
const WATER = new Color('#6C97AC');

export interface StrategicReliefWorld {
  synth: TileSynthesizer;
  seed: WorldSeed;
  radius: number;
  reliefScale: number;
  /** Biome per global cell and the global grid's cells per face edge, for the map palette. */
  biome: Uint8Array;
  biomeResolution: number;
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
    const surface = attribute('surface', 'vec2');
    const rawHeight = surface.x;
    const lakeDepth = surface.y;
    // Sea flat at 0 m and lakes flat at their level, as in the terrain renderer.
    const shown = max(rawHeight.add(max(lakeDepth, 0)), 0);
    const own = positionLocal.add(up.mul(shown.mul(ex)));
    const parent = attribute('parentBase', 'vec3').add(attribute('parentDisp', 'vec3').mul(ex));
    material.positionNode = mix(parent, own, morph);
    // Meshes carry no rotation or scale: object space is world space.
    const normal = normalize(up.sub(attribute('slope', 'vec3').mul(ex)));
    const radial = normalize(up);
    const slope = attribute('slope', 'vec3');
    const rock = hexToLinear(STEEP_ROCK_FILL);
    material.colorNode = Fn(() => {
      // Map palette: the blended biome fill, and steep rock where the displayed (4×)
      // slope passes about 31° to 45° (decision 79). Debug modes keep the vertex colors.
      const steep = smoothstep(0.6, 1.0, length(slope).mul(ex));
      const mapLand = mix(this.biomeFill.sample(radial), vec3(rock[0], rock[1], rock[2]), steep);
      const land = mix(attribute('color', 'vec3'), mapLand, this.biomeMode);
      // Water: at sea, and in lakes; flat, no relief light.
      const wet = max(step(rawHeight, 0), step(0, lakeDepth)).mul(this.biomeMode);
      const shade = hillshadeNode(normal, radial, {
        right: this.screenRight,
        up: this.screenUp,
        elevation: this.hillshadeElevation,
        strength: this.hillshadeStrength,
        ambient: this.ambient,
      });
      const water = vec3(WATER.r, WATER.g, WATER.b);
      return mix(land.mul(shade), water, wet);
    })();
    return material;
  }

  get hasWorld(): boolean {
    return this.world !== null;
  }

  /** Shows a world (or nothing). Drops all cached tiles. */
  setWorld(world: StrategicReliefWorld | null): void {
    this.world = world;
    if (world) this.biomeFill.setBiomes(world.biome, world.biomeResolution);
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
    const surface = new Float32Array(TILE_VERTEX_COUNT * 2);
    for (let v = 0; v < TILE_VERTEX_COUNT; v++) {
      surface[v * 2] = m.height[v]!;
      surface[v * 2 + 1] = m.water[v]!;
    }
    g.setAttribute('surface', new BufferAttribute(surface, 2));
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
  }
}
