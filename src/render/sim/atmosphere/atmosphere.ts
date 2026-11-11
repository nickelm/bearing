/**
 * Single-scattering atmosphere in TSL (decision 35).
 *
 * - The transmittance LUT (model.ts) is computed on the CPU and uploaded as
 *   a half-float texture. Every sunlight and view-path transmittance lookup
 *   goes through it.
 * - `march` integrates single scattering along a ray segment. It is shared
 *   by the sky (per pixel, behind everything) and aerial perspective on
 *   surfaces (per vertex).
 * - Sky light on surfaces comes from a 1D irradiance LUT over the sun's
 *   elevation (model.ts, also computed on the CPU).
 * - Aerial perspective: `aerialPerspective` marches from the camera to a
 *   surface point. Materials call it per vertex and pass the result to the
 *   fragment stage as varyings, because scattering varies slowly.
 * - The sky is `scene.backgroundNode`. Three draws the background on a unit
 *   sphere at the camera, so with the camera at the origin the geometry
 *   normal is the view ray.
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
import type { Node, UniformNode, Vector3 } from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  exp,
  float,
  Fn,
  If,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  normalWorldGeometry,
  select,
  smoothstep,
  sqrt,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import {
  computeSkyIrradianceLut,
  computeTransmittanceLut,
  IRRADIANCE_MU_MIN,
  IRRADIANCE_SIZE,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
} from './model';
import type { AtmosphereParams } from './model';

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

/** Sun's angular radius, slightly enlarged so the disk reads at screen resolution. */
const SUN_RADIUS = 0.6 * (Math.PI / 180);

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
  readonly irradiance = lutTexture(IRRADIANCE_SIZE, 1);
  /** Multiplies every coefficient in the shaders (the LUT is rebuilt to match). */
  readonly density = uniform(1);
  /** Atmosphere on (1) or off (0): off leaves sunlight unfiltered and the sky black. */
  readonly enabled = uniform(1);
  /** Sun disk radiance relative to the sun illuminance. */
  readonly sunDiskRadiance = uniform(60);

  constructor(
    readonly params: AtmosphereParams,
    private readonly u: AtmosphereUniforms,
  ) {
    this.rebuild();
  }

  /** Recomputes the LUTs after a parameter change (e.g. density). */
  rebuild(): void {
    const transmittance = computeTransmittanceLut(this.params);
    upload(this.lut, transmittance);
    upload(this.irradiance, computeSkyIrradianceLut(this.params, transmittance));
    this.density.value = this.params.density;
  }

  /**
   * Sky light on a surface per unit sun illuminance (already divided by π),
   * for the sun-elevation cosine at the point. Horizontal-surface irradiance;
   * the caller weights it by how much sky the normal sees.
   */
  skyIrradiance(muS: F): V3 {
    const x = clamp(muS.sub(IRRADIANCE_MU_MIN).div(1 - IRRADIANCE_MU_MIN), 0, 1);
    const u = x.mul(1 - 1 / IRRADIANCE_SIZE).add(0.5 / IRRADIANCE_SIZE);
    return texture(this.irradiance, vec2(u, 0.5)).rgb.mul(this.enabled) as V3;
  }

  /**
   * Aerial perspective between the camera and a surface point given
   * camera-relative (`relative`). The in-scattered light is per unit sun
   * illuminance. Emits a loop, so call it inside an Fn (e.g. a position node).
   */
  aerialPerspective(relative: V3, steps = 10): ScatterResult {
    const ro = this.u.eye as unknown as V3;
    const dist = length(relative);
    const rd = relative.div(max(dist, 1e-3)) as V3;
    const top = AtmosphereNodes.raySphere(ro, rd, this.params.topRadius);
    const t0 = max(top.x, 0);
    const t1 = max(min(dist, top.y), t0);
    const s = this.march(ro, rd, t0 as F, t1 as F, steps);
    return {
      inscatter: s.inscatter.mul(this.enabled) as V3,
      transmittance: mix(vec3(1), s.transmittance, this.enabled) as V3,
    };
  }

  setDensity(d: number): void {
    this.params.density = d;
    this.rebuild();
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
    return texture(this.lut, vec2(u, v)).rgb as V3;
  }

  /**
   * Sunlight transmittance at a planet-centered point: through the air to the
   * sun, and zero in the planet's shadow (with a penumbra about the sun's size).
   */
  sunTransmittance(p: V3): V3 {
    const R = this.params.groundRadius;
    const r = length(p);
    const mu = dot(p, this.u.sunDirection).div(r);
    const muHorizon = sqrt(max(float(1).sub(float(R * R).div(r.mul(r))), 0)).negate();
    const lit = smoothstep(muHorizon.sub(0.006), muHorizon.add(0.006), mu);
    const t = this.transmittanceToTop(r, mu).mul(lit) as V3;
    return select(this.enabled.greaterThan(0.5), t, vec3(lit)) as V3;
  }

  /**
   * Single scattering along ro + rd·t for t in [t0, t1] (planet-centered).
   * Emits a loop, so call it inside an Fn.
   */
  march(ro: V3, rd: V3, t0: F, t1: F, steps: number): ScatterResult {
    const a = this.params;
    const sun = this.u.sunDirection;
    const cosTheta = dot(rd, sun);
    // Rayleigh and Henyey–Greenstein (Mie) phase functions.
    const phaseR = cosTheta
      .mul(cosTheta)
      .add(1)
      .mul(3 / (16 * Math.PI));
    const g = a.mieG;
    const phaseM = float((1 - g * g) / (4 * Math.PI)).div(
      float(1 + g * g)
        .sub(cosTheta.mul(2 * g))
        .pow(1.5),
    );
    const betaR = vec3(...a.rayleighScattering);
    const betaO = vec3(...a.ozoneAbsorption);

    const inscatter = vec3(0).toVar();
    const transmittance = vec3(1).toVar();
    const dt = t1.sub(t0).div(steps).toVar();
    Loop(steps, ({ i }) => {
      const t = t0.add(float(i).add(0.5).mul(dt));
      const p = ro.add(rd.mul(t));
      const h = max(length(p).sub(a.groundRadius), 0);
      const rhoR = exp(h.div(-a.rayleighScaleHeight));
      const rhoM = exp(h.div(-a.mieScaleHeight));
      const rhoO = max(float(1).sub(abs(h.sub(a.ozoneCenter)).div(a.ozoneHalfWidth)), 0);
      const scatterR = betaR.mul(rhoR);
      const scatterM = float(a.mieScattering).mul(rhoM);
      const extinction = scatterR
        .add(float(a.mieExtinction).mul(rhoM))
        .add(betaO.mul(rhoO))
        .mul(this.density);
      const scattered = scatterR
        .mul(phaseR)
        .add(vec3(scatterM.mul(phaseM)))
        .mul(this.density)
        .mul(this.sunTransmittance(p));
      const stepT = exp(extinction.mul(dt).negate());
      // ∫ S·T over the step, energy-conserving (Hillaire 2020).
      const integral = scattered.sub(scattered.mul(stepT)).div(max(extinction, vec3(1e-12)));
      inscatter.addAssign(transmittance.mul(integral));
      transmittance.mulAssign(stepT);
    });
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

  /** The sky behind everything: single scattering along the view ray, plus the sun disk. */
  skyNode(steps = 32): V3 {
    const a = this.params;
    return Fn(() => {
      const rd = normalize(normalWorldGeometry) as V3;
      const ro = this.u.eye as unknown as V3;
      const color = vec3(0).toVar();
      const viewT = vec3(1).toVar();
      const topHit = AtmosphereNodes.raySphere(ro, rd, a.topRadius);
      const groundHit = AtmosphereNodes.raySphere(ro, rd, a.groundRadius);
      const hitsGround = groundHit.y.greaterThan(0).and(groundHit.x.greaterThan(0));
      If(topHit.y.greaterThan(0).and(this.enabled.greaterThan(0.5)), () => {
        const t0 = max(topHit.x, 0);
        const t1 = select(hitsGround, groundHit.x, topHit.y);
        const s = this.march(ro, rd, t0, t1, steps);
        color.assign(s.inscatter.mul(this.u.sunIlluminance));
        viewT.assign(s.transmittance);
      });
      const disk = smoothstep(
        Math.cos(SUN_RADIUS * 1.15),
        Math.cos(SUN_RADIUS),
        dot(rd, this.u.sunDirection),
      );
      const sunVisible = select(hitsGround, float(0), disk);
      color.addAssign(viewT.mul(sunVisible).mul(this.sunDiskRadiance).mul(this.u.sunIlluminance));
      return color;
    })() as V3;
  }
}
