/**
 * The simulation view's post-processing pipeline (visual-style Part I,
 * _Post-Processing_). `GlobeScene` owns one and calls `render` in place of
 * `renderer.render`; the strategic view keeps drawing directly.
 *
 * The frame, in linear radiance until the last step:
 *
 * 1. **Scene pass** at the drawing buffer's size into a half-float target
 *    with a 32-bit float depth texture. The target takes the renderer's
 *    sample count, so MSAA is what it was: three's direct path also draws
 *    into a multisampled half-float target and resolves it before the tone
 *    curve. With MSAA the depth texture stays multisampled: the
 *    low-resolution passes and `sceneDistance` read sample 0 of each pixel,
 *    the final pass reads all of them (`airAt`). (The direct path's depth
 *    buffer is 24-bit fixed point; the float depth here is what a reversed
 *    depth buffer is meant to have.)
 * 2. **Volumetrics** (only while a source is set and enabled), at 1/2, 1/3 or
 *    1/4 of the resolution: a depth pass picks, per low-resolution pixel, the
 *    nearest or the farthest depth of its block in a checkerboard, and the
 *    volumetric pass evaluates the source along a ray through the block up to
 *    that distance (viewRays.ts), or rather along one of nine rays through
 *    the block, so that the filter's 3 × 3 average antialiases edges in the
 *    air. Alternating nearest and farthest gives the
 *    upsample a sample of each side of a silhouette among its neighbors. A
 *    third pass averages the result over 3 × 3 low-resolution texels of
 *    similar depth, which removes the march's jitter: interleaved gradient
 *    noise is built to even out over exactly that box.
 * 3. **Overlay** (only while `overlay` has a visible child): the overlay
 *    scene drawn with the same camera into its own target, cleared to
 *    transparent, so it accumulates premultiplied color and coverage.
 * 4. **Bloom** (bloom.ts): five small passes from a quarter of the resolution down.
 * 5. **Final pass**, the only full-screen quad at full resolution: scene ·
 *    transmittance + in-scatter with a depth-aware upsample, the overlay over
 *    it, bloom, the time-of-day grade (grade.ts), the tone curve with the
 *    renderer's exposure, the sRGB encoding, then film grain and a dither of
 *    ±0.5 of an 8-bit step.
 *
 * With volumetrics, overlay and bloom off the frame is one scene pass and one
 * full-screen pass, exactly as three's direct path with a tone curve. Each
 * switch selects a variant of the final shader, so a stage that is off costs
 * nothing, neither a pass nor a branch.
 *
 * Depth-aware upsample: each pixel weights the four low-resolution texels
 * around it by their bilinear weight over the squared relative difference of
 * their depth to its own, so texels on the other side of a silhouette count
 * for almost nothing. If none of the four is within 10%, the 3 × 3 block of
 * low-resolution texels is searched for the closest depth. With MSAA, a
 * pixel whose samples lie on two surfaces takes the result for each, mixed
 * by the samples' share, so that fog and cloud do not undo the antialiasing
 * of silhouettes.
 *
 * Overlay materials: unlit (the overlay scene has no lights), drawn with
 * `depthTest: false` (the overlay has no depth buffer, and no MSAA) and faded
 * against `sceneDistance`. Normal blending gives ordinary
 * translucency. Three's additive blending also adds the material's alpha to
 * the overlay's coverage, which darkens what is behind a glow;
 * `overlayAdditive` sets a blend that adds light and covers nothing.
 */
import {
  AddEquation,
  Color,
  CustomBlending,
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearSRGBColorSpace,
  NearestFilter,
  NoBlending,
  NodeMaterial,
  NoToneMapping,
  OneFactor,
  QuadMesh,
  RedFormat,
  RenderTarget,
  Scene,
  SrcAlphaFactor,
  SRGBColorSpace,
  Vector2,
  Vector3,
  ZeroFactor,
} from 'three/webgpu';
import type {
  Camera,
  Material,
  Node,
  PerspectiveCamera,
  Texture,
  ToneMapping,
  WebGPURenderer,
} from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  exp,
  float,
  floor,
  Fn,
  fract,
  If,
  int,
  interleavedGradientNoise,
  ivec2,
  length,
  max,
  min,
  mix,
  positionView,
  pow,
  screenCoordinate,
  screenUV,
  select,
  smoothstep,
  sRGBTransferOETF,
  texture,
  toneMapping,
  toneMappingExposure,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { Bloom, BLOOM_LEVELS, luma } from './bloom';
import { gradeAt } from './grade';
import type { GradeBand } from './grade';
import { SKY_DISTANCE, ViewRays } from './viewRays';

export { SKY_DISTANCE };

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;
type IV2 = Node<'ivec2'>;

/** What a volumetric source is given per low-resolution pixel. */
export interface VolumetricContext {
  /** Unit view ray, world axes. */
  rayDirection: V3;
  /** Distance along the ray to the opaque surface (m); ≥ 1e7 for sky. */
  sceneDistance: F;
  /** Screen uv 0..1 of the ray: a place in the low-res pixel's block. */
  uv: V2;
  /** Per-pixel, per-frame dither 0..1 (interleaved gradient noise). */
  jitter: F;
}

/** Everything in the air between the camera and the scene: clouds, fog, dust, rain shafts. */
export interface VolumetricSource {
  /** rgb: in-scattered radiance (scene units, before exposure); a: transmittance of the scene behind. */
  build(ctx: VolumetricContext): V4;
  /**
   * True while the source would return (0, 0, 0, 1) for every pixel (clear air): the
   * pipeline then leaves its volumetric stage out of the frame (decision 141).
   */
  idle?: boolean;
}

export interface SimPipelineOptions {
  /**
   * Watch the GPU for validation errors while new shaders are drawn for the
   * first time; one makes the next `render` throw, so the scene can fall back
   * to drawing directly instead of showing a broken frame. Default: on in a
   * browser, off elsewhere (error scopes crash Dawn's Node bindings on
   * Windows once a buffer has been mapped).
   */
  guard?: boolean;
}

/** What the last frame drew (for statistics and tests). */
export interface PipelineStats {
  /** Render passes, the scene pass included. */
  passes: number;
  /** Of those, the passes that shade every pixel of the drawing buffer: the scene pass and the final pass. */
  fullResolutionPasses: number;
  /** Render targets in use. */
  targets: number;
}

/** The renderer's exposure (`renderer.toneMappingExposure`), which the app's exposure control sets. */
const exposure = toneMappingExposure as unknown as F;

/** Shaders of the volumetric march kept at most: one per source and resolution drawn. */
const MARCH_SHADERS = 8;
/** Frames watched for GPU errors after the frame's shaders have changed. */
const GUARD_FRAMES = 3;
/** Relative depth difference above which the upsample looks further for a matching texel. */
const MISMATCH = 0.1;
/** Samples per pixel of a multisampled target: WebGPU has four or one. */
const MSAA_SAMPLES = 4;
/** Relative depth difference between a pixel's samples above which it is treated as a silhouette. */
const EDGE = 0.05;
/** Relative depth difference at which a neighbor's weight in the low-resolution filter falls to 1/e. */
const FILTER_DEPTH = 0.05;
/** Weight of the filter's 3 × 3 texels (of 9) under which it takes the 16 around them as well. */
const FILTER_SPARSE = 6.5;
/**
 * Relative depth difference up to which two low-resolution texels count as the same surface,
 * for the filter and the upsample: ground receding toward the horizon differs by this much
 * from one texel to the next, and weighting those apart left the march's sample pattern
 * and the texel grid visible on clouds and fog in front of it (decision 141).
 */
const SAME_SURFACE = 0.15;
/**
 * Distance (m) from which a surface counts toward the sky for the same two: the air in front
 * of ground 100 km away and in front of the sky above it is the same air, and treating the
 * horizon as a silhouette drew it as a line across clouds in front of it (decision 141).
 */
const FAR_SURFACE = 15_000;
/**
 * Transmittance of the volumetric result from which the surface behind it counts in full for
 * the same two: behind opaque cloud or fog a surface's depth changes nothing, and telling
 * the horizon's ground from the sky above it there drew a line across the cloud in front of
 * both (decision 141). The rule is for a pair: both results must be opaque. A wall whose
 * air lets it through stays apart from the opaque sky beside it (no halo).
 */
const HIDDEN_SURFACE = 0.1;

/**
 * Makes an overlay material add its color times its alpha to the image
 * without covering what is behind it (lightning, glints, sparks).
 */
export function overlayAdditive<M extends Material>(material: M): M {
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = SrcAlphaFactor;
  material.blendDst = OneFactor;
  material.blendSrcAlpha = ZeroFactor;
  material.blendDstAlpha = OneFactor;
  return material;
}

/** White noise 0..1 per pixel (Hoskins' hash12). */
function hash12(p: V2): F {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z)) as F;
}

/** Integer texel coordinates held inside 0..last. */
function clampTexel(texel: Node, last: IV2): IV2 {
  type IntClamp = (x: Node, low: IV2, high: IV2) => IV2;
  return (clamp as unknown as IntClamp)(texel, ivec2(0, 0) as IV2, last);
}

/**
 * One texel of a texture, without filtering. `texture(t).load(texel)` would do the same but
 * runs the texel coordinates through the texture's uv transform first: a matrix uniform per
 * texture node, updated every frame, and a matrix product per fetch.
 */
function fetch(map: Texture, texel: Node, sample = 0): V4 {
  // The level of a multisampled texture's fetch is the sample's index.
  const node = sample === 0 ? texture(map, texel) : texture(map, texel, int(sample));
  return node.setSampler(false) as unknown as V4;
}

function disposeQuad(quad: QuadMesh | null): void {
  (quad?.material as NodeMaterial | undefined)?.dispose();
}

function quadMaterial(name: string): NodeMaterial {
  const m = new NodeMaterial();
  m.name = name;
  m.blending = NoBlending;
  m.depthTest = false;
  m.depthWrite = false;
  return m;
}

export class SimPipeline {
  /**
   * Drawn with the scene's camera after the volumetric composite and blended
   * over it: rain, snow, lightning bolts. Costs nothing while it has no
   * visible child.
   */
  readonly overlay = new Scene();
  /**
   * Distance from the camera to the opaque surface behind the fragment being
   * drawn (m; `SKY_DISTANCE` for sky), for overlay materials to fade against.
   * Fragment stage only.
   */
  readonly sceneDistance: F;
  /** The sun's elevation at the camera (rad); set each frame by the scene. */
  readonly sunElevation = uniform(0.6);
  /** −1 while the sun is setting to 1 while it is rising: dusk or dawn. */
  readonly morning = uniform(0);
  /** Bloom added per level, as a fraction of the light above the threshold. */
  readonly bloomStrength = uniform(0.8);
  /** Scales the bloom threshold of the time of day (grade.ts). */
  bloomThresholdScale = 1;
  /** Peak-to-peak film grain in the darkest tones, as a fraction of full scale. */
  readonly grainAmount = uniform(0.016);
  /** Stage switches. A stage that is off is left out of the frame. */
  bloom = true;
  grading = true;
  grain = true;
  dither = true;
  volumetricsEnabled = true;
  /** Average the marched result over 3 × 3 low-resolution texels before the upsample. */
  volumetricFilter = true;
  /**
   * Send each low-resolution pixel's ray through one of nine places in its block instead of
   * the center (see `volumetricNode`). Read when the volumetric shader is built.
   */
  volumetricSupersample = true;
  /** Advance the jitter and the grain each frame; off for repeatable stills. */
  animateNoise = true;
  readonly stats: PipelineStats = { passes: 0, fullResolutionPasses: 0, targets: 0 };

  private source: VolumetricSource | null = null;
  /** A number per source object seen, and the current source's: they name its march's shader. */
  private readonly sourceIds = new WeakMap<VolumetricSource, number>();
  private sourceCount = 0;
  private sourceId = 0;
  /** What the source threw while its shader was built, until `render` has dealt with it. */
  private sourceError: unknown = null;
  private divisor = 3;
  private readonly rays = new ViewRays();
  private readonly sceneTarget: RenderTarget;
  private readonly depthTexture: DepthTexture;
  private lowDepth: RenderTarget | null = null;
  /** The source's result as marched, and after the filter. */
  private lowRaw: RenderTarget | null = null;
  private lowColor: RenderTarget | null = null;
  private overlayTarget: RenderTarget | null = null;
  private bloomChain: Bloom | null = null;
  private readonly fullSize = uniform(new Vector2(1, 1));
  private readonly lowSize = uniform(new Vector2(1, 1));
  /** Reversed depth of a surface FAR_SURFACE away: the floor of `apart`. */
  private readonly farDepth = uniform(1e-30);
  /** Offsets of the noise patterns this frame (pixels). */
  private readonly jitterOffset = uniform(new Vector2());
  private readonly grainOffset = uniform(new Vector2());
  private readonly gradeGain = uniform(new Vector3(1, 1, 1));
  private readonly gradeLift = uniform(new Vector3());
  private readonly gradeSaturation = uniform(1);
  private readonly gradeGamma = uniform(1);
  private readonly grade: GradeBand = gradeAt(0.6, 0);
  /** The depth selection's quad by divisor, and the march's by divisor and source. */
  private readonly depthSelects = new Map<number, QuadMesh>();
  private readonly marches = new Map<string, QuadMesh>();
  private filter: QuadMesh | null = null;
  private readonly finals = new Map<string, QuadMesh>();
  private readonly size = new Vector2();
  private width = 0;
  private height = 0;
  private frame = 0;
  private readonly clearColor = new Color();
  private readonly guard: boolean;
  private guardFrames = 0;
  private guardKey = '';
  /** A GPU validation error raised by the pipeline's own passes. */
  private failure: Error | null = null;

  constructor(
    private readonly renderer: WebGPURenderer,
    options: SimPipelineOptions = {},
  ) {
    this.guard = options.guard ?? typeof document !== 'undefined';
    this.depthTexture = new DepthTexture(1, 1);
    // The reversed depth buffer needs float depth to keep its precision (decision 112).
    this.depthTexture.type = FloatType;
    this.depthTexture.minFilter = this.depthTexture.magFilter = NearestFilter;
    this.sceneTarget = new RenderTarget(1, 1, {
      type: HalfFloatType,
      depthTexture: this.depthTexture,
      samples: renderer.samples,
    });
    this.sceneTarget.texture.name = 'sim scene';
    this.sceneDistance = Fn(() => {
      const depth = this.depthAt(ivec2(screenCoordinate.xy) as IV2);
      const stretch = length(positionView).div(positionView.z.negate());
      return select(
        depth.greaterThan(0),
        this.rays.viewDepth(depth).mul(stretch),
        float(SKY_DISTANCE),
      );
    })() as F;
  }

  /** Everything in the air, evaluated at low resolution; null for none. */
  get volumetrics(): VolumetricSource | null {
    return this.source;
  }

  set volumetrics(source: VolumetricSource | null) {
    if (source === this.source) return;
    this.source = source;
    if (!source) return;
    // The march's shader is kept per source (`marches`): a source that comes back, such as
    // a quality level chosen again, is drawn without compiling anything. The final pass
    // and the bloom read the source's result, not the source: their shaders stay.
    let id = this.sourceIds.get(source);
    if (id === undefined) {
      id = ++this.sourceCount;
      this.sourceIds.set(source, id);
    }
    this.sourceId = id;
  }

  /**
   * Resolution of the volumetric pass relative to the frame: 1/2, 1/3
   * (default) or 1/4; 1 marches every pixel, as a reference for the upsample.
   */
  get volumetricScale(): number {
    return 1 / this.divisor;
  }

  set volumetricScale(scale: number) {
    const divisor = Math.min(4, Math.max(1, Math.round(1 / scale)));
    if (divisor === this.divisor) return;
    this.divisor = divisor;
    this.resizeLow();
  }

  /**
   * Draws one frame of `scene` to the renderer's current target (the canvas,
   * or the output target). Throws if an earlier frame's passes raised a GPU
   * validation error (see `SimPipelineOptions.guard`).
   */
  render(scene: Scene, camera: PerspectiveCamera): void {
    if (this.failure) throw this.failure;
    const renderer = this.renderer;
    renderer.getDrawingBufferSize(this.size);
    this.resize(Math.max(1, this.size.x), Math.max(1, this.size.y));
    camera.updateMatrixWorld();
    this.rays.update(camera);
    // The reversed depth of a surface FAR_SURFACE away along the view axis.
    this.farDepth.value =
      (camera.near * Math.max(camera.far - FAR_SURFACE, 0)) /
      (FAR_SURFACE * (camera.far - camera.near));
    this.updateUniforms();

    let volumetric = this.volumetricsEnabled && this.source !== null && this.source.idle !== true;
    const overlay = this.overlay.children.some((c) => c.visible);
    const stats = this.stats;
    stats.passes = stats.fullResolutionPasses = 1;
    stats.targets = 1;

    const target = renderer.getRenderTarget();
    const mapping = renderer.toneMapping;
    const colorSpace = renderer.outputColorSpace;
    const autoClear = renderer.autoClear;
    let scope: GPUDevice | null = null;
    try {
      renderer.autoClear = true;
      renderer.setRenderTarget(this.sceneTarget);
      renderer.render(scene, camera);

      // The scene's own shaders are not this pipeline's to judge: the scope starts after them.
      const variant = `${volumetric ? `${this.divisor}s${this.sourceId}` : '-'}${overlay}${this.variantKey()}`;
      if (variant !== this.guardKey) {
        this.guardKey = variant;
        this.guardFrames = GUARD_FRAMES;
      }
      if (this.guard && this.guardFrames > 0) {
        this.guardFrames--;
        scope = (renderer.backend as unknown as { device: GPUDevice | null }).device;
        scope?.pushErrorScope('validation');
      }

      if (volumetric) {
        this.drawVolumetrics();
        if (this.sourceError === null) {
          stats.passes += this.volumetricFilter ? 3 : 2;
          stats.targets += this.volumetricFilter ? 3 : 2;
        } else {
          // A source that cannot be built must not take the rest of the frame with it.
          console.warn('The volumetric source failed; drawing without it.', this.sourceError);
          this.sourceError = null;
          this.volumetrics = null;
          volumetric = false;
        }
      }
      if (overlay) {
        this.drawOverlay(camera);
        stats.passes++;
        stats.targets++;
      }
      const key = `${volumetric ? this.divisor : '-'}|${overlay ? 'o' : '-'}`;
      if (this.bloom) {
        const bloom = (this.bloomChain ??= this.createBloom());
        bloom.threshold.value = this.grade.bloom * this.bloomThresholdScale;
        bloom.render(renderer, key, this.bloomSource);
        stats.passes += 2 * BLOOM_LEVELS - 1;
        stats.targets += BLOOM_LEVELS;
      }

      // The final pass applies the tone curve and the encoding itself.
      renderer.toneMapping = NoToneMapping;
      renderer.outputColorSpace = LinearSRGBColorSpace;
      renderer.setRenderTarget(target);
      this.finalQuad(key, mapping, colorSpace).render(renderer);
      stats.passes++;
      stats.fullResolutionPasses++;
    } finally {
      renderer.setRenderTarget(target);
      renderer.toneMapping = mapping;
      renderer.outputColorSpace = colorSpace;
      renderer.autoClear = autoClear;
      scope?.popErrorScope().then(
        (error) => {
          if (error) this.failure = new Error(`Post-processing: ${error.message}`);
        },
        () => {},
      );
    }
  }

  /** The stage switches that select the final shader. */
  private variantKey(): string {
    return `${this.bloom ? 'b' : '-'}${this.grading ? 'g' : '-'}${this.grain ? 'n' : '-'}${this.dither ? 'd' : '-'}`;
  }

  /**
   * Frees the GPU memory of every render target; the next `render` allocates
   * them again. For a view that stops being drawn for a while: at 1080p with
   * four samples the scene target alone holds over 100 MB.
   */
  release(): void {
    this.sceneTarget.dispose();
    this.depthTexture.dispose();
    this.lowDepth?.dispose();
    this.lowRaw?.dispose();
    this.lowColor?.dispose();
    this.overlayTarget?.dispose();
    this.bloomChain?.release();
  }

  dispose(): void {
    this.release();
    this.bloomChain?.dispose();
    for (const q of this.depthSelects.values()) disposeQuad(q);
    this.depthSelects.clear();
    for (const q of this.marches.values()) disposeQuad(q);
    this.marches.clear();
    disposeQuad(this.filter);
    for (const q of this.finals.values()) disposeQuad(q);
    this.finals.clear();
  }

  private resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.fullSize.value.set(width, height);
    this.sceneTarget.setSize(width, height);
    this.overlayTarget?.setSize(width, height);
    this.bloomChain?.setSize(width, height);
    this.resizeLow();
  }

  private resizeLow(): void {
    const w = Math.ceil(this.width / this.divisor);
    const h = Math.ceil(this.height / this.divisor);
    this.lowSize.value.set(w, h);
    this.lowDepth?.setSize(w, h);
    this.lowRaw?.setSize(w, h);
    this.lowColor?.setSize(w, h);
  }

  private createBloom(): Bloom {
    const bloom = new Bloom(exposure);
    bloom.setSize(this.width, this.height);
    return bloom;
  }

  private updateUniforms(): void {
    if (this.animateNoise) this.frame++;
    const f = this.frame;
    // Interleaved gradient noise shifted along its diagonal covers its values evenly over 64 frames.
    this.jitterOffset.value.set((f % 64) * 5.588238, (f % 64) * 5.588238);
    this.grainOffset.value.set((f * 71) % 997, (f * 29) % 991);
    const g = gradeAt(this.sunElevation.value, this.morning.value, this.grade);
    this.gradeGain.value.set(g.gain[0], g.gain[1], g.gain[2]);
    this.gradeLift.value.set(g.lift[0], g.lift[1], g.lift[2]);
    this.gradeSaturation.value = g.saturation;
    this.gradeGamma.value = g.gamma;
  }

  /**
   * How far two reversed depths are apart, relative to the nearer one: 0 for
   * equal depths (two sky texels included), 1 between a surface and the sky.
   */
  private static mismatch(a: F, b: F): F {
    return abs(a.sub(b)).div(max(max(a, b), 1e-30)) as F;
  }

  /**
   * `mismatch` for the low-resolution filter and the upsample: surfaces beyond
   * FAR_SURFACE differ less the farther both are, and the farthest are one with the sky.
   */
  private apart(a: F, b: F): F {
    return abs(a.sub(b)).div(max(max(a, b), this.farDepth)) as F;
  }

  /** The scene's reversed depth at a pixel: of one of its samples, with MSAA. */
  private depthAt(pixel: IV2, sample = 0): F {
    return fetch(this.depthTexture, pixel, sample).x as F;
  }

  // ---- Volumetrics ----

  private drawVolumetrics(): void {
    const renderer = this.renderer;
    if (!this.lowDepth || !this.lowRaw || !this.lowColor) {
      const nearest = { depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter };
      this.lowDepth = new RenderTarget(1, 1, { type: FloatType, format: RedFormat, ...nearest });
      this.lowDepth.texture.name = 'sim low depth';
      this.lowRaw = new RenderTarget(1, 1, { type: HalfFloatType, ...nearest });
      this.lowRaw.texture.name = 'sim volumetrics, marched';
      this.lowColor = new RenderTarget(1, 1, { type: HalfFloatType, ...nearest });
      this.lowColor.texture.name = 'sim volumetrics';
      this.resizeLow();
    }
    let depthSelect = this.depthSelects.get(this.divisor);
    if (!depthSelect) {
      const select = quadMaterial('sim depth select');
      select.fragmentNode = this.depthSelectNode();
      depthSelect = new QuadMesh(select);
      this.depthSelects.set(this.divisor, depthSelect);
    }
    const key = `${this.divisor}s${this.sourceId}`;
    let march = this.marches.get(key);
    if (!march) {
      // The least recently built goes when there are too many (sources that never return).
      if (this.marches.size >= MARCH_SHADERS) {
        const oldest = this.marches.keys().next().value as string;
        disposeQuad(this.marches.get(oldest) ?? null);
        this.marches.delete(oldest);
      }
      const material = quadMaterial('sim volumetrics');
      material.fragmentNode = this.volumetricNode(this.source!);
      march = new QuadMesh(material);
      this.marches.set(key, march);
    }
    if (!this.filter) {
      const filter = quadMaterial('sim volumetric filter');
      filter.fragmentNode = this.filterNode();
      this.filter = new QuadMesh(filter);
    }
    renderer.setRenderTarget(this.lowDepth);
    depthSelect.render(renderer);
    renderer.setRenderTarget(this.volumetricFilter ? this.lowRaw : this.lowColor);
    march.render(renderer);
    // A source that could not be built is not kept.
    if (this.sourceError !== null) {
      disposeQuad(march);
      this.marches.delete(key);
    }
    if (this.volumetricFilter) {
      renderer.setRenderTarget(this.lowColor);
      this.filter.render(renderer);
    }
  }

  /**
   * Per low-resolution pixel, the nearest depth of its block of pixels on the
   * white squares of a checkerboard and the farthest on the black ones. Every
   * pixel of the block is read: a tree a pixel wide must not slip through.
   */
  private depthSelectNode(): V4 {
    const s = this.divisor;
    return Fn(() => {
      const low = ivec2(screenCoordinate.xy).toVar();
      const last = ivec2(this.fullSize).sub(1).toVar();
      let nearest: F = float(0) as F;
      let farthest: F = float(1) as F;
      for (let j = 0; j < s; j++) {
        for (let i = 0; i < s; i++) {
          const d = this.depthAt(clampTexel(low.mul(s).add(ivec2(i, j)), last as IV2));
          nearest = max(nearest, d) as F;
          farthest = min(farthest, d) as F;
        }
      }
      const white = low.x.add(low.y).bitAnd(1).equal(0);
      return vec4(select(white, nearest, farthest), 0, 0, 1);
    })() as V4;
  }

  private volumetricNode(source: VolumetricSource): V4 {
    const s = this.divisor;
    return Fn(() => {
      const low = ivec2(screenCoordinate.xy).toVar();
      const depth = fetch(this.lowDepth!.texture, low).x.toVar();
      // Where in its block the ray passes, in the frame's uv: one of nine places, a third of
      // the block apart, laid out so that every 3 × 3 low-resolution pixels (and every row
      // and column of three) hold each of the three places across and each of the three
      // down once. The filter's average over 3 × 3 then has nine rays per block's area, and
      // a hard edge in the air (a fog bank's top against the sky, a cloud's outline) comes
      // out a third of a block wide, not as steps a whole block high.
      const place = this.volumetricSupersample
        ? vec2(low.x.add(low.y).mod(int(3)), low.x.add(low.y.mul(2)).mod(int(3)))
            .sub(1)
            .div(3)
        : vec2(0, 0);
      const uv = vec2(low).add(0.5).add(place).mul(s).div(this.fullSize).toVar();
      const ray = this.rays.ray(uv as V2).toVar();
      const stretch = length(ray).toVar();
      const ctx: VolumetricContext = {
        rayDirection: ray.div(stretch).toVar() as V3,
        sceneDistance: this.rays.distance(depth as F, ray as V3).toVar() as F,
        uv: uv as V2,
        jitter: interleavedGradientNoise(vec2(low).add(this.jitterOffset)).toVar() as F,
      };
      // Three logs an exception thrown while a shader is built and carries on with a broken
      // shader; catch it here, so that the frame can go on without the source.
      try {
        return source.build(ctx);
      } catch (error) {
        this.sourceError = error;
        return vec4(0, 0, 0, 1);
      }
    })() as V4;
  }

  /**
   * The marched result averaged over the 3 × 3 low-resolution texels around
   * each, weighted by how close their depths are: the box over which
   * interleaved gradient noise evens out, so the jitter of the march does not
   * reach the screen as a pattern.
   */
  private filterNode(): V4 {
    const lowDepth = this.lowDepth!.texture;
    const lowRaw = this.lowRaw!.texture;
    return Fn(() => {
      const low = ivec2(screenCoordinate.xy).toVar();
      const last = ivec2(this.lowSize).sub(1).toVar();
      const depth = fetch(lowDepth, low).x.toVar();
      const through = fetch(lowRaw, low).a.toVar();
      // At the frame's edge the block moves inward: clamped texels would count some of the
      // march's nine sample offsets twice and others not at all.
      const inner = (max as unknown as (a: Node, b: Node) => IV2)(
        clampTexel(low, last.sub(1) as IV2),
        ivec2(1, 1),
      );
      const center = clampTexel(inner, last as IV2).toVar();
      const sum = vec4(0).toVar();
      const weight = float(0).toVar();
      const tap = (i: number, j: number) => {
        const texel = clampTexel(center.add(ivec2(i, j)), last as IV2).toVar();
        const raw = fetch(lowRaw, texel).toVar();
        // Where both results are opaque, what lies behind them does not show: one surface.
        const shown = smoothstep(0, HIDDEN_SURFACE, max(raw.a, through));
        const m = max(
          this.apart(fetch(lowDepth, texel).x as F, depth as F)
            .mul(shown)
            .sub(SAME_SURFACE),
          0,
        ).div(FILTER_DEPTH);
        const w = exp(m.mul(m).negate()).toVar();
        sum.addAssign(raw.mul(w));
        weight.addAssign(w);
      };
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) tap(i, j);
      }
      // Beside a silhouette few of the nine are on this texel's side, and what is left of
      // the march's sample pattern would show as dots along the edge: there the ring around
      // the block joins in (16 more texels, for the few texels that need them).
      If(weight.lessThan(FILTER_SPARSE), () => {
        for (let j = -2; j <= 2; j++) {
          for (let i = -2; i <= 2; i++) {
            if (Math.max(Math.abs(i), Math.abs(j)) === 2) tap(i, j);
          }
        }
      });
      return sum.div(weight);
    })() as V4;
  }

  /**
   * The volumetric result at a full-resolution pixel: the depth-aware
   * upsample. Call inside a shader function (it declares variables and branches).
   */
  private upsample(pixel: IV2, depth: F): V4 {
    const s = this.divisor;
    const lowDepth = this.lowDepth!.texture;
    const lowColor = this.lowColor!.texture;
    const last = ivec2(this.lowSize).sub(1).toVar();
    // Position in low-resolution texels, texel centers at integers.
    const at = vec2(pixel).add(0.5).div(s).sub(0.5).toVar();
    const base = floor(at).toVar();
    const f = at.sub(base).toVar();
    const corner = ivec2(base).toVar();
    const mismatch = (d: F): F => this.apart(d, depth);
    const sum = vec4(0).toVar();
    const weight = float(0).toVar();
    const best = float(1e9).toVar();
    const taps: { m: F; bilinear: F; color: V4 }[] = [];
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const texel = clampTexel(corner.add(ivec2(i, j)), last as IV2).toVar();
        const m = mismatch(fetch(lowDepth, texel).x as F).toVar() as F;
        const bilinear = (i ? f.x : f.x.oneMinus()).mul(j ? f.y : f.y.oneMinus()).toVar() as F;
        // The small floor lets a texel with no bilinear weight stand in when the others do not match.
        const apart = max(m.sub(SAME_SURFACE), 0);
        const w = bilinear.add(0.02).div(apart.mul(apart).add(1e-4)).toVar();
        const color = fetch(lowColor, texel).toVar() as V4;
        sum.addAssign(color.mul(w));
        weight.addAssign(w);
        best.assign(min(best, m));
        taps.push({ m, bilinear, color });
      }
    }
    const result = sum.div(weight).toVar();
    If(best.greaterThan(MISMATCH), () => {
      // No neighbor lies on this pixel's side of a silhouette: take the closest depth nearby.
      const center = ivec2(floor(at.add(0.5))).toVar();
      const found = center.toVar();
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const texel = clampTexel(center.add(ivec2(i, j)), last as IV2).toVar();
          const m = mismatch(fetch(lowDepth, texel).x as F).toVar();
          If(m.lessThan(best), () => {
            best.assign(m);
            found.assign(texel);
          });
        }
      }
      If(best.lessThan(MISMATCH), () => {
        result.assign(fetch(lowColor, found));
      });
    }).ElseIf(result.a.lessThan(HIDDEN_SURFACE), () => {
      // The air in front of this pixel's surface is all but opaque (`result` is that of the
      // texels at its depth). A neighbor whose air is opaque too shows the same thing,
      // whatever lies behind either: it counts as the same surface, so the horizon draws no
      // line across cloud or fog in front of it. A neighbor whose air lets its surface
      // through (a wall in front of fogged sky) stays apart: no halo.
      const own = result.a.toVar();
      const merged = vec4(0).toVar();
      const mergedWeight = float(0).toVar();
      for (const tap of taps) {
        const shown = smoothstep(0, HIDDEN_SURFACE, max(tap.color.a, own));
        const apart = max(tap.m.mul(shown).sub(SAME_SURFACE), 0);
        const w = tap.bilinear.add(0.02).div(apart.mul(apart).add(1e-4)).toVar();
        merged.addAssign(tap.color.mul(w));
        mergedWeight.addAssign(w);
      }
      result.assign(merged.div(mergedWeight));
    });
    return result as V4;
  }

  /**
   * The volumetric result for a full-resolution pixel of the resolved scene.
   * Call inside a shader function.
   *
   * With MSAA a pixel on a silhouette is a mix of two surfaces, and the air in
   * front of each is different: a ridge in clear air against a cloud. Taking
   * the depth of one sample gives such a pixel either all of the cloud or none
   * of it, by chance, which undoes the antialiasing exactly where it shows
   * (dotted outlines, small aircraft flickering in front of cloud). So the
   * result is found for the nearest and for the farthest of the pixel's
   * samples and mixed by the share of samples on each side. (The scene color
   * is already resolved, so the two transmittances can only be applied to the
   * mix; what is left is a quarter of the error at most, and it does not
   * flicker.) Pixels whose samples agree, nearly all, take one upsample.
   */
  private airAt(pixel: IV2): V4 {
    // As three's WebGPU backend counts: four samples or one.
    const samples = this.sceneTarget.samples >= MSAA_SAMPLES ? MSAA_SAMPLES : 1;
    const depths: F[] = [];
    for (let k = 0; k < samples; k++) depths.push(this.depthAt(pixel, k).toVar() as F);
    if (samples === 1) return this.upsample(pixel, depths[0]!);
    const near = depths.reduce((a, b) => max(a, b) as F).toVar() as F;
    const far = depths.reduce((a, b) => min(a, b) as F).toVar() as F;
    const air = this.upsample(pixel, far).toVar();
    If(SimPipeline.mismatch(near, far).greaterThan(EDGE), () => {
      let nearer: F = float(0) as F;
      for (const d of depths) {
        const onNear = SimPipeline.mismatch(d, near).lessThan(SimPipeline.mismatch(d, far));
        nearer = nearer.add(select(onNear, 1 / samples, 0)) as F;
      }
      air.assign(mix(air, this.upsample(pixel, near), nearer));
    });
    return air as V4;
  }

  // ---- Overlay ----

  private drawOverlay(camera: Camera): void {
    const renderer = this.renderer;
    if (!this.overlayTarget) {
      this.overlayTarget = new RenderTarget(this.width, this.height, {
        type: HalfFloatType,
        depthBuffer: false,
      });
      this.overlayTarget.texture.name = 'sim overlay';
    }
    renderer.getClearColor(this.clearColor);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.overlayTarget);
    try {
      renderer.render(this.overlay, camera);
    } finally {
      renderer.setClearColor(this.clearColor, alpha);
    }
  }

  // ---- Composite and final pass ----

  /**
   * The image before bloom as a function of a screen uv, with bilinear
   * filtering: what the bloom's prefilter reads at each of its taps, for the
   * frame `key` describes. The final pass composites per pixel instead.
   */
  private readonly bloomSource = (key: string): ((uv: V2) => V3) => {
    const [volumetric, overlay] = SimPipeline.stagesOf(key);
    // Bloom is blurred anyway: one low-resolution texel per prefilter pixel, the nearest to
    // its center, shared by all of its taps (the pass covers the frame, so `screenUV` is the
    // frame's uv).
    const air = volumetric
      ? fetch(
          this.lowColor!.texture,
          clampTexel(
            ivec2(floor(screenUV.mul(this.fullSize).div(this.divisor))),
            ivec2(this.lowSize).sub(1) as IV2,
          ),
        )
      : null;
    return (uv) => {
      let color: V3 = texture(this.sceneTarget.texture, uv).rgb as V3;
      if (air) color = color.mul(air.a).add(air.rgb) as V3;
      if (overlay) {
        // Per tap: a bolt a pixel wide must not fall between taps.
        const o = texture(this.overlayTarget!.texture, uv);
        color = color.mul(o.a.oneMinus()).add(o.rgb) as V3;
      }
      return color;
    };
  };

  /** Whether the frame a key names has the volumetric result and the overlay in it. */
  private static stagesOf(key: string): [volumetric: boolean, overlay: boolean] {
    const [air, over] = key.split('|');
    return [air !== '-', over === 'o'];
  }

  private finalQuad(key: string, mapping: ToneMapping, colorSpace: string): QuadMesh {
    const full = `${key}|${this.variantKey()}|${mapping}|${colorSpace}`;
    let quad = this.finals.get(full);
    if (!quad) {
      const m = quadMaterial(`sim final ${full}`);
      const [volumetric, overlay] = SimPipeline.stagesOf(key);
      m.fragmentNode = this.finalNode(volumetric, overlay, mapping, colorSpace);
      quad = new QuadMesh(m);
      this.finals.set(full, quad);
    }
    return quad;
  }

  private finalNode(
    volumetric: boolean,
    overlay: boolean,
    mapping: ToneMapping,
    colorSpace: string,
  ): V4 {
    const { bloom, grading, grain, dither } = this;
    return Fn(() => {
      const pixel = ivec2(screenCoordinate.xy).toVar();
      const color = fetch(this.sceneTarget.texture, pixel).rgb.toVar();
      if (volumetric) {
        const v = this.airAt(pixel as IV2).toVar();
        color.assign(color.mul(v.a).add(v.rgb));
      }
      if (overlay) {
        const o = fetch(this.overlayTarget!.texture, pixel).toVar();
        color.assign(color.mul(o.a.oneMinus()).add(o.rgb));
      }
      if (bloom) {
        color.addAssign(texture(this.bloomChain!.texture, screenUV).rgb.mul(this.bloomStrength));
      }
      color.assign(max(color, 0));
      if (grading) {
        // The tint leaves the sun and the lights their own color.
        const exposed = luma(color as V3).mul(exposure);
        const tint = mix(this.gradeGain, vec3(1), smoothstep(0.8, 4, exposed));
        color.mulAssign(tint);
        color.assign(max(mix(vec3(luma(color as V3)), color, this.gradeSaturation), 0));
      }
      if (mapping !== NoToneMapping) {
        color.assign(toneMapping(mapping, exposure, color));
      }
      if (colorSpace === SRGBColorSpace) color.assign(sRGBTransferOETF(color));
      if (grading) {
        // Gamma and lift act on the encoded color, where equal steps look equal.
        color.assign(pow(color, vec3(this.gradeGamma)));
        color.addAssign(this.gradeLift.mul(color.oneMinus()));
      }
      if (grain || dither) {
        const noise = hash12(vec2(pixel).add(this.grainOffset) as V2).sub(0.5);
        let amplitude: F = float(0) as F;
        // Grain fades toward white, as on film; the dither is half an 8-bit step each way.
        if (grain) {
          amplitude = this.grainAmount.mul(
            float(1).sub(luma(color as V3).mul(0.6)),
          ) as unknown as F;
        }
        if (dither) amplitude = amplitude.add(1 / 255) as F;
        color.addAssign(noise.mul(amplitude));
      }
      return vec4(color, 1);
    })() as V4;
  }
}
