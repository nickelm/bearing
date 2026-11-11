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
import { AmbientLight, Color, DirectionalLight, PerspectiveCamera, Scene } from 'three/webgpu';
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
import type { WeatherField } from '../common/weatherField';
import { ZOOM_BANDS, ZoomBands } from './zoomBands';

/** Flat background behind the globe; Part II has no physical sky. */
const BACKGROUND = new Color('#1E2630');

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
  /** Strategic graph and cast overlay. */
  readonly overlay: StrategicOverlay;
  /** Settlement, base and industry lights on the night side (decision 88). */
  readonly lights: MapLights;
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
  /** The world and grid on display, and whether the lights need rebuilding. */
  private world: World | null = null;
  private grid: CubeGrid;
  private strategicData: { graph: StrategicGraph; infra: Infrastructure | null } | null = null;
  private lightsDirty = false;

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
    this.lights = new MapLights(options.radius, this.relief.exaggeration);
    this.grid = options.grid;
    this.scene.background = BACKGROUND;
    this.scene.add(this.globe.group, this.relief.group, this.overlay.group, this.lights.group);
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
      this.detachInput = attachOrbitInput(
        this.renderer.domElement,
        this.orbit,
        () => (this.camera.fov * Math.PI) / 180 / this.viewportHeight,
      );
    } else {
      this.detachInput!();
      this.detachInput = null;
    }
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
    this.strategicData = graph ? { graph, infra: infrastructure } : null;
    this.lightsDirty = true;
  }

  resize(width: number, height: number): void {
    this.viewportHeight = Math.max(1, height);
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
      } else {
        this.lights.setLights(null);
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
    this.relief.mapScale.value = o.range * pixelAngle;
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
    // Weather moves with game time: re-bake the cloud field while the map is on screen.
    this.weather?.bake(this.renderer, performance.now());
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.inputEnabled = false;
    this.globe.dispose();
    this.relief.dispose();
    this.overlay.dispose();
    this.lights.dispose();
  }
}
