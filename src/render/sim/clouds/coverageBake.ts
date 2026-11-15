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
 *   Half floats (13 MB at 512 texels per face edge): the march thresholds
 *   noise by these values, and bytes showed as steps.
 * - Refresh: compute passes re-evaluate the field, one cube face each, when
 *   the game clock has moved enough for the clouds to move a fraction of a
 *   texel, when the weather frames or the cloud settings change, and at most
 *   every MIN_INTERVAL_MS of real time. A texel costs sixteen octaves of
 *   noise, so the six faces of a bake that is due only to the field's age go
 *   out over six frames (`SPREAD_SPAN`): the clouds move a few meters
 *   meanwhile, against texels of 3 km. An input that drifts (the weather
 *   texture's fields, blended anew every 28 game seconds) makes the field due
 *   in the same way. New weather, new settings and a clock that runs fast or
 *   jumps bake all six at once.
 */
import { HalfFloatType, StorageTexture } from 'three/webgpu';
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
  uint,
  uniform,
  uvec2,
  vec2,
  vec3,
} from 'three/tsl';
import { CUBE_FACES } from '../../../core/coords';
import { cubeFaceUv } from '../../common/climateTexture';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/**
 * Interior texels per face edge: about 3 km at R = 1,000 km. The field's finest octave of
 * any weight is 4 km, and the clouds' shapes come from the noise volumes: at 768 the
 * picture was the same, for 2.25 times the memory and the bake's time (decision 141).
 */
export const BAKE_RESOLUTION = 512;
/**
 * Game seconds the field may age before it is baked again. Clouds move about 12 m/s, and
 * the noise that shapes them moves every frame: with the coverage 30 s behind (360 m), cloud
 * edges jumped at each bake.
 */
const MAX_AGE = 10;
/** Real milliseconds between bakes at most, whatever the time rate. */
const MIN_INTERVAL_MS = 100;
/** Cube faces: the passes of one bake. */
const FACES = 6;
/**
 * Game seconds the faces of one bake may lie apart, when they are baked a frame apart: the
 * clouds move 36 m in that time, a hundredth of a texel.
 */
const SPREAD_SPAN = 3;

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
  /** The cube face the kernel fills. */
  private readonly face = uniform(0);
  private bakedAt = Number.NaN;
  private bakedKey = '';
  private bakedDrift = 0;
  private lastBakeMs = -Infinity;
  /** The next face of a bake that is spread over frames; FACES while none is under way. */
  private next = FACES;
  /** The game time of the last `update`. */
  private seenAt = Number.NaN;
  /** Bakes begun so far, and cube faces baked (for statistics and tests). */
  bakes = 0;
  faces = 0;

  constructor(
    source: CoverageSource,
    private readonly n = BAKE_RESOLUTION,
  ) {
    const m = (this.m = n + 2);
    this.texture = new StorageTexture(3 * m, 2 * m);
    // Half floats: the march thresholds noise by these values, and 8-bit steps showed (decision 141).
    this.texture.type = HalfFloatType;
    this.texture.generateMipmaps = false;
    const count = m * m;
    this.kernel = Fn(() => {
      const i = instanceIndex;
      const face = uint(this.face);
      const y = i.div(m);
      const x = i.sub(y.mul(m));
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
   * field (weather frames, settings): a different key forces a bake of all six
   * faces at once. `drift` counts the small steps of an input that moves with
   * the clock: a different count makes the field due like its age does, a
   * face per frame while the clock runs slowly.
   */
  update(
    renderer: WebGPURenderer,
    gameTime: number,
    key: string,
    nowMs: number,
    drift = 0,
  ): boolean {
    // Game seconds since the last call: how fast the clock runs per frame.
    const step = Math.abs(gameTime - this.seenAt);
    this.seenAt = gameTime;
    const changed = key !== this.bakedKey;
    const due = drift !== this.bakedDrift;
    if (this.next < FACES) {
      // A bake is under way, a face per frame. If the weather has changed or the clock has
      // run away meanwhile, its faces would not fit together: all of it again, at once.
      if (changed || !(Math.abs(gameTime - this.bakedAt) < SPREAD_SPAN)) {
        this.bake(renderer, gameTime, key, nowMs, drift);
      } else {
        this.bakeFace(renderer, this.next++);
      }
      return true;
    }
    const age = Math.abs(gameTime - this.bakedAt);
    if (!(changed || due || !(age < MAX_AGE)) || nowMs - this.lastBakeMs < MIN_INTERVAL_MS) {
      return false;
    }
    // The field has only aged or drifted, and the clock runs slowly enough for six frames to
    // be one moment: a face now and one in each of the next five frames.
    if (!changed && age < 2 * MAX_AGE && step * FACES < SPREAD_SPAN) {
      this.bakedAt = gameTime;
      this.bakedDrift = drift;
      this.lastBakeMs = nowMs;
      this.bakes++;
      this.next = 0;
      this.bakeFace(renderer, this.next++);
    } else {
      this.bake(renderer, gameTime, key, nowMs, drift);
    }
    return true;
  }

  /** Bakes all six faces now, whatever the age. */
  bake(renderer: WebGPURenderer, gameTime: number, key: string, nowMs: number, drift = 0): void {
    for (let face = 0; face < FACES; face++) this.bakeFace(renderer, face);
    this.next = FACES;
    this.bakedAt = gameTime;
    this.bakedKey = key;
    this.bakedDrift = drift;
    this.lastBakeMs = nowMs;
    this.bakes++;
  }

  private bakeFace(renderer: WebGPURenderer, face: number): void {
    this.face.value = face;
    void renderer.compute(this.kernel);
    this.faces++;
  }

  /** Frees the texture (13 MB on the GPU at the default resolution) and the kernel. */
  dispose(): void {
    this.texture.dispose();
    this.kernel.dispose();
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
