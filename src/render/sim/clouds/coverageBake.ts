/**
 * Baked cloud coverage (decision 69): the cloud field evaluated once into a
 * texture, so every lit surface reads its cloud shadow from one texel instead
 * of evaluating four fractal noises per fragment.
 *
 * - Layout: a 2D atlas of the six cube faces in three columns and two rows
 *   (face f at column f % 3, row ⌊f / 3⌋). Each face holds (n + 2)² texels:
 *   n interior texels plus a one-texel border evaluated at its own direction
 *   across the seam, as in the weather texture (decision 68), so bilinear
 *   filtering stays continuous across face edges.
 *   R = coverage, G = precipitation fraction, B = cloud base above sea level
 *   in units of BASE_SCALE (cloudForm.ts), A = development (cloudForm.ts): the kind and depth
 *   of cloud. The volumetric march and the cloud shadow read all four with
 *   one read per sample (decision 141); the strategic map reads R and G.
 * - Refresh: a compute pass re-evaluates the field when the game clock has
 *   moved enough for the clouds to move a fraction of a texel, when the
 *   weather frames or the cloud settings change, and at most every
 *   MIN_INTERVAL_MS of real time.
 */
import { StorageTexture } from 'three/webgpu';
import type { ComputeNode, Node, WebGPURenderer } from 'three/webgpu';
import {
  float,
  Fn,
  instanceIndex,
  int,
  normalize,
  select,
  tan,
  texture,
  textureStore,
  uvec2,
  vec2,
  vec3,
} from 'three/tsl';
import { CUBE_FACES } from '../../../core/coords';
import { cubeFaceUv } from '../../common/climateTexture';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** Interior texels per face edge: about 2 km at R = 1,000 km. */
export const BAKE_RESOLUTION = 768;
/** Game seconds the field may age before it is baked again (clouds move about 12 m/s: 0.2 texel). */
const MAX_AGE = 30;
/** Real milliseconds between bakes at most, whatever the time rate. */
const MIN_INTERVAL_MS = 100;

export interface CoverageSource {
  /**
   * What a texel stores at a direction (unit length): coverage 0..1,
   * precipitation fraction 0..1, cloud base in units of BASE_SCALE, development.
   */
  texel(direction: V3): Node<'vec4'>;
}

/** Direction of cube-face coordinates (u, v), in TSL; mirrors `cubeFaceUvToDirection`. */
export function cubeFaceDirection(face: Node<'int'>, u: F, v: F): V3 {
  const pick = (axis: 'normal' | 'uAxis' | 'vAxis'): V3 => {
    let out = vec3(CUBE_FACES[5]![axis].x, CUBE_FACES[5]![axis].y, CUBE_FACES[5]![axis].z) as V3;
    for (let k = 4; k >= 0; k--) {
      const a = CUBE_FACES[k]![axis];
      out = select(face.equal(k), vec3(a.x, a.y, a.z), out) as V3;
    }
    return out;
  };
  const su = tan(
    u
      .mul(2)
      .sub(1)
      .mul(Math.PI / 4),
  );
  const sv = tan(
    v
      .mul(2)
      .sub(1)
      .mul(Math.PI / 4),
  );
  return normalize(pick('normal').add(pick('uAxis').mul(su)).add(pick('vAxis').mul(sv))) as V3;
}

export class CoverageBake {
  readonly texture: StorageTexture;
  private readonly m: number;
  private readonly kernel: ComputeNode;
  private bakedAt = Number.NaN;
  private bakedKey = '';
  private lastBakeMs = -Infinity;
  /** Bakes done so far (for statistics and tests). */
  bakes = 0;

  constructor(
    source: CoverageSource,
    private readonly n = BAKE_RESOLUTION,
  ) {
    const m = (this.m = n + 2);
    this.texture = new StorageTexture(3 * m, 2 * m);
    this.texture.generateMipmaps = false;
    const count = 6 * m * m;
    this.kernel = Fn(() => {
      const i = instanceIndex;
      const face = i.div(m * m);
      const rest = i.sub(face.mul(m * m));
      const y = rest.div(m);
      const x = rest.sub(y.mul(m));
      // Texel i of the bordered lattice is centered at u = (i − 0.5) / n.
      const u = float(x).sub(0.5).div(n);
      const v = float(y).sub(0.5).div(n);
      const dir = cubeFaceDirection(int(face), u, v);
      const col = face.mod(3);
      const row = face.div(3);
      textureStore(
        this.texture,
        uvec2(col.mul(m).add(x), row.mul(m).add(y)),
        source.texel(dir),
      ).toWriteOnly();
    })().compute(count);
  }

  /**
   * Bakes again if the field is stale. `key` names every other input of the
   * field (weather frames, settings): a different key forces a bake.
   */
  update(renderer: WebGPURenderer, gameTime: number, key: string, nowMs: number): boolean {
    const stale = key !== this.bakedKey || !(Math.abs(gameTime - this.bakedAt) < MAX_AGE);
    if (!stale || nowMs - this.lastBakeMs < MIN_INTERVAL_MS) return false;
    this.bake(renderer, gameTime, key, nowMs);
    return true;
  }

  /** Bakes now, whatever the age. */
  bake(renderer: WebGPURenderer, gameTime: number, key: string, nowMs: number): void {
    void renderer.compute(this.kernel);
    this.bakedAt = gameTime;
    this.bakedKey = key;
    this.lastBakeMs = nowMs;
    this.bakes++;
  }

  /** Baked (coverage, precipitation) at a direction (any length); usable in any shader stage. */
  sample(direction: V3): Node<'vec2'> {
    const { face, uv } = cubeFaceUv(direction);
    const m = this.m;
    const st = uv.mul(this.n).add(1).div(m);
    const cell = vec2(face.mod(3).toFloat(), face.div(3).toFloat());
    const atlas = cell.add(st).div(vec2(3, 2));
    return texture(this.texture, atlas).level(int(0)).xy as Node<'vec2'>;
  }

  /**
   * All four baked channels at a direction (any length): coverage,
   * precipitation, cloud base in units of BASE_SCALE, development. One read.
   */
  sampleAll(direction: V3): Node<'vec4'> {
    const { face, uv } = cubeFaceUv(direction);
    const m = this.m;
    const st = uv.mul(this.n).add(1).div(m);
    const cell = vec2(face.mod(3).toFloat(), face.div(3).toFloat());
    const atlas = cell.add(st).div(vec2(3, 2));
    return texture(this.texture, atlas).level(int(0)) as unknown as Node<'vec4'>;
  }
}
