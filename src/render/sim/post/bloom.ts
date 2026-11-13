/**
 * Bloom for the simulation view (visual-style Part I, _Post-Processing_:
 * "thresholded so only the sun, emissive lights, afterburners, and bright sky
 * glints bloom"). It runs every frame, so it is built from few, small passes:
 *
 * 1. **Prefilter** to a quarter of the resolution (1/16 of the pixels): 16
 *    bilinear taps in a tent over an 8 × 8 pixel window, each thresholded on
 *    its own. Every pixel of the window is covered, so a light a pixel or two
 *    across neither drops out between taps nor pulses as it moves; and the
 *    threshold sees the light before it is averaged away.
 * 2. **Down** to 1/8 and 1/16 with the dual filter's 5 taps.
 * 3. **Up** from 1/16 into 1/8 and from 1/8 into 1/4 with the dual filter's 8
 *    taps, drawn additively onto the level below, so no further targets are
 *    needed. The quarter-resolution level then holds the sum of all levels,
 *    and the final pass reads it with one bilinear tap.
 *
 * That is five passes over 1/16 + 1/64 + 1/256 + 1/64 + 1/16 = 0.16 of a
 * full-resolution pass, on three half-float targets. The threshold applies to
 * the exposed luminance, so the exposure control moves what blooms with what
 * is bright on screen.
 */
import {
  AdditiveBlending,
  HalfFloatType,
  NoBlending,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  Vector2,
} from 'three/webgpu';
import type { Node, Texture, UniformNode, WebGPURenderer } from 'three/webgpu';
import { clamp, dot, max, screenUV, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** Levels of the chain: 1/4, 1/8, 1/16 of the resolution. */
export const BLOOM_LEVELS = 3;
/**
 * Exposed luminance the light above the threshold approaches but never
 * reaches: a lamp at 2 keeps nearly all of it, the sun's disk at 80 keeps 6.
 */
const CEILING = 6;
/** Radiance above which a tap is clamped, so one broken pixel cannot flood the screen. */
const MAX_RADIANCE = 4096;

/** Rec. 709 luminance. */
export function luma(c: V3): F {
  return dot(c, vec3(0.2126, 0.7152, 0.0722)) as F;
}

function quadMaterial(name: string): NodeMaterial {
  const m = new NodeMaterial();
  m.name = name;
  m.blending = NoBlending;
  m.depthTest = false;
  m.depthWrite = false;
  return m;
}

export class Bloom {
  /** Exposed luminance at which a pixel blooms fully; the pipeline sets it from the time of day. */
  readonly threshold = uniform(1.6);
  /** Half width of the soft knee around the threshold, as a fraction of it. */
  readonly knee = uniform(0.35);
  private readonly targets: RenderTarget[] = [];
  /** Texel size of each level (1 / its size). */
  private readonly texel: UniformNode<'vec2', Vector2>[] = [];
  private readonly fullTexel = uniform(new Vector2(1, 1));
  /** Prefilter quads by the key of their source. */
  private readonly prefilters = new Map<string, QuadMesh>();
  private readonly down: QuadMesh[] = [];
  private readonly up: QuadMesh[] = [];
  private width = 0;
  private height = 0;

  constructor(private readonly exposure: F) {
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const target = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
      target.texture.name = `bloom ${4 << i}`;
      this.targets.push(target);
      this.texel.push(uniform(new Vector2(1, 1)));
    }
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      // Down: level i − 1 → level i. The taps sit on the corners of the destination texel.
      const src = this.targets[i - 1]!.texture;
      const h = this.texel[i - 1]!;
      const tap = (x: number, y: number) => texture(src, screenUV.add(h.mul(vec2(x, y)))).rgb;
      const m = quadMaterial(`bloom down ${i}`);
      m.fragmentNode = vec4(
        texture(src, screenUV)
          .rgb.mul(4)
          .add(tap(-1, -1))
          .add(tap(1, -1))
          .add(tap(-1, 1))
          .add(tap(1, 1))
          .div(8),
        1,
      );
      this.down.push(new QuadMesh(m));
    }
    for (let i = BLOOM_LEVELS - 1; i >= 1; i--) {
      // Up: level i added onto level i − 1.
      const src = this.targets[i]!.texture;
      const h = this.texel[i]!.mul(0.5);
      const tap = (x: number, y: number) => texture(src, screenUV.add(h.mul(vec2(x, y)))).rgb;
      const m = quadMaterial(`bloom up ${i}`);
      m.fragmentNode = vec4(
        tap(-2, 0)
          .add(tap(2, 0))
          .add(tap(0, -2))
          .add(tap(0, 2))
          .add(tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(2))
          .div(12),
        // Alpha 1: a premultiplied material multiplies its color by it.
        1,
      );
      m.transparent = true;
      m.blending = AdditiveBlending;
      m.premultipliedAlpha = true;
      this.up.push(new QuadMesh(m));
    }
  }

  /** The bloom to add to the image: the sum of all levels, at a quarter of the resolution. */
  get texture(): Texture {
    return this.targets[0]!.texture;
  }

  /** Follows the drawing buffer's size (pixels). */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.fullTexel.value.set(1 / width, 1 / height);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const w = Math.max(1, Math.ceil(width / (4 << i)));
      const h = Math.max(1, Math.ceil(height / (4 << i)));
      this.targets[i]!.setSize(w, h);
      this.texel[i]!.value.set(1 / w, 1 / h);
    }
  }

  /**
   * Draws the chain. `key` names what the image before bloom is built from:
   * each key gets its own prefilter shader, kept until `reset`. For a key not
   * seen before, `source(key)` returns the image as a function of a screen uv
   * (linear radiance), which the prefilter calls once per tap; it runs while
   * the prefilter's shader is put together, so nodes it creates outside the
   * returned function are shared by all taps. Leaves the renderer's render
   * target changed.
   */
  render(renderer: WebGPURenderer, key: string, source: (key: string) => (uv: V2) => V3): void {
    let prefilter = this.prefilters.get(key);
    if (!prefilter) {
      const m = quadMaterial(`bloom prefilter ${key}`);
      m.fragmentNode = this.prefilterNode(source(key));
      prefilter = new QuadMesh(m);
      this.prefilters.set(key, prefilter);
    }
    renderer.setRenderTarget(this.targets[0]!);
    prefilter.render(renderer);
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      renderer.setRenderTarget(this.targets[i]!);
      this.down[i - 1]!.render(renderer);
    }
    for (let i = BLOOM_LEVELS - 1, k = 0; i >= 1; i--, k++) {
      renderer.setRenderTarget(this.targets[i - 1]!);
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      this.up[k]!.render(renderer);
      renderer.autoClear = autoClear;
    }
  }

  /**
   * The part of a color above the threshold, with a soft knee, and compressed
   * toward `CEILING` so that the sun blooms as a halo and not as a white disk.
   */
  private bright(c: V3): V3 {
    const color = clamp(c, 0, MAX_RADIANCE);
    const x = luma(color as V3).mul(this.exposure);
    const knee = this.threshold.mul(this.knee);
    const soft = clamp(x.sub(this.threshold).add(knee), 0, knee.mul(2));
    const over = max(soft.mul(soft).div(knee.mul(4).add(1e-4)), x.sub(this.threshold));
    const kept = over.div(over.div(CEILING).add(1));
    return color.mul(kept.div(max(x, 1e-4))) as V3;
  }

  private prefilterNode(source: (uv: V2) => V3): Node<'vec4'> {
    // Tent weights of bilinear taps at ±1 and ±3 pixels: 3/8 and 1/8 per axis.
    const offsets: [number, number][] = [
      [-3, 1 / 8],
      [-1, 3 / 8],
      [1, 3 / 8],
      [3, 1 / 8],
    ];
    let sum: V3 = vec3(0) as V3;
    for (const [oy, wy] of offsets) {
      for (const [ox, wx] of offsets) {
        const uv = screenUV.add(this.fullTexel.mul(vec2(ox, oy))) as V2;
        sum = sum.add(this.bright(source(uv)).mul(wx * wy)) as V3;
      }
    }
    return vec4(sum, 1);
  }

  /** Drops the prefilter shaders (their sources are no longer drawn). */
  reset(): void {
    for (const q of this.prefilters.values()) (q.material as NodeMaterial).dispose();
    this.prefilters.clear();
  }

  /** Frees the targets' GPU memory; they are allocated again when next drawn. */
  release(): void {
    for (const t of this.targets) t.dispose();
  }

  dispose(): void {
    this.reset();
    this.release();
    for (const q of [...this.down, ...this.up]) (q.material as NodeMaterial).dispose();
  }
}
