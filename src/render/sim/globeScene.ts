/**
 * The simulation view's scene (decision 72): the M1 debug cube-sphere, the tiled terrain,
 * the sun and two cameras, rendered camera-relative (see common/cameraRelative.ts):
 *
 * - the **observer camera** at a base or port (V1), the simulation view's own, from the
 *   ground to 20 km;
 * - the **free camera**, the old orbit camera from orbit down to 500 m, kept as a
 *   development tool until V4 (decision 72; the app offers it behind a dev flag);
 * - the **chase camera** behind the aircraft flown in Free Flight (decision 134).
 */
import {
  AgXToneMapping,
  AmbientLight,
  DirectionalLight,
  Group,
  PerspectiveCamera,
  Scene,
} from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { placePlanetCentered } from '../common/cameraRelative';
import type { CubeGrid } from '../../core/cubeGrid';
import { DEG } from '../../core/units';
import { Vec3d } from '../../core/vec3d';
import { ObserverCamera } from './camera/observerCamera';
import { ChaseCamera } from './camera/chaseCamera';
import { ClimateTexture } from '../common/climateTexture';
import { CloudLayer } from './clouds/cloudLayer';
import { WeatherTexture } from './clouds/weatherTexture';
import { ForestLayer } from './forest/forestLayer';
import { GlobeMesh } from '../common/globeMesh';
import { PlanetLighting } from './lighting/planetLighting';
import { TerrainRenderer } from './terrain/terrainRenderer';
import { MotionEstimate } from '../common/terrain/prefetch';
import { OrbitCamera, attachOrbitInput } from '../common/orbitCamera';
import { StrategicOverlay } from '../strategic/strategicOverlay';
import { StructureLayer } from './infra/structureLayer';
import type { InfraScene } from './infra/infraScene';

export type SimCameraMode = 'observer' | 'free' | 'chase';

/** What the scene reads from either camera each frame. */
interface ViewCamera {
  readonly eye: Vec3d;
  readonly forward: Vec3d;
  readonly up: Vec3d;
  near: number;
  far: number;
}

export interface GlobeSceneOptions {
  radius: number;
  grid: CubeGrid;
  /** Attach mouse and keyboard input to the canvas (default true; off for headless renders). */
  input?: boolean;
}

export class GlobeScene {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** The free (debug) camera. */
  readonly orbit: OrbitCamera;
  /** The observer camera at a base or port (V1). */
  readonly observer: ObserverCamera;
  /** The chase camera behind a flown aircraft (Free Flight, decision 134); its input is the app's. */
  readonly chase: ChaseCamera;
  /** Aircraft and other vehicles, placed camera-relative by their owners in `beforeDraw`. */
  readonly vehicles = new Group();
  /**
   * Called each frame once the camera has moved, before drawing, with the eye:
   * where vehicle owners place their objects camera-relative (rule 4).
   */
  beforeDraw: ((eye: Readonly<Vec3d>) => void) | null = null;
  readonly globe: GlobeMesh;
  /** Sun and camera uniforms shared by every lit planet material (decision 34). */
  readonly lighting: PlanetLighting;
  /** Climate fields by direction for shaders (decision 42); set with the world. */
  readonly climate = new ClimateTexture();
  /** Live cloud cover and precipitation from the sim (decision 68). */
  readonly weather = new WeatherTexture();
  /** Tiled LOD terrain; drawn instead of the M1 grid mesh once a world has a global pass. */
  readonly terrain: TerrainRenderer;
  /** Instanced tree clumps near the camera (decision 45). */
  readonly forest: ForestLayer;
  /** Buildings of towns, airbases and industry near the camera (decision 65). */
  readonly structures: StructureLayer;
  /** Cloud shell and cloud shadows (decisions 55, 68). */
  readonly clouds: CloudLayer;
  /** Strategic graph and cast overlay (milestone 4). */
  readonly strategic: StrategicOverlay;
  /** Unit vector toward the sun, world frame. Set by the app from the ephemeris. */
  readonly sun = new Vec3d(1, 0.6, 0.8).normalize();
  /** Draw the tiled terrain when available (otherwise the M1 grid mesh). */
  useTiles = true;
  /** Whether the terrain has a world to draw (set by the app). */
  terrainReady = false;
  private detachInput: (() => void) | null = null;
  private mode: SimCameraMode = 'free';
  private readonly scratch = new Vec3d();
  /** The camera's velocity, for the terrain's look-ahead (decision 119). */
  private readonly motion = new MotionEstimate();
  private viewportHeight = 1;
  private readonly sunLight = new DirectionalLight(0xffffff, 2.5);

  constructor(
    private readonly renderer: WebGPURenderer,
    options: GlobeSceneOptions,
  ) {
    this.camera = new PerspectiveCamera(45, 1, 1, 2);
    this.orbit = new OrbitCamera(options.radius);
    this.observer = new ObserverCamera(options.radius);
    this.chase = new ChaseCamera(options.radius);
    this.lighting = new PlanetLighting(options.radius);
    // Clouds first: their shadow hook must be in place before lit materials are built.
    this.clouds = new CloudLayer(options.radius, this.lighting, this.weather);
    this.lighting.sunVisibility = (p) => this.clouds.shadow(p);
    this.terrain = new TerrainRenderer(this.lighting, this.climate);
    this.forest = new ForestLayer(this.terrain, this.lighting, this.climate, this.terrain.land);
    this.structures = new StructureLayer(this.terrain, this.lighting);
    // The sky: single scattering along each view ray, drawn behind everything (decision 35).
    this.scene.backgroundNode = this.lighting.atmosphere.skyNode();
    this.globe = new GlobeMesh(options.grid, options.radius);
    this.strategic = new StrategicOverlay(options.radius);
    this.scene.add(
      this.globe.group,
      this.terrain.group,
      this.forest.group,
      this.structures.group,
      this.clouds.group,
      this.strategic.group,
      this.vehicles,
    );

    // Scene lights serve only the M1 grid mesh (a debug view); the terrain lights itself.
    // Light directions are translation-invariant, so camera-relative offsets do not affect them.
    this.scene.add(this.sunLight, new AmbientLight(0xffffff, 0.35));
    renderer.toneMapping = AgXToneMapping;

    this.inputEnabled = options.input !== false;
  }

  /**
   * Whether mouse, touch and keyboard drive this scene's camera. Both views share one
   * canvas, so only the active view listens (decision 74).
   */
  get inputEnabled(): boolean {
    return this.detachInput !== null;
  }

  set inputEnabled(on: boolean) {
    if (on === this.inputEnabled) return;
    if (on && this.mode === 'chase') {
      // The flown aircraft's input belongs to the app (ui/flight/flightInput.ts).
      this.detachInput = () => {};
    } else if (on) {
      this.detachInput = attachOrbitInput(
        this.renderer.domElement,
        this.mode === 'observer' ? this.observer : this.orbit,
        () => (this.camera.fov * Math.PI) / 180 / this.viewportHeight,
      );
    } else {
      this.detachInput!();
      this.detachInput = null;
    }
  }

  /** Which camera draws the view; input follows it. */
  get cameraMode(): SimCameraMode {
    return this.mode;
  }

  set cameraMode(mode: SimCameraMode) {
    if (mode === this.mode) return;
    const listening = this.inputEnabled;
    this.inputEnabled = false;
    this.mode = mode;
    this.inputEnabled = listening;
  }

  /**
   * Infrastructure drawn on the terrain (decision 65): buildings and tree
   * clearings here; roads and lights come with the terrain world.
   */
  setInfrastructure(scene: InfraScene | null): void {
    this.structures.setScene(scene);
    this.forest.setClearings(scene ? (d) => scene.isClear(d) : undefined);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.viewportHeight = Math.max(1, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Advances camera easing and renders one frame. `dt` is real seconds since the last frame. */
  render(dt: number): void {
    const tiles = this.useTiles && this.terrainReady;
    let o: ViewCamera;
    /** Height of the eye above the ground (m). */
    let aboveGround: number;
    if (this.mode === 'chase') {
      const ch = this.chase;
      ch.terrainMaxHeight = this.globe.maxDisplayedHeight;
      ch.groundAt = tiles ? (d) => this.terrain.displaySurfaceAt(d) : null;
      ch.update(dt);
      this.camera.fov = ch.fov / DEG;
      o = ch;
      aboveGround = ch.height;
    } else if (this.mode === 'observer') {
      const ob = this.observer;
      ob.terrainMaxHeight = this.globe.maxDisplayedHeight;
      // The finest drawn surface, asked after each move so the observer never dips into it.
      ob.groundAt = tiles ? (d) => this.terrain.displaySurfaceAt(d) : null;
      ob.update(dt);
      this.camera.fov = ob.fov / DEG;
      o = ob;
      aboveGround = ob.height;
    } else {
      const fc = this.orbit;
      fc.terrainMaxHeight = this.globe.maxDisplayedHeight;
      // Ground clamp and near plane from the tile data under the camera (null until loaded).
      fc.groundHeight = tiles
        ? this.terrain.displayHeightAt(this.scratch.copy(fc.eye).normalize())
        : null;
      fc.update(dt);
      this.camera.fov = 45;
      o = fc;
      aboveGround = fc.altitude - Math.max(0, fc.groundHeight ?? 0);
    }

    // Camera at the origin, oriented from float64 vectors.
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(o.up.x, o.up.y, o.up.z);
    this.camera.lookAt(o.forward.x, o.forward.y, o.forward.z);
    this.camera.near = o.near;
    this.camera.far = o.far;
    this.camera.updateProjectionMatrix();

    this.sunLight.position.set(this.sun.x, this.sun.y, this.sun.z);
    this.clouds.update(o.eye);
    this.lighting.update(o.eye, this.sun);

    // World object placement: float64 subtraction first, then write float32.
    placePlanetCentered(this.globe.group, o.eye);
    this.beforeDraw?.(o.eye);

    this.globe.group.visible = !tiles;
    this.terrain.group.visible = tiles;
    if (tiles) {
      this.terrain.update({
        eye: o.eye,
        velocity: this.motion.update(o.eye, dt),
        forward: o.forward,
        up: o.up,
        fovY: (this.camera.fov * Math.PI) / 180,
        aspect: this.camera.aspect,
        viewportHeight: this.viewportHeight,
        radius: this.orbit.radius,
        maxHeight: this.globe.maxDisplayedHeight,
      });
      // Trees and buildings skip tiles outside the frustum (decision 131).
      const cull = {
        eye: o.eye,
        forward: o.forward,
        up: o.up,
        fovY: (this.camera.fov * Math.PI) / 180,
        aspect: this.camera.aspect,
      };
      this.forest.update(o.eye, aboveGround, cull);
      this.structures.setInk(
        this.structures.inkWidth,
        (this.camera.fov * Math.PI) / 180 / this.viewportHeight,
      );
      this.structures.update(o.eye, aboveGround, cull);
    } else {
      this.forest.group.visible = false;
      this.structures.group.visible = false;
    }

    // Above the highest exaggerated terrain, so the lines are not buried.
    this.strategic.update(o.eye, this.globe.maxDisplayedHeight + 2000);

    // Cloud coverage for shadows, re-baked when the clouds have moved (decision 69).
    this.clouds.bake(this.renderer, performance.now());
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.inputEnabled = false;
    this.globe.dispose();
    this.terrain.dispose();
    this.forest.dispose();
    this.structures.dispose();
    this.clouds.dispose();
    this.strategic.dispose();
  }
}
