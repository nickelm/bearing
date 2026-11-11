/**
 * Night lights on the strategic map (visual-style Part II, Day, Night, and Weather;
 * decision 88): settlements, airbases and target sites glow on the night side as
 * small warm points with a soft halo, settlements sized by population.
 *
 * - **Geometry.** One instanced quad per light, turned to face the camera in the
 *   vertex shader and sized in drawing-buffer pixels, so a light keeps its size at
 *   every zoom. The quad is planet-centered (placed at −eye, rule 4); each instance
 *   sits at its own displayed terrain height (raw height × the relief's
 *   exaggeration), so lights stay on their towns when the camera tilts.
 * - **Look.** A core of `radiusPx` with a one-pixel antialiased edge and a Gaussian
 *   halo about four times wider, in Part II's night-light color `#FFD27A`, blended
 *   additively (the halo is the only glow on the map).
 * - **Visibility.** Lights fade in across civil twilight as the night side begins
 *   (decision 87), scaled by the GUI's night strength. They draw without a depth test;
 *   a horizon test hides those on the far side of the globe.
 *
 * `lightRadiusPx` and `mapLightList` are pure, for tests.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute,
  clamp,
  dot,
  exp,
  float,
  length,
  max,
  normalize,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import type { Infrastructure } from '../../worldgen/strategic/infrastructure';
import type { StrategicGraph } from '../../worldgen/strategic/graph';
import { placePlanetCentered } from '../common/cameraRelative';
import { srgbToLinear } from '../common/palette';
import type { Vec3d } from '../../core/vec3d';
import { TWILIGHT_MU } from './mapDaylight';

/** Halo extent in core radii (the quad's half-size). */
const HALO = 4;
/** Night-light color (Part II `#FFD27A`), linear. */
const LIGHT = [0xff, 0xd2, 0x7a].map((c) => srgbToLinear(c / 255));
/** Core radius (px) of airbases and target sites. */
const BASE_RADIUS_PX = 1.4;
const TARGET_RADIUS_PX = 1.1;

/** Halo strength at the core (decision 100: 0.45 stacked into a blowout at globe scale). */
const HALO_STRENGTH = 0.3;

/**
 * Smallest light core radius (px) shown at a map scale (m per px, decision 100):
 * none below 300 m per px, rising by 0.6 px per doubling of the scale, at most 2.5 px.
 * At the ceiling (about 2.6 km per px) only lights of about 1.9 px and up remain.
 */
export function minLightRadiusPx(metersPerPx: number): number {
  return Math.min(2.5, Math.max(0, 0.6 * Math.log2(Math.max(metersPerPx, 1) / 300)));
}

/** Core radius (px) of a settlement's light by population: 0.9 px for villages, up to 3.5 px. */
export function lightRadiusPx(population: number): number {
  return Math.min(3.5, Math.max(0.9, 0.9 + 0.7 * Math.log2(Math.max(population, 1) / 2000)));
}

/** Per-light data: unit direction (xyz), core radius (px) and raw terrain height (m). */
export interface MapLightList {
  count: number;
  /** xyz, radius px, height m: five floats per light. */
  data: Float32Array;
}

/**
 * Lights for a strategic graph and its infrastructure. `heightAt(x, y, z)` gives the
 * raw terrain height (m) under a unit direction.
 */
export function mapLightList(
  graph: StrategicGraph,
  infra: Infrastructure | null,
  heightAt: (x: number, y: number, z: number) => number,
): MapLightList {
  const out: number[] = [];
  const push = (x: number, y: number, z: number, r: number) =>
    out.push(x, y, z, r, Math.max(0, heightAt(x, y, z)));
  const s = graph.settlements;
  for (let i = 0; i < s.cells.length; i++) {
    push(
      s.points[i * 3]!,
      s.points[i * 3 + 1]!,
      s.points[i * 3 + 2]!,
      lightRadiusPx(s.population[i]!),
    );
  }
  for (const b of infra?.airbases ?? []) push(b.point[0], b.point[1], b.point[2], BASE_RADIUS_PX);
  for (const t of infra?.targets ?? []) push(t.point[0], t.point[1], t.point[2], TARGET_RADIUS_PX);
  return { count: out.length / 5, data: Float32Array.from(out) };
}

export class MapLights {
  readonly group = new Group();
  /** Eye (planet-centered), sun direction, pixel angle (rad per drawing-buffer px), night strength. */
  readonly eye = uniform(new Vector3());
  readonly sunDirection = uniform(new Vector3(1, 0, 0));
  readonly pixelAngle = uniform(0.001);
  /** The camera's screen right and up, world frame: the quads face the screen. */
  readonly screenRight = uniform(new Vector3(1, 0, 0));
  readonly screenUp = uniform(new Vector3(0, 1, 0));
  readonly strength = uniform(1);
  /** Lights with a smaller core radius (px) fade out: `minLightRadiusPx` of the map scale. */
  readonly minRadiusPx = uniform(0);
  private mesh: Mesh | null = null;
  private readonly material: MeshBasicNodeMaterial;

  constructor(
    private readonly radius: number,
    /** The relief's exaggeration uniform: lights sit on the displayed terrain. */
    exaggeration: Node<'float'>,
  ) {
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
    });
    const corner = attribute('position', 'vec3');
    const light = attribute('iLight', 'vec4');
    const dir = normalize(light.xyz);
    const radiusPx = light.w;
    const height = attribute('iHeight', 'float');
    // Center on the displayed terrain, a little above it.
    const center = dir.mul(float(this.radius).add(height.mul(exaggeration)).add(200));
    const toEye = this.eye.sub(center);
    const dist = length(toEye);
    const view = toEye.div(dist);
    const size = radiusPx.mul(HALO).mul(dist).mul(this.pixelAngle);
    m.positionNode = center.add(
      this.screenRight.mul(corner.x).add(this.screenUp.mul(corner.y)).mul(size),
    );
    // Night side only, faded across civil twilight; hidden beyond the horizon.
    const mu = dot(dir, this.sunDirection);
    const night = smoothstep(TWILIGHT_MU, -TWILIGHT_MU, mu);
    const facing = smoothstep(0, 0.05, dot(dir, view));
    const r = length(corner.xy).mul(HALO); // in core radii
    const core = clamp(float(1).sub(r).mul(radiusPx).add(0.5), 0, 1);
    const halo = exp(r.mul(0.5).pow(2).negate()).mul(HALO_STRENGTH);
    m.colorNode = vec3(LIGHT[0]!, LIGHT[1]!, LIGHT[2]!);
    // Thinned by scale (decision 100): lights smaller than the threshold fade out, so
    // the globe shows the larger towns and the floor shows every village.
    const shown = smoothstep(this.minRadiusPx.sub(0.3), this.minRadiusPx.add(0.2), radiusPx);
    m.opacityNode = max(core, halo).mul(night).mul(facing).mul(this.strength).mul(shown);
    this.material = m;
  }

  /** Replaces the lights (or removes them with null). */
  setLights(list: MapLightList | null): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (!list || list.count === 0) return;
    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const light = new Float32Array(list.count * 4);
    const height = new Float32Array(list.count);
    for (let i = 0; i < list.count; i++) {
      light.set(list.data.subarray(i * 5, i * 5 + 4), i * 4);
      height[i] = list.data[i * 5 + 4]!;
    }
    g.setAttribute('iLight', new InstancedBufferAttribute(light, 4));
    g.setAttribute('iHeight', new InstancedBufferAttribute(height, 1));
    g.instanceCount = list.count;
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  /** Places the lights camera-relative and updates the per-frame uniforms. */
  update(
    eye: Readonly<Vec3d>,
    sun: Readonly<Vec3d>,
    pixelAngle: number,
    right: Readonly<Vec3d>,
    up: Readonly<Vec3d>,
  ): void {
    placePlanetCentered(this.group, eye);
    this.screenRight.value.set(right.x, right.y, right.z);
    this.screenUp.value.set(up.x, up.y, up.z);
    this.eye.value.set(eye.x, eye.y, eye.z);
    this.sunDirection.value.set(sun.x, sun.y, sun.z);
    this.pixelAngle.value = pixelAngle;
    this.minRadiusPx.value = minLightRadiusPx(pixelAngle * Math.max(1, eye.length() - this.radius));
  }

  dispose(): void {
    this.setLights(null);
    this.material.dispose();
  }
}
