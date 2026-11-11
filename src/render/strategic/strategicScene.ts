/**
 * The strategic view's scene (decision 72, visual-style Part II): an illustrated globe
 * from about 3,000 km down to a zoom floor of about 100 km. It has its own Three.js
 * scene and camera and stays resident beside the simulation view's GlobeScene; the app
 * renders whichever view is active (decision 74).
 *
 * This is the S1 skeleton. Until the S1 base-map tasks replace them:
 *   - the base map is the cell-grid globe (common/globeMesh.ts) at 4× relief;
 *   - a scene light fixed at the screen's upper left stands in for the hillshade.
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
import { StrategicOverlay } from './strategicOverlay';
import { ZOOM_BANDS, ZoomBands } from './zoomBands';

/** Relief exaggeration on the map (Part II, Base Map; tunable). */
export const STRATEGIC_EXAGGERATION = 4;

/** Flat background behind the globe; Part II has no physical sky. */
const BACKGROUND = new Color('#1E2630');

export interface StrategicSceneOptions {
  radius: number;
  grid: CubeGrid;
  /** Attach mouse and keyboard input to the canvas (default true; off for headless renders). */
  input?: boolean;
}

export class StrategicScene {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** Focus, altitude, heading; tilt follows the altitude (decision 75). */
  readonly orbit: StrategicCamera;
  /** Placeholder base map: the cell-grid globe with exaggerated relief. */
  readonly globe: GlobeMesh;
  /** Strategic graph and cast overlay. */
  readonly overlay: StrategicOverlay;
  /** Zoom band from the camera altitude, with fades and a change event (decision 76). */
  readonly bands: ZoomBands;
  /**
   * Each band's eased fade factor (0..1) for shaders: band content multiplies its
   * opacity by its band's factor, so it fades in and out with the band.
   */
  readonly bandFade = { globe: uniform(1), theater: uniform(0), region: uniform(0) };
  /** Unit vector toward the sun, world frame. Unused until day and night reach the map. */
  readonly sun = new Vec3d(1, 0.6, 0.8).normalize();
  private detachInput: (() => void) | null = null;
  private viewportHeight = 1;
  private readonly reliefLight = new DirectionalLight(0xffffff, 2.2);
  private readonly lightDir = new Vec3d();
  private readonly lightRight = new Vec3d();
  /** World and grid waiting to be built; applied on the next render, so a hidden view costs nothing. */
  private pendingGrid: CubeGrid | null = null;
  private pendingWorld: { world: World | null } | null = null;

  constructor(
    private readonly renderer: WebGPURenderer,
    options: StrategicSceneOptions,
  ) {
    this.camera = new PerspectiveCamera(45, 1, 1, 2);
    this.orbit = new StrategicCamera(options.radius);
    this.bands = new ZoomBands(this.orbit.altitude);
    for (const b of ZOOM_BANDS) this.bandFade[b].value = this.bands.fade(b);
    this.globe = new GlobeMesh(options.grid, options.radius);
    this.globe.setExaggeration(STRATEGIC_EXAGGERATION);
    this.overlay = new StrategicOverlay(options.radius);
    this.scene.background = BACKGROUND;
    this.scene.add(this.globe.group, this.overlay.group);
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

  /** Strategic graph, cast and infrastructure for the overlay. */
  setStrategic(
    graph: StrategicGraph | null,
    cast: Cast | null,
    infrastructure: Infrastructure | null,
  ): void {
    this.overlay.setWorld(graph, cast, infrastructure);
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
      this.pendingGrid = null;
    }
    if (this.pendingWorld) {
      this.globe.setWorld(this.pendingWorld.world);
      this.pendingWorld = null;
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

    placePlanetCentered(this.globe.group, o.eye);
    this.overlay.update(o.eye, this.globe.maxDisplayedHeight + 2000);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.inputEnabled = false;
    this.globe.dispose();
    this.overlay.dispose();
  }
}
