/**
 * The globe scene: the M1 debug cube-sphere, the tiled terrain, the sun and an orbit camera,
 * rendered camera-relative.
 *
 * CAMERA-RELATIVE RENDERING (the pattern every world-space object follows):
 *   - World positions are float64 (Vec3d), planet-centered, in meters.
 *   - The Three.js camera stays at the origin and only rotates.
 *   - Each frame, every object's GPU-side position is (worldPosition - cameraEye),
 *     computed in float64 *before* it is written into float32 Object3D fields.
 * This keeps the numbers the GPU sees small near the camera, where precision
 * matters. Do not put planet-scale coordinates into Object3D positions directly.
 */
import {
  AgXToneMapping,
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
} from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { CubeGrid } from '../core/cubeGrid';
import { Vec3d } from '../core/vec3d';
import { ClimateTexture } from './climateTexture';
import { CloudLayer } from './clouds/cloudLayer';
import { ForestLayer } from './forest/forestLayer';
import { GlobeMesh } from './globeMesh';
import { PlanetLighting } from './lighting/planetLighting';
import { TerrainRenderer } from './terrain/terrainRenderer';
import { OrbitCamera, attachOrbitInput } from './orbitCamera';

const PLANET_CENTER = new Vec3d(0, 0, 0);

export interface GlobeSceneOptions {
  radius: number;
  grid: CubeGrid;
  /** Attach mouse and keyboard input to the canvas (default true; off for headless renders). */
  input?: boolean;
}

export class GlobeScene {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly orbit: OrbitCamera;
  readonly globe: GlobeMesh;
  /** Sun and camera uniforms shared by every lit planet material (decision 34). */
  readonly lighting: PlanetLighting;
  /** Climate fields by direction for shaders (decision 42); set with the world. */
  readonly climate = new ClimateTexture();
  /** Tiled LOD terrain; drawn instead of the M1 grid mesh once a world has a global pass. */
  readonly terrain: TerrainRenderer;
  /** Instanced tree clumps near the camera (decision 45). */
  readonly forest: ForestLayer;
  /** Cloud shell and cloud shadows (decision 55). */
  readonly clouds: CloudLayer;
  /** Unit vector toward the sun, world frame. Set by the app from the ephemeris. */
  readonly sun = new Vec3d(1, 0.6, 0.8).normalize();
  /** Draw the tiled terrain when available (otherwise the M1 grid mesh). */
  useTiles = true;
  /** Whether the terrain has a world to draw (set by the app). */
  terrainReady = false;
  private readonly detachInput: () => void;
  private readonly scratch = new Vec3d();
  private viewportHeight = 1;
  private readonly sunLight = new DirectionalLight(0xffffff, 2.5);

  constructor(
    private readonly renderer: WebGPURenderer,
    options: GlobeSceneOptions,
  ) {
    this.camera = new PerspectiveCamera(45, 1, 1, 2);
    this.orbit = new OrbitCamera(options.radius);
    this.lighting = new PlanetLighting(options.radius);
    // Clouds first: their shadow hook must be in place before lit materials are built.
    this.clouds = new CloudLayer(options.radius, this.lighting, this.climate);
    this.lighting.sunVisibility = (p) => this.clouds.shadow(p);
    this.terrain = new TerrainRenderer(this.lighting, this.climate);
    this.forest = new ForestLayer(this.terrain, this.lighting, this.climate, this.terrain.land);
    // The sky: single scattering along each view ray, drawn behind everything (decision 35).
    this.scene.backgroundNode = this.lighting.atmosphere.skyNode();
    this.globe = new GlobeMesh(options.grid, options.radius);
    this.scene.add(this.globe.group, this.terrain.group, this.forest.group, this.clouds.group);

    // Scene lights serve only the M1 grid mesh (a debug view); the terrain lights itself.
    // Light directions are translation-invariant, so camera-relative offsets do not affect them.
    this.scene.add(this.sunLight, new AmbientLight(0xffffff, 0.35));
    renderer.toneMapping = AgXToneMapping;

    this.detachInput =
      options.input === false
        ? () => {}
        : attachOrbitInput(
            renderer.domElement,
            this.orbit,
            () => (this.camera.fov * Math.PI) / 180 / this.viewportHeight,
          );
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.viewportHeight = Math.max(1, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Advances camera easing and renders one frame. `dt` is real seconds since the last frame. */
  render(dt: number): void {
    const o = this.orbit;
    const tiles = this.useTiles && this.terrainReady;
    o.terrainMaxHeight = this.globe.maxDisplayedHeight;
    // Ground clamp and near plane from the tile data under the camera (null until loaded).
    o.groundHeight = tiles
      ? this.terrain.displayHeightAt(this.scratch.copy(o.eye).normalize())
      : null;
    o.update(dt);

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
    this.scratch.subVectors(PLANET_CENTER, o.eye);
    this.globe.group.position.set(this.scratch.x, this.scratch.y, this.scratch.z);

    this.globe.group.visible = !tiles;
    this.terrain.group.visible = tiles;
    if (tiles) {
      this.terrain.update({
        eye: o.eye,
        forward: o.forward,
        up: o.up,
        fovY: (this.camera.fov * Math.PI) / 180,
        aspect: this.camera.aspect,
        viewportHeight: this.viewportHeight,
        radius: o.radius,
        maxHeight: this.globe.maxDisplayedHeight,
      });
      const ground = o.groundHeight ?? 0;
      this.forest.update(o.eye, o.altitude - Math.max(0, ground));
    } else {
      this.forest.group.visible = false;
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.detachInput();
    this.globe.dispose();
    this.terrain.dispose();
    this.forest.dispose();
    this.clouds.dispose();
  }
}
