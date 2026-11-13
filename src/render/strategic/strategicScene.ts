/**
 * The strategic view's scene (decision 72, visual-style Part II): an illustrated globe
 * from about 3,000 km down to a zoom floor of about 100 km. It has its own Three.js
 * scene and camera and stays resident beside the simulation view's GlobeScene; the app
 * renders whichever view is active (decision 74).
 *
 * The base map is the relief mesh (strategicRelief.ts, decision 77) once the world's
 * global pass exists; before that, the cell-grid globe (common/globeMesh.ts) at the
 * same 4× relief stands in. The relief has the cartographic hillshade (decision 78); the
 * fallback globe has a scene light fixed at the screen's upper left.
 * There is no physical sky, aerial perspective or atmosphere here (Part II), only a
 * flat background. Everything is placed camera-relative (common/cameraRelative.ts).
 */
import {
  AmbientLight,
  DirectionalLight,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { Cast } from '../../campaign/cast';
import type { CubeGrid } from '../../core/cubeGrid';
import type { WorldSeed } from '../../core/rng';
import { Vec3d } from '../../core/vec3d';
import type { World } from '../../worldgen/pipeline';
import type { StrategicGraph } from '../../worldgen/strategic/graph';
import type { Infrastructure } from '../../worldgen/strategic/infrastructure';
import { placePlanetCentered } from '../common/cameraRelative';
import { GlobeMesh } from '../common/globeMesh';
import type { ViewMode } from '../common/globeMesh';
import { attachOrbitInput } from '../common/orbitCamera';
import { StrategicCamera } from './strategicCamera';
import { STRATEGIC_EXAGGERATION, StrategicRelief } from './strategicRelief';
import type { StrategicReliefWorld } from './strategicRelief';
import { StrategicOverlay } from './strategicOverlay';
import { mapLightList, MapLights } from './mapLights';
import { backgroundNode } from './mapFinish';
import { graticuleStep, pickSphere, ringStep } from './graticule';
import type { WeatherField } from '../common/weatherField';
import { ZOOM_BANDS, ZoomBands } from './zoomBands';
import { GlyphLayer } from './glyphLayer';
import { drawOverlay, LabelLayer, SETTLE_TIME } from './labels/labelLayer';
import { buildLabels } from './labels/labelModel';
import { perspectiveView } from './labels/labelPlacement';
import type { LabelView } from './labels/labelPlacement';
import type { FontAtlas } from './labels/fontAtlas';
import { layoutGlyphs } from './glyphLayout';
import { CubeGrid as FeatureGrid } from '../../core/cubeGrid';
import { MilitaryLayer } from './overlays/militaryLayer';
import { buildMilitaryOverlays, OVERLAY_LAYERS } from './overlays/militaryModel';
import type { MilitaryOverlays, OverlayLayer } from './overlays/militaryModel';
import { Biome } from '../../worldgen/biomes';
import { buildInfraOverlays, INFRA_LAYERS } from './infra/infraModel';
import type { InfraLayer } from './infra/infraModel';
import { layoutCityGlyphs } from './infra/cityGlyphs';
import { SETTLEMENT_GLYPHS } from './glyphLayout';
import { AIR_LAYERS, buildAirOverlays } from './overlays/airModel';
import type { AirLayer, AirViewOptions } from './overlays/airModel';
import type { OverlayMark } from './overlays/militaryModel';

/** Extra reach around an icon's badge for a click to pick it (CSS px). */
const PICK_SLOP = 6;
import type { Mission } from '../../sim/air/mission';
import { carrierTrack } from '../../sim/naval/carrierGroup';
import type { CarrierTrack } from '../../sim/naval/carrierGroup';
import type { GameTime } from '../../core/units';

export interface StrategicSceneOptions {
  radius: number;
  grid: CubeGrid;
  /** Attach mouse and keyboard input to the canvas (default true; off for headless renders). */
  input?: boolean;
  /** The live cloud field for the map's weather (decision 89); none when absent. */
  weather?: WeatherField;
}

export class StrategicScene {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** Focus, altitude, heading; tilt follows the altitude (decision 75). */
  readonly orbit: StrategicCamera;
  /** Tiled relief mesh at 4× (decision 77); drawn once a terrain world is set. */
  readonly relief: StrategicRelief;
  private readonly weather: WeatherField | null;
  /** Fallback base map before the global pass: the cell-grid globe. */
  readonly globe: GlobeMesh;
  /** Draw the relief tiles when a terrain world exists (otherwise the cell-grid globe). */
  useTiles = true;
  /** Strategic graph debug overlay (a developer view, off by default). */
  readonly overlay: StrategicOverlay;
  /** Military overlays: front lines, defensive lines, corridors, sea lanes, chokepoints (decision 101). */
  readonly military: MilitaryLayer;
  /** The territory tint (GUI toggle; decision 101). */
  showTerritory = true;
  /**
   * Roads and railways (under the glyphs) and site symbols (over them): the map's
   * infrastructure, drawn like the military overlays (decision 104).
   */
  readonly infraLines: MilitaryLayer<InfraLayer>;
  readonly infraSites: MilitaryLayer<InfraLayer>;
  /** Flights, their trails and routes, and carrier groups (C2), moving with the game clock. */
  readonly air: MilitaryLayer<AirLayer>;
  /** What the air layer shows (decision 48: the side is a view). */
  readonly airView: AirViewOptions = { side: 'both', routes: false };
  /** Urban fills and settlement glyphs (GUI toggle; decision 104). */
  showTowns = true;
  /** Settlement, base and industry lights on the night side (decision 88). */
  readonly lights: MapLights;
  /** Mountains, hills, forest tokens and dunes (decision 97). */
  readonly glyphs: GlyphLayer;
  /** GUI toggle for the glyphs. */
  showGlyphs = true;
  /** Names on the map (decision 98); drawn once fonts are set. */
  readonly labels = new LabelLayer();
  /** GUI toggle for the labels. */
  showLabels = true;
  /** Drawn after the map without a tone curve, so labels keep their colors (decision 98). */
  private readonly overlayScene = new Scene();
  private viewportWidth = 1;
  private readonly lastEye = new Vec3d();
  private readonly lastForward = new Vec3d();
  /** Real time the camera has been still (s). */
  private stillTime = 0;
  /** Zoom band from the camera altitude, with fades and a change event (decision 76). */
  readonly bands: ZoomBands;
  /**
   * Each band's eased fade factor (0..1) for shaders: band content multiplies its
   * opacity by its band's factor, so it fades in and out with the band.
   */
  readonly bandFade = { globe: uniform(1), theater: uniform(0), region: uniform(0) };
  /** Unit vector toward the sun, world frame; set by the app from the ephemeris. */
  readonly sun = new Vec3d(1, 0.6, 0.8).normalize();
  private detachInput: (() => void) | null = null;
  private viewportHeight = 1;
  private readonly reliefLight = new DirectionalLight(0xffffff, 2.2);
  private readonly lightDir = new Vec3d();
  private readonly lightRight = new Vec3d();
  /** World and grid waiting to be built; applied on the next render, so a hidden view costs nothing. */
  private pendingGrid: CubeGrid | null = null;
  private pendingWorld: { world: World | null } | null = null;
  /** Valley floor for the climate texture, applied after any pending world (decision 122). */
  private pendingFloor: { floor: Float32Array | null } | null = null;
  /** The world and grid on display, and whether the lights need rebuilding. */
  private world: World | null = null;
  private grid: CubeGrid;
  private strategicData: {
    graph: StrategicGraph;
    cast: Cast | null;
    infra: Infrastructure | null;
  } | null = null;
  private lightsDirty = false;
  /** Missions from the sim and the cast's carrier tracks; the air layer redraws when these or the time change. */
  private missions: readonly Mission[] = [];
  private carriers: CarrierTrack[] = [];
  private airTime: GameTime = 0;
  private airDrawn: { time: GameTime; key: string } | null = null;
  private airRevision = 0;
  /** Raw terrain height (m, 0 at sea) for draping, once the world is on display. */
  private dryHeight: ((p: Readonly<[number, number, number]>) => number) | null = null;
  /** The air icons last drawn (for picking), and the selected one. */
  private airMarks: OverlayMark<AirLayer>[] = [];
  private airSelection: string | null = null;
  /** Called when a click selects or clears a flight or carrier. */
  onAirSelect: ((key: string | null) => void) | null = null;
  /** Called with the ground point (unit direction) a click selected, e.g. to pick an airbase. */
  onGroundPick: ((dir: Readonly<Vec3d>) => void) | null = null;
  private coarse: CubeGrid | null = null;
  /** Background rim uniforms: planet center relative to the camera, radians per pixel. */
  private readonly planetCenter = uniform(new Vector3());
  private readonly pixelAngle = uniform(0.001);
  /** Graticule and range rings (GUI toggles), and the selected point for the rings. */
  showGraticule = false;
  showRings = true;
  selection: Vec3d | null = null;

  constructor(
    private readonly renderer: WebGPURenderer,
    options: StrategicSceneOptions,
  ) {
    this.camera = new PerspectiveCamera(45, 1, 1, 2);
    this.weather = options.weather ?? null;
    this.relief = new StrategicRelief(this.weather);
    this.orbit = new StrategicCamera(options.radius);
    this.bands = new ZoomBands(this.orbit.altitude);
    for (const b of ZOOM_BANDS) this.bandFade[b].value = this.bands.fade(b);
    this.globe = new GlobeMesh(options.grid, options.radius);
    this.globe.setExaggeration(STRATEGIC_EXAGGERATION);
    this.overlay = new StrategicOverlay(options.radius);
    this.overlay.enabled = false;
    this.military = new MilitaryLayer(options.radius, { exaggeration: this.relief.exaggeration });
    const infraUniforms = {
      exaggeration: this.relief.exaggeration,
      daylight: {
        sunDirection: this.relief.sunDirection,
        nightStrength: this.relief.nightStrength,
        twilightStrength: this.relief.twilightStrength,
      },
    };
    // Roads and railways draw before the glyphs and night lights; symbols after them.
    this.infraLines = new MilitaryLayer<InfraLayer>(options.radius, infraUniforms, {
      layers: INFRA_LAYERS.filter((l) => l !== 'sites'),
      renderOrder: -10,
    });
    this.infraSites = new MilitaryLayer<InfraLayer>(options.radius, infraUniforms, {
      layers: ['sites'],
      renderOrder: 12,
    });
    // Above the military overlays: flights cross the front.
    this.air = new MilitaryLayer<AirLayer>(
      options.radius,
      { exaggeration: this.relief.exaggeration },
      { layers: AIR_LAYERS, renderOrder: 60 },
    );
    this.lights = new MapLights(options.radius, this.relief.exaggeration);
    this.glyphs = new GlyphLayer(options.radius, {
      exaggeration: this.relief.exaggeration,
      sunDirection: this.relief.sunDirection,
      nightStrength: this.relief.nightStrength,
      twilightStrength: this.relief.twilightStrength,
      finish: this.relief.finish,
      bandFade: { theater: this.bandFade.theater, region: this.bandFade.region },
    });
    this.grid = options.grid;
    // Flat background with a thin pale rim around the globe, finished like the map
    // (decision 92); Part II has no physical sky.
    this.scene.backgroundNode = backgroundNode({
      center: this.planetCenter,
      radius: options.radius,
      pixelAngle: this.pixelAngle,
      strength: this.relief.finish,
    });
    this.scene.add(
      this.globe.group,
      this.relief.group,
      this.glyphs.group,
      this.overlay.group,
      this.lights.group,
      this.infraLines.group,
      this.infraSites.group,
      this.military.group,
      this.air.group,
    );
    this.overlayScene.add(this.labels.group);
    this.scene.add(this.reliefLight, new AmbientLight(0xffffff, 0.55));
    this.inputEnabled = options.input !== false;
  }

  /** Whether mouse, touch and keyboard drive this scene's camera (only the active view listens). */
  get inputEnabled(): boolean {
    return this.detachInput !== null;
  }

  set inputEnabled(on: boolean) {
    if (on === this.inputEnabled) return;
    if (on) {
      const detachOrbit = attachOrbitInput(
        this.renderer.domElement,
        this.orbit,
        () => (this.camera.fov * Math.PI) / 180 / this.viewportHeight,
      );
      const detachSelect = this.attachSelection(this.renderer.domElement);
      this.detachInput = () => {
        detachOrbit();
        detachSelect();
      };
    } else {
      this.detachInput!();
      this.detachInput = null;
    }
  }

  /**
   * Selection (decisions 91, 133): a click (press and release within 5 px and 400 ms,
   * so drags still pan) selects the flight or carrier under the cursor, or else the
   * ground point for the range rings; Escape clears both.
   */
  private attachSelection(el: HTMLElement): () => void {
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      if (performance.now() - d.t > 400) return;
      const rect = el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      // A flight or carrier under the cursor wins over the ground (decision 133).
      const icon = this.pickIcon(x, y);
      this.airSelected = icon;
      if (!icon) this.selectAt(x, y);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        this.selection = null;
        this.airSelected = null;
      }
    };
    // A pointer over an icon shows that it can be clicked (mouse only; no buttons held).
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
      const rect = el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      el.style.cursor = this.pickIcon(x, y) ? 'pointer' : '';
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey);
      el.style.cursor = '';
    };
  }

  /** Selects the ground point at normalized device coordinates (x, y in −1..1), or clears it. */
  selectAt(x: number, y: number): void {
    const o = this.orbit;
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    const right = o.forward.clone().cross(o.up);
    const dir = o.forward
      .clone()
      .addScaled(right, x * t * this.camera.aspect)
      .addScaled(o.up, y * t)
      .normalize();
    this.selection = pickSphere(o.eye, dir, o.radius);
    if (this.selection) this.onGroundPick?.(this.selection);
  }

  setGrid(grid: CubeGrid): void {
    this.pendingGrid = grid;
  }

  /** The world to draw; built lazily on the next render. */
  setWorld(world: World | null): void {
    this.pendingWorld = { world };
  }

  setFaceSeed(seed: WorldSeed): void {
    this.globe.setFaceSeed(seed);
  }

  setViewMode(mode: ViewMode): void {
    this.globe.setViewMode(mode);
  }

  /** Valley floor per tectonic cell (physical m) for the snow line (decision 122). */
  setValleyFloor(floor: Float32Array | null): void {
    this.pendingFloor = { floor };
  }

  /** The world's tiles for the relief mesh (null until the global pass, or for none). */
  setTerrainWorld(world: StrategicReliefWorld | null): void {
    this.relief.setWorld(world);
  }

  /** Strategic graph, cast and infrastructure for the overlay. */
  setStrategic(
    graph: StrategicGraph | null,
    cast: Cast | null,
    infrastructure: Infrastructure | null,
  ): void {
    this.overlay.setWorld(graph, cast, infrastructure);
    // Farmland lies on settled land (decision 80).
    this.relief.habitability.set(graph?.habitability ?? null, graph?.resolution ?? 1);
    // The territory tint (decision 101), on the graph's coarse grid.
    const territoryGrid = graph && infrastructure ? this.coarseGrid(graph.resolution) : null;
    this.relief.territory.set(infrastructure?.territory ?? null, territoryGrid);
    // Urban extents for the urban fill (decision 104).
    this.relief.urban.set(graph?.urban ?? null);
    this.strategicData = graph ? { graph, cast, infra: infrastructure } : null;
    this.carriers =
      graph && cast ? (cast.carriers ?? []).map((c) => carrierTrack(c, graph.radius)) : [];
    this.missions = [];
    this.airRevision++;
    this.lightsDirty = true;
  }

  /** The sim's live missions (both sides; the air view filters). */
  setMissions(missions: readonly Mission[]): void {
    this.missions = missions;
    this.airRevision++;
  }

  /** Game time the air layer shows (the display clock). */
  setAirTime(t: GameTime): void {
    this.airTime = t;
  }

  /** Shows or hides flights, trails, routes or carriers. */
  setAirVisible(layer: AirLayer, on: boolean): void {
    this.air.visible[layer] = on;
  }

  /** Rebuilds the air layer when the time, the missions or the view changed. */
  private updateAir(): void {
    const height = this.dryHeight;
    if (!height) return;
    this.airView.selected = this.airSelection;
    const v = this.airView;
    const key = `${this.airRevision}:${v.side}:${v.routes}:${v.selected}`;
    if (this.airDrawn && this.airDrawn.time === this.airTime && this.airDrawn.key === key) return;
    this.airDrawn = { time: this.airTime, key };
    const radius = this.strategicData?.graph.radius ?? 1;
    const overlays = buildAirOverlays(this.missions, this.carriers, this.airTime, radius, v);
    this.airMarks = overlays.marks;
    this.air.updateOverlays(overlays, height);
  }

  /**
   * The flight or carrier icon under normalized device coordinates (x, y in −1..1),
   * within its badge plus PICK_SLOP px, nearest first; null if none (decision 133).
   */
  pickIcon(x: number, y: number): string | null {
    const height = this.dryHeight;
    if (!height) return null;
    const o = this.orbit;
    const tan = Math.tan((this.camera.fov * Math.PI) / 360);
    const right = o.forward.clone().cross(o.up);
    const radius = o.radius;
    const ex = this.relief.exaggeration.value;
    const w = this.viewportWidth / 2;
    const h = this.viewportHeight / 2;
    const p = new Vec3d();
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const m of this.airMarks) {
      if (!m.key || !this.air.visible[m.layer]) continue;
      const r = radius + Math.max(0, height(m.point)) * ex + 300;
      p.set(m.point[0] * r, m.point[1] * r, m.point[2] * r);
      // Beyond the horizon: the point faces away from the eye.
      if (
        m.point[0] * (o.eye.x - p.x) + m.point[1] * (o.eye.y - p.y) + m.point[2] * (o.eye.z - p.z) <
        0
      )
        continue;
      p.sub(o.eye);
      const z = p.dot(o.forward);
      if (z <= 0) continue;
      const sx = p.dot(right) / (z * tan * this.camera.aspect);
      const sy = p.dot(o.up) / (z * tan);
      const d = Math.hypot((sx - x) * w, (sy - y) * h);
      const reach = (m.badge?.size ?? m.length) / 2 + PICK_SLOP;
      if (d <= reach && d < bestDistance) {
        bestDistance = d;
        best = m.key;
      }
    }
    return best;
  }

  /** The selected flight or carrier ("mission:<id>", "carrier:<id>"), or null. */
  get airSelected(): string | null {
    return this.airSelection;
  }

  set airSelected(key: string | null) {
    if (key === this.airSelection) return;
    this.airSelection = key;
    this.onAirSelect?.(key);
  }

  /** The graph's coarse grid (the display grid when they match), built once per resolution. */
  private coarseGrid(n: number): CubeGrid {
    if (this.grid.n === n) return this.grid;
    if (this.coarse?.n !== n) this.coarse = new FeatureGrid(n);
    return this.coarse;
  }

  /** The cast's military overlays; the territory raster puts the front's teeth on the attacker's side. */
  private militaryOverlays(
    graph: StrategicGraph,
    cast: Cast | null,
    infra: Infrastructure | null,
  ): MilitaryOverlays {
    const grid = infra ? this.coarseGrid(graph.resolution) : null;
    const dir = new Vec3d();
    const territory =
      infra && grid && infra.territory.length === grid.cellCount
        ? {
            ownerAt: (p: Readonly<[number, number, number]>) =>
              infra.territory[grid.cellOfDirection(dir.set(p[0], p[1], p[2]))]!,
            cellAngle: Math.PI / 2 / grid.n,
          }
        : null;
    return buildMilitaryOverlays(graph, cast, territory);
  }

  /** Shows or hides roads, railways or site symbols (decision 104); route names go with roads. */
  setInfraVisible(layer: InfraLayer, on: boolean): void {
    this.infraLines.visible[layer] = on;
    this.infraSites.visible[layer] = on;
    this.updateHiddenLabels();
  }

  private updateHiddenLabels(): void {
    this.labels.setHidden([
      ...OVERLAY_LAYERS.filter((l) => !this.military.visible[l]),
      ...(this.infraLines.visible.roads ? [] : ['roads']),
    ]);
  }

  /** Shows or hides an overlay layer, its labels with it (decision 101). */
  setLayerVisible(layer: OverlayLayer, on: boolean): void {
    this.military.visible[layer] = on;
    this.updateHiddenLabels();
  }

  /** The label fonts' atlas (fontAtlas.ts); labels draw once it is set. */
  setLabelFonts(atlas: FontAtlas): void {
    this.labels.setFonts(atlas);
  }

  resize(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
    this.labels.invalidate();
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Advances camera easing and renders one frame. `dt` is real seconds since the last frame. */
  render(dt: number): void {
    if (this.pendingGrid) {
      if (this.pendingGrid.n !== this.globe.resolution) this.globe.setGrid(this.pendingGrid);
      this.grid = this.pendingGrid;
      this.pendingGrid = null;
    }
    if (this.pendingWorld) {
      this.globe.setWorld(this.pendingWorld.world);
      // Climate for the seasonal snow line, sea ice and lake ice (decision 87).
      if (this.pendingWorld.world) this.relief.climate.setWorld(this.pendingWorld.world);
      this.world = this.pendingWorld.world;
      this.pendingWorld = null;
    }
    if (this.pendingFloor) {
      this.relief.climate.setValleyFloor(this.pendingFloor.floor);
      this.pendingFloor = null;
      this.lightsDirty = true;
    }
    if (this.lightsDirty) {
      // Lights sit on the world's terrain: build them once the graph and world agree.
      this.lightsDirty = false;
      const d = this.strategicData;
      const w = this.world;
      if (d && w && w.info.resolution === this.grid.n) {
        const grid = this.grid;
        const dir = new Vec3d();
        this.lights.setLights(
          mapLightList(
            d.graph,
            d.infra,
            (x, y, z) => w.maps.height[grid.cellOfDirection(dir.set(x, y, z))]!,
          ),
        );
        const heightAt = (p: Readonly<[number, number, number]>) =>
          w.maps.height[grid.cellOfDirection(dir.set(p[0], p[1], p[2]))]!;
        const capitals = d.infra ? [d.infra.capitals.alliance, d.infra.capitals.pact] : [];
        this.glyphs.setGlyphs([
          ...glyphSets(d.graph, w, grid),
          ...layoutCityGlyphs(d.graph.settlements, capitals, (x, y, z) => heightAt([x, y, z])),
        ]);
        const military = this.militaryOverlays(d.graph, d.cast, d.infra);
        const dry = (p: Readonly<[number, number, number]>) => Math.max(0, heightAt(p));
        this.dryHeight = dry;
        this.airDrawn = null;
        this.military.setOverlays(military, dry);
        const infra = buildInfraOverlays(d.graph, d.infra);
        this.infraLines.setOverlays(infra, dry);
        this.infraSites.setOverlays(infra, dry);
        this.labels.setLabels(buildLabels(d.graph, d.cast, heightAt, military, d.infra));
      } else {
        this.lights.setLights(null);
        this.glyphs.setGlyphs(null);
        this.military.setOverlays(null, () => 0);
        this.infraLines.setOverlays(null, () => 0);
        this.infraSites.setOverlays(null, () => 0);
        this.air.setOverlays(null, () => 0);
        this.dryHeight = null;
        this.labels.setLabels(null);
      }
    }

    const o = this.orbit;
    o.terrainMaxHeight = this.globe.maxDisplayedHeight;
    o.update(dt);
    this.bands.update(o.altitude, dt);
    for (const b of ZOOM_BANDS) this.bandFade[b].value = this.bands.fade(b);

    // Camera at the origin, oriented from float64 vectors.
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(o.up.x, o.up.y, o.up.z);
    this.camera.lookAt(o.forward.x, o.forward.y, o.forward.z);
    this.camera.near = o.near;
    this.camera.far = o.far;
    this.camera.updateProjectionMatrix();

    // Relief light from the screen's upper left, toward the viewer: it turns with the
    // camera and never with the sun, so ranges always read the same way (Part II).
    const right = this.lightRight.copy(o.forward).cross(o.up);
    this.lightDir
      .set(0, 0, 0)
      .addScaled(right, -1)
      .addScaled(o.up, 1)
      .addScaled(o.forward, -0.8)
      .normalize();
    this.reliefLight.position.set(this.lightDir.x, this.lightDir.y, this.lightDir.z);
    // The hillshade light comes from the screen's upper left at every point (decision 78).
    this.relief.screenRight.value.set(right.x, right.y, right.z);
    this.relief.screenUp.value.set(o.up.x, o.up.y, o.up.z);
    // Patterns are anchored to the ground (decision 80); the field grid shows from the
    // Theater band down, fading with the bands.
    this.relief.eye.value.set(o.eye.x, o.eye.y, o.eye.z);
    // The ephemeris sun decides day and night on the map (decision 87).
    this.relief.sunDirection.value.set(this.sun.x, this.sun.y, this.sun.z);
    // Map scale at the screen center, in drawing-buffer pixels like the shader's
    // derivatives: the coastal halo and lines are placed with it (decision 85).
    const fovY = (this.camera.fov * Math.PI) / 180;
    const pixelAngle = fovY / (this.viewportHeight * this.renderer.getPixelRatio());
    this.pixelAngle.value = pixelAngle;
    this.planetCenter.value.set(-o.eye.x, -o.eye.y, -o.eye.z);
    this.relief.mapScale.value = o.range * pixelAngle;
    // Graticule spacing and range rings from the map scale (decision 91).
    const scale = this.relief.mapScale.value;
    this.relief.graticuleStep.value = graticuleStep(scale, o.radius);
    this.relief.graticuleOn.value = this.showGraticule ? 1 : 0;
    this.relief.ringStep.value = ringStep(scale);
    const sel = this.selection;
    this.relief.ringsOn.value = this.showRings && sel ? 1 : 0;
    if (sel) this.relief.ringCenter.value.set(sel.x, sel.y, sel.z);
    // Night lights: sized in pixels, facing the screen, as strong as the night tint.
    this.lights.update(o.eye, this.sun, pixelAngle, right, o.up);
    this.lights.strength.value = this.relief.nightStrength.value;
    this.relief.belowGlobe.value = this.bands.fade('theater') + this.bands.fade('region');

    const tiles = this.useTiles && this.relief.hasWorld;
    this.globe.group.visible = !tiles;
    this.relief.group.visible = tiles;
    placePlanetCentered(this.globe.group, o.eye);
    if (tiles) {
      this.relief.update({
        eye: o.eye,
        forward: o.forward,
        up: o.up,
        fovY: (this.camera.fov * Math.PI) / 180,
        aspect: this.camera.aspect,
        viewportHeight: this.viewportHeight,
        radius: o.radius,
        maxHeight: this.globe.maxDisplayedHeight,
      });
    }
    this.overlay.update(o.eye, this.globe.maxDisplayedHeight + 2000);
    // Military overlays in CSS pixels, like the labels (decision 101).
    const cssPixelAngle = fovY / this.viewportHeight;
    this.relief.territoryOn.value = this.showTerritory ? 1 : 0;
    const fades = {
      globe: this.bands.fade('globe'),
      theater: this.bands.fade('theater'),
      region: this.bands.fade('region'),
    };
    this.military.update(o.eye, cssPixelAngle, o.range * cssPixelAngle, fades);
    this.infraLines.update(o.eye, cssPixelAngle, o.range * cssPixelAngle, fades, o.up);
    this.infraSites.update(o.eye, cssPixelAngle, o.range * cssPixelAngle, fades, o.up);
    this.updateAir();
    this.air.update(o.eye, cssPixelAngle, o.range * cssPixelAngle, fades, o.up);
    this.relief.urbanOn.value = this.showTowns ? 1 : 0;
    for (const k of SETTLEMENT_GLYPHS) {
      if (this.showTowns) this.glyphs.hidden.delete(k);
      else this.glyphs.hidden.add(k);
    }
    this.glyphs.group.visible = this.showGlyphs;
    this.glyphs.update(o.eye, {
      theater: this.bands.fade('theater'),
      region: this.bands.fade('region'),
    });
    // Labels: the collision pass runs once the camera has been still for a moment.
    const moved =
      this.lastEye.distanceTo(o.eye) > 1e-4 * o.altitude ||
      this.lastForward.distanceTo(o.forward) > 1e-5;
    this.stillTime = moved ? 0 : this.stillTime + Math.max(0, dt);
    if (moved) this.labels.invalidate();
    this.lastEye.copy(o.eye);
    this.lastForward.copy(o.forward);
    this.labels.group.visible = this.showLabels;
    this.labels.update(
      this.labelView(),
      this.bands.band,
      (b) => this.bands.fade(b),
      dt,
      this.stillTime >= SETTLE_TIME,
    );
    // Weather moves with game time: re-bake the cloud field while the map is on screen.
    this.weather?.bake(this.renderer, performance.now());
    // No tone curve on the map (Part II, decision 99): the simulation view's AgX would
    // lift the dark background and pale every Part II color. Restored for that view.
    const toneMapping = this.renderer.toneMapping;
    this.renderer.toneMapping = NoToneMapping;
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.toneMapping = toneMapping;
    }
    if (this.showLabels && this.labels.hasFonts)
      drawOverlay(this.renderer, this.overlayScene, this.camera);
  }

  /** Screen projection for labels (CSS px), matching the camera this frame. */
  private labelView(): LabelView {
    const o = this.orbit;
    return perspectiveView({
      eye: o.eye,
      forward: o.forward,
      up: o.up,
      fovY: (this.camera.fov * Math.PI) / 180,
      width: this.viewportWidth,
      height: this.viewportHeight,
      near: o.near,
      radius: o.radius,
      exaggeration: this.relief.exaggeration.value,
    });
  }

  dispose(): void {
    this.inputEnabled = false;
    this.globe.dispose();
    this.relief.dispose();
    this.overlay.dispose();
    this.military.dispose();
    this.infraLines.dispose();
    this.infraSites.dispose();
    this.air.dispose();
    this.lights.dispose();
    this.glyphs.dispose();
    this.labels.dispose();
  }
}

/**
 * Glyph instances for a graph on a world's display maps (decision 97). The features
 * live on the graph's coarse grid; heights, temperature, biome and wind come from the
 * world's maps, looked up by direction when the two grids differ.
 */
function glyphSets(graph: StrategicGraph, w: World, grid: CubeGrid) {
  const fgrid = graph.resolution === grid.n ? grid : new FeatureGrid(graph.resolution);
  const m = w.maps;
  const dir = new Vec3d();
  const cellAt = (x: number, y: number, z: number) => grid.cellOfDirection(dir.set(x, y, z));
  const worldCell = (c: number) =>
    fgrid === grid
      ? c
      : cellAt(fgrid.centers[c * 3]!, fgrid.centers[c * 3 + 1]!, fgrid.centers[c * 3 + 2]!);
  return layoutGlyphs({
    features: graph.features,
    grid: fgrid,
    radius: graph.radius,
    reliefScale: w.info.reliefScale,
    heightAt: (x, y, z) => m.height[cellAt(x, y, z)]!,
    // Snow caps where the annual mean is below freezing at the glyph's point.
    snowAt: (x, y, z) => m.temperature[cellAt(x, y, z)]! < 0,
    sandAt: (c) => m.biome[worldCell(c)] === Biome.HotDesert,
    windAt: (c) => {
      const k = worldCell(c);
      const e = m.windEast[k]!;
      const n = m.windNorth[k]!;
      return e === 0 && n === 0 ? null : Math.atan2(n, e);
    },
  });
}
