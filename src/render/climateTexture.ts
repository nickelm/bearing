/**
 * Climate fields for shaders (decision 42): one texture layer per cube face
 * at the tectonic grid's resolution, sampled by direction.
 *
 *   R  sea-level annual mean temperature (°C): the cell's temperature plus the
 *      lapse rate times its reference height, so shaders can lapse-correct to
 *      any surface height
 *   G  seasonal half-range (K): (warmest − coldest month) / 2
 *   B  moisture 0..1
 *   A  cloudiness 0..1, from precipitation (unused since clouds follow the live
 *      weather, decision 68)
 *
 * Texel (i, j) of layer f is tectonic cell (f, i, j): u runs along i, v along
 * j, row 0 at v = 0. `cubeFaceUv` mirrors core/coords.ts (face by the largest
 * axis, equi-angular warp), so a direction lands on the same cell as on the CPU.
 * Climate fields are smooth, so bilinear filtering clamped at face edges is
 * enough.
 */
import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { abs, atan, dot, int, select, texture, vec2, vec3 } from 'three/tsl';
import { CUBE_FACES } from '../core/coords';
import { LAPSE_RATE } from '../worldgen/climate';
import type { World } from '../worldgen/pipeline';

type V3 = Node<'vec3'>;

/** Precipitation (mm/yr) mapped to cloudiness 0..1. */
const CLOUD_DRY = 250;
const CLOUD_WET = 2500;

/** Sea-level temperature (°C) of a cell from its temperature at height. */
export function seaLevelTemperature(t: number, height: number, reliefScale: number): number {
  return t + LAPSE_RATE * (Math.max(0, height) / reliefScale);
}

/** RGBA climate texels in the texture's layout (face-major, row j, column i). */
export function climateTexels(world: World): Float32Array {
  const n = world.info.resolution;
  const m = world.maps;
  const out = new Float32Array(6 * n * n * 4);
  for (let c = 0; c < 6 * n * n; c++) {
    const p = m.precipitation[c]!;
    const cloud = Math.min(1, Math.max(0, (p - CLOUD_DRY) / (CLOUD_WET - CLOUD_DRY)));
    out[c * 4] = seaLevelTemperature(m.temperature[c]!, m.height[c]!, world.info.reliefScale);
    out[c * 4 + 1] = m.temperatureRange[c]!;
    out[c * 4 + 2] = m.moisture[c]!;
    out[c * 4 + 3] = cloud;
  }
  return out;
}

/**
 * Face index and equi-angular (u, v) of a direction, as TSL. Mirrors
 * `directionToCubeFace`: the face with the largest absolute component
 * (ties to x, then y), u and v from atan of the tangent-plane coordinates.
 */
export function cubeFaceUv(d: V3): { face: Node<'int'>; uv: Node<'vec2'> } {
  const ax = abs(d.x);
  const ay = abs(d.y);
  const az = abs(d.z);
  const xMajor = ax.greaterThanEqual(ay).and(ax.greaterThanEqual(az));
  const yMajor = ay.greaterThanEqual(az);
  const face = select(
    xMajor,
    select(d.x.greaterThanEqual(0), int(0), int(1)),
    select(
      yMajor,
      select(d.y.greaterThanEqual(0), int(2), int(3)),
      select(d.z.greaterThanEqual(0), int(4), int(5)),
    ),
  ) as Node<'int'>;
  const pick = (axis: 'normal' | 'uAxis' | 'vAxis'): V3 => {
    const v: V3[] = CUBE_FACES.map((f) => vec3(f[axis].x, f[axis].y, f[axis].z) as V3);
    let out: V3 = v[5]!;
    for (let k = 4; k >= 0; k--) out = select(face.equal(k), v[k]!, out) as V3;
    return out;
  };
  const dn = dot(d, pick('normal'));
  const su = dot(d, pick('uAxis')).div(dn);
  const sv = dot(d, pick('vAxis')).div(dn);
  const toUnit = (s: Node<'float'>) =>
    atan(s)
      .div(Math.PI / 4)
      .add(1)
      .mul(0.5);
  return { face, uv: vec2(toUnit(su), toUnit(sv)) as Node<'vec2'> };
}

export class ClimateTexture {
  readonly texture: DataArrayTexture;

  constructor(private n = 1) {
    this.texture = ClimateTexture.make(n);
    this.fill(new Float32Array(6 * n * n * 4).map((_, i) => [12, 10, 0.5, 0.3][i % 4]!));
  }

  private static make(n: number): DataArrayTexture {
    const t = new DataArrayTexture(new Uint16Array(6 * n * n * 4), n, n, 6);
    t.format = RGBAFormat;
    t.type = HalfFloatType;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    return t;
  }

  private fill(texels: Float32Array): void {
    const half = this.texture.image.data as Uint16Array;
    for (let i = 0; i < texels.length; i++) half[i] = DataUtils.toHalfFloat(texels[i]!);
    this.texture.needsUpdate = true;
  }

  /** Loads a world's climate (any tectonic resolution). */
  setWorld(world: World): void {
    const n = world.info.resolution;
    if (n !== this.n) {
      // Three does not reallocate a GPU texture whose image changes size: free it, and the
      // next upload creates one at the new size. (Materials keep the same texture object.)
      this.n = n;
      this.texture.dispose();
      this.texture.image = { data: new Uint16Array(6 * n * n * 4), width: n, height: n, depth: 6 };
    }
    this.fill(climateTexels(world));
  }

  /** Climate at a direction (need not be normalized): vec4(T_sea °C, half-range K, moisture, cloudiness). */
  sample(dir: V3): Node<'vec4'> {
    const { face, uv } = cubeFaceUv(dir);
    // Level 0 explicitly: the texture has no mipmaps, and vertex or compute stages have no derivatives.
    return texture(this.texture, uv).depth(face).level(int(0)) as Node<'vec4'>;
  }
}
