/**
 * The atmosphere in TSL (decisions 35, 140): single scattering along rays,
 * plus Hillaire's multiple-scattering term.
 *
 * - The transmittance LUT (model.ts) is computed on the CPU and uploaded as
 *   a half-float texture. Every sunlight and view-path transmittance lookup
 *   goes through it.
 * - The multiple-scattering LUT (model.ts, also from the CPU) holds Ψ, the
 *   light of every scattering order above the first at a point, per unit sun
 *   illuminance. The source term of a march is single scattering plus Ψ times
 *   the scattering coefficient.
 * - `march` integrates along a ray segment. It serves aerial perspective on
 *   surfaces (per vertex) and the sky seen from above the atmosphere's lower
 *   part (the debug free camera on its way to orbit). It reads Ψ once per
 *   segment of the ray, not per step: Ψ changes slowly along a ray.
 * - The sky inside the simulation view's envelope is not marched per pixel:
 *   skyView.ts bakes it into a small sky-view LUT, and `skyRadiance` and
 *   `skyNode` read that.
 * - Sky light on surfaces comes from a 1D irradiance LUT over the sun's
 *   elevation (model.ts, also computed on the CPU).
 * - Aerial perspective: `aerialPerspective` marches from the camera to a
 *   surface point. Materials call it per vertex and pass the result to the
 *   fragment stage as varyings, because scattering varies slowly.
 *
 * Units. The scene's display units count a sunlit white surface as its
 * illuminance E (`shadeDiffuse` multiplies albedo by light, without the
 * Lambertian 1/π), so they are π times photometric radiance. In-scattered
 * light is ∫ σ·p·E, a true radiance, and takes the same factor π
 * (`IN_SCATTER_SCALE`) wherever it enters the scene: the sky, its LUT and
 * aerial perspective, through the uniform `inScatter` (π; 1 gives the look
 * from before decision 140, with a sky and a haze π times too dark for the
 * ground under them). `march` itself returns the integral per unit sun
 * illuminance, without the factor.
 *
 * Two departures from the consistent amount, both on purpose (decision 140):
 *
 * - Clear-air haze (`haze`). With the full factor π the thin veil of air in
 *   front of nearby ground is as bright as from an airliner's window: forest
 *   10 km away turns teal and the ground loses its palette, where the style
 *   wants hard, saturated ground under a soft sky. Aerial perspective
 *   therefore shows only `haze` (about a third) of the in-scattered light
 *   while the air between the camera and the surface is thin, and the full
 *   amount once that air is nearly opaque (`aerialGain`, from the path's own
 *   transmittance): ground keeps its hue for some 20 km, ranges beyond 40 km
 *   go blue, and terrain at the horizon still meets the sky at the sky's own
 *   brightness. Weather raises `haze` for humid or dusty air.
 * - Vibrance (`vibrance`). The sky's light is graded toward the guide's
 *   painterly tones before it enters the scene: a saturation about its
 *   luminance, 1 by day and night and higher at golden hour and through
 *   twilight (the lighting sets it from the sun's elevation), because the
 *   display's tone curve pales the oranges of a low sun. It is linear in the
 *   light, so it is applied once per LUT texel and once per vertex of aerial
 *   perspective, never per pixel.
 *
 * The scattering integral uses Hillaire's energy-conserving step:
 * S·(1 − e^(−σt·dt))/σt per step.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
} from 'three/webgpu';
import type { Node, UniformNode, Vector3, WebGPURenderer } from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  exp,
  float,
  If,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  select,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import {
  CLEAR_AIR_HAZE,
  computeAtmosphereLuts,
  computeSkyIrradianceLut,
  HAZE_OPACITY_FROM,
  HAZE_OPACITY_FULL,
  IRRADIANCE_MU_MIN,
  IRRADIANCE_SIZE,
  LUMA,
  MULTI_SCATTERING_SIZE,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
} from './model';
import type { AtmosphereLuts, AtmosphereParams } from './model';
import { MOON_TINT, SkyView } from './skyView';
import type { SkyUniforms } from './skyView';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

export interface AtmosphereUniforms {
  sunDirection: UniformNode<'vec3', Vector3>;
  sunIlluminance: UniformNode<'float', number>;
  eye: UniformNode<'vec3', Vector3>;
}

export interface ScatterResult {
  /** In-scattered radiance per unit sun illuminance. */
  inscatter: V3;
  /** Transmittance along the segment. */
  transmittance: V3;
}

/** The air's coefficients at one altitude, per meter, with the density factor applied. */
export interface Medium {
  /** Rayleigh scattering. */
  scatterR: V3;
  /** Mie scattering. */
  scatterM: F;
  /** Extinction: both scatterings, Mie absorption and ozone. */
  extinction: V3;
}

/**
 * In-scattered light per unit sun illuminance times this is in the scene's
 * display units, which are π times photometric radiance (see the file comment).
 */
export const IN_SCATTER_SCALE = Math.PI;

/** A linearly filtered, clamped half-float RGBA texture for a LUT. */
function lutTexture(width: number, height: number): DataTexture {
  const t = new DataTexture(
    new Uint16Array(width * height * 4),
    width,
    height,
    RGBAFormat,
    HalfFloatType,
  );
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  return t;
}

function upload(t: DataTexture, data: Float32Array): void {
  const half = t.image.data as Uint16Array;
  for (let i = 0; i < data.length; i++) half[i] = DataUtils.toHalfFloat(data[i]!);
  t.needsUpdate = true;
}

export class AtmosphereNodes {
  readonly lut = lutTexture(TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT);
  readonly multiScatteringLut = lutTexture(MULTI_SCATTERING_SIZE, MULTI_SCATTERING_SIZE);
  readonly irradiance = lutTexture(IRRADIANCE_SIZE, 1);
  /** Multiplies every coefficient in the shaders (the LUTs are rebuilt to match). */
  readonly density = uniform(1);
  /** Atmosphere on (1) or off (0): off leaves sunlight unfiltered and the sky black. */
  readonly enabled = uniform(1);
  /**
   * Display units per unit of in-scattered radiance (`IN_SCATTER_SCALE`): the
   * brightness of the sky and of the haze over distant ground against the
   * sunlit ground itself. A tuning knob; only π is physically consistent.
   */
  readonly inScatter = uniform(IN_SCATTER_SCALE);
  /**
   * Haze of the air in front of surfaces: the share of the in-scattered light
   * that aerial perspective shows while the air between the camera and the
   * surface is thin (`aerialGain`). `CLEAR_AIR_HAZE` on a clear day; 1 is the
   * consistent amount everywhere; weather raises it for humid or dusty air.
   * The sky itself does not change with it.
   */
  readonly haze = uniform(CLEAR_AIR_HAZE);
  /**
   * Saturation of the sky's light about its luminance (`graded`): 1 leaves it
   * as computed. The lighting sets it from the sun's elevation each frame.
   */
  readonly vibrance = uniform(1);
  /** The sky: its LUT, the sun, the moon and the stars (skyView.ts). */
  readonly sky: SkyView;
  /** The CPU's copies of the transmittance and multiple-scattering tables. */
  tables!: AtmosphereLuts;
  /** Counts `rebuild` calls, so the sky knows its LUT is stale. */
  version = 0;

  constructor(
    readonly params: AtmosphereParams,
    readonly u: AtmosphereUniforms,
    /** The moon, shared with the lighting: the night's air is lit by it. */
    readonly moon: SkyUniforms,
  ) {
    this.rebuild();
    this.sky = new SkyView(this, moon);
  }

  /** Recomputes the LUTs after a parameter change (e.g. density). */
  rebuild(): void {
    this.tables = computeAtmosphereLuts(this.params);
    upload(this.lut, this.tables.transmittance);
    upload(this.multiScatteringLut, this.tables.multiScattering);
    upload(this.irradiance, computeSkyIrradianceLut(this.params, this.tables));
    this.density.value = this.params.density;
    this.version++;
  }

  /**
   * Sky light on a surface per unit sun illuminance (already divided by π),
   * for the sun-elevation cosine at the point. Horizontal-surface irradiance;
   * the caller weights it by how much sky the normal sees.
   */
  skyIrradiance(muS: F): V3 {
    const x = clamp(muS.sub(IRRADIANCE_MU_MIN).div(1 - IRRADIANCE_MU_MIN), 0, 1);
    const u = x.mul(1 - 1 / IRRADIANCE_SIZE).add(0.5 / IRRADIANCE_SIZE);
    return texture(this.irradiance, vec2(u, 0.5)).level(int(0)).rgb.mul(this.enabled) as V3;
  }

  /**
   * Aerial perspective between the camera and a surface point given
   * camera-relative (`relative`). The in-scattered light is per unit sun
   * illuminance in display units (`inScatter` applied): radiance·T +
   * inscatter·E is the surface seen through the air. Emits a loop, so call it
   * inside an Fn (e.g. a position node).
   */
  aerialPerspective(relative: V3, steps = 10): ScatterResult {
    const ro = this.u.eye as unknown as V3;
    const dist = length(relative);
    const rd = relative.div(max(dist, 1e-3)) as V3;
    const top = AtmosphereNodes.raySphere(ro, rd, this.params.topRadius);
    const t0 = max(top.x, 0);
    const t1 = max(min(dist, top.y), t0);
    const s = this.march(ro, rd, t0 as F, t1 as F, steps, 2, true);
    const gain = this.enabled.mul(this.inScatter).mul(this.aerialGain(s.transmittance));
    return {
      inscatter: max(this.graded(s.inscatter), 0).mul(gain) as V3,
      transmittance: mix(vec3(1), s.transmittance, this.enabled) as V3,
    };
  }

  /**
   * The share of a path's in-scattered light that aerial perspective shows,
   * from the path's transmittance: `haze` through thin air, 1 once the air is
   * nearly opaque (see the file comment; model.ts's `aerialHazeGain` is its
   * CPU twin). Anything drawn in the air in front of the sky (clouds, fog)
   * should scale its own aerial perspective by it.
   */
  aerialGain(transmittance: V3): F {
    const opacity = float(1).sub(transmittance.z);
    return mix(this.haze, float(1), smoothstep(HAZE_OPACITY_FROM, HAZE_OPACITY_FULL, opacity)) as F;
  }

  /**
   * In-scattered light graded by `vibrance`: saturated about its luminance.
   * Linear in the light, so parts of a sum can be graded one by one; a
   * channel of the result can be negative, so take `max(…, 0)` of the sum.
   */
  graded(light: V3): V3 {
    return mix(vec3(dot(light, vec3(...LUMA))), light, this.vibrance) as V3;
  }

  /**
   * The sky's radiance toward a world-space unit direction, in display units:
   * the air's light without the sun's disk, the moon or the stars, with the
   * moonlit air by night. One read of each of the sky-view LUT's two textures
   * inside the simulation view's envelope; usable in any shader stage.
   * Volumetrics use it for aerial perspective on clouds and for fog color.
   * Above the envelope (the debug camera on its way to orbit) it is a march
   * of `marchSteps` per call: pass `SKY_MARCH_STEPS_COARSE` (skyView.ts)
   * from materials that cover much of the screen.
   */
  skyRadiance(rd: V3, marchSteps?: number): V3 {
    return this.sky.radiance(rd, marchSteps);
  }

  /** The sky behind everything, for `scene.backgroundNode`: the air, the sun, the moon and the stars. */
  skyNode(): V3 {
    return this.sky.background();
  }

  /** Re-bakes the sky-view LUT if the camera, the lights or the air have changed (once per frame). */
  bakeSky(renderer: WebGPURenderer): boolean {
    return this.sky.update(renderer);
  }

  setDensity(d: number): void {
    this.params.density = d;
    this.rebuild();
  }

  /** The air's scattering and extinction coefficients at an altitude above sea level. */
  medium(h: F): Medium {
    const a = this.params;
    const rhoR = exp(h.div(-a.rayleighScaleHeight));
    const rhoM = exp(h.div(-a.mieScaleHeight));
    const rhoO = max(float(1).sub(abs(h.sub(a.ozoneCenter)).div(a.ozoneHalfWidth)), 0);
    const scatterR = vec3(...a.rayleighScattering)
      .mul(rhoR)
      .mul(this.density);
    const scatterM = float(a.mieScattering).mul(rhoM).mul(this.density);
    const extinction = scatterR.add(float(a.mieExtinction).mul(rhoM).mul(this.density)).add(
      vec3(...a.ozoneAbsorption)
        .mul(rhoO)
        .mul(this.density),
    );
    return { scatterR: scatterR as V3, scatterM: scatterM as F, extinction: extinction as V3 };
  }

  /** Transmittance from radius r along direction cosine μ to the top of the atmosphere. */
  transmittanceToTop(r: F, mu: F): V3 {
    const a = this.params;
    const R = a.groundRadius;
    const top = a.topRadius;
    const H = Math.sqrt(top * top - R * R);
    const rho = sqrt(max(r.mul(r).sub(R * R), 0));
    const disc = r
      .mul(r)
      .mul(mu.mul(mu).sub(1))
      .add(top * top);
    const d = max(
      r
        .negate()
        .mul(mu)
        .add(sqrt(max(disc, 0))),
      0,
    );
    const dMin = float(top).sub(r);
    const dMax = rho.add(H);
    const xMu = d.sub(dMin).div(max(dMax.sub(dMin), 1e-3));
    const u = xMu.mul(1 - 1 / TRANSMITTANCE_WIDTH).add(0.5 / TRANSMITTANCE_WIDTH);
    const v = rho
      .div(H)
      .mul(1 - 1 / TRANSMITTANCE_HEIGHT)
      .add(0.5 / TRANSMITTANCE_HEIGHT);
    return texture(this.lut, vec2(u, v)).level(int(0)).rgb as V3;
  }

  /**
   * Transmittance of light from a distant source along unit `direction` at a
   * planet-centered point: through the air, and zero in the planet's shadow
   * (with a penumbra about the sun's size).
   */
  lightTransmittance(p: V3, direction: V3): V3 {
    const R = this.params.groundRadius;
    const r = length(p);
    const mu = dot(p, direction).div(r);
    const muHorizon = sqrt(max(float(1).sub(float(R * R).div(r.mul(r))), 0)).negate();
    const lit = smoothstep(muHorizon.sub(0.006), muHorizon.add(0.006), mu);
    const t = this.transmittanceToTop(r, mu).mul(lit) as V3;
    return select(this.enabled.greaterThan(0.5), t, vec3(lit)) as V3;
  }

  /** Sunlight transmittance at a planet-centered point (`lightTransmittance` toward the sun). */
  sunTransmittance(p: V3): V3 {
    return this.lightTransmittance(p, this.u.sunDirection as unknown as V3);
  }

  /**
   * Ψ at a planet-centered point for a light along unit `direction`: the light
   * of every scattering order above the first, per unit illuminance
   * (multiply by the scattering coefficient for a source term).
   */
  multiScattering(p: V3, direction: V3): V3 {
    const a = this.params;
    const n = MULTI_SCATTERING_SIZE;
    const r = length(p);
    const mu = dot(p, direction).div(r);
    const h = clamp(r.sub(a.groundRadius).div(a.topRadius - a.groundRadius), 0, 1);
    const u = clamp(mu.mul(0.5).add(0.5), 0, 1)
      .mul(1 - 1 / n)
      .add(0.5 / n);
    const v = h.mul(1 - 1 / n).add(0.5 / n);
    return texture(this.multiScatteringLut, vec2(u, v)).level(int(0)).rgb as V3;
  }

  /** Rayleigh phase function of the cosine of the scattering angle. */
  static rayleighPhase(cosTheta: F): F {
    return cosTheta
      .mul(cosTheta)
      .add(1)
      .mul(3 / (16 * Math.PI)) as F;
  }

  /** Henyey–Greenstein phase function of the cosine of the scattering angle. */
  static hgPhase(cosTheta: F, g: number): F {
    return float((1 - g * g) / (4 * Math.PI)).div(
      float(1 + g * g)
        .sub(cosTheta.mul(2 * g))
        .pow(1.5),
    ) as F;
  }

  /**
   * Scattering along ro + rd·t for t in [t0, t1] (planet-centered): single
   * scattering of sunlight step by step, and multiple scattering with Ψ read
   * once at the middle of each of `segments` equal parts of the ray. `steps`
   * is the total and must be a multiple of `segments`. Emits loops, so call
   * it inside an Fn.
   *
   * `moonlit` adds the air lit by the moon, so that by night distant ground
   * fades into the moonlit sky as it fades into the sun's by day: per
   * segment, the moon's transmittance and Ψ at the segment's middle (two
   * reads, behind a branch on the moon's illuminance: none by day). Its
   * light is scaled to the result's unit, the sun's illuminance.
   */
  march(ro: V3, rd: V3, t0: F, t1: F, steps: number, segments = 2, moonlit = false): ScatterResult {
    const a = this.params;
    const sun = this.u.sunDirection as unknown as V3;
    const cosTheta = dot(rd, sun) as F;
    const phaseR = AtmosphereNodes.rayleighPhase(cosTheta);
    const phaseM = AtmosphereNodes.hgPhase(cosTheta, a.mieG);
    const per = Math.max(1, Math.round(steps / segments));

    const inscatter = vec3(0).toVar();
    const transmittance = vec3(1).toVar();
    const dt = t1
      .sub(t0)
      .div(per * segments)
      .toVar();
    const toMoon = this.moon.moonDirection as unknown as V3;
    const cosMoon = dot(rd, toMoon) as F;
    for (let s = 0; s < segments; s++) {
      // ∫ T·σs over the segment, to be multiplied by Ψ at its middle; and its Mie part.
      const diffuse = vec3(0).toVar();
      const diffuseMie = vec3(0).toVar();
      Loop(per, ({ i }) => {
        const t = t0.add(
          float(i)
            .add(s * per + 0.5)
            .mul(dt),
        );
        const p = ro.add(rd.mul(t)) as V3;
        const h = max(length(p).sub(a.groundRadius), 0) as F;
        const air = this.medium(h);
        const scattered = air.scatterR
          .mul(phaseR)
          .add(vec3(air.scatterM.mul(phaseM)))
          .mul(this.sunTransmittance(p));
        const stepT = exp(air.extinction.mul(dt).negate());
        // ∫ S·T over the step, energy-conserving (Hillaire 2020).
        const weight = transmittance
          .sub(transmittance.mul(stepT))
          .div(max(air.extinction, vec3(1e-12)));
        inscatter.addAssign(weight.mul(scattered));
        diffuse.addAssign(weight.mul(air.scatterR.add(vec3(air.scatterM))));
        if (moonlit) diffuseMie.addAssign(weight.mul(air.scatterM));
        transmittance.mulAssign(stepT);
      });
      const middle = ro.add(rd.mul(t0.add(dt.mul((s + 0.5) * per)))).toVar() as V3;
      inscatter.addAssign(diffuse.mul(this.multiScattering(middle, sun)));
      if (moonlit) {
        If(this.moon.moonIlluminance.greaterThan(0), () => {
          const single = diffuse
            .sub(diffuseMie)
            .mul(AtmosphereNodes.rayleighPhase(cosMoon))
            .add(diffuseMie.mul(AtmosphereNodes.hgPhase(cosMoon, a.mieG)));
          const light = vec3(...MOON_TINT).mul(
            this.moon.moonIlluminance.div(max(this.u.sunIlluminance, 1e-6)),
          );
          inscatter.addAssign(
            single
              .mul(this.lightTransmittance(middle, toMoon))
              .add(diffuse.mul(this.multiScattering(middle, toMoon)))
              .mul(light),
          );
        });
      }
    }
    return { inscatter, transmittance };
  }

  /** Ray–sphere intersection (t near, t far); far < 0 means a miss. */
  static raySphere(ro: V3, rd: V3, radius: number): Node<'vec2'> {
    const b = dot(ro, rd);
    const c = dot(ro, ro).sub(radius * radius);
    const disc = b.mul(b).sub(c);
    const s = sqrt(max(disc, 0));
    return select(
      disc.lessThan(0),
      vec2(-1, -1),
      vec2(b.negate().sub(s), b.negate().add(s)),
    ) as Node<'vec2'>;
  }

  dispose(): void {
    this.lut.dispose();
    this.multiScatteringLut.dispose();
    this.irradiance.dispose();
    this.sky.dispose();
  }
}
