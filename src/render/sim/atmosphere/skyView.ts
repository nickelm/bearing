/**
 * The sky (decision 140): a sky-view LUT in place of a march per pixel, with
 * the sun, the moon and the stars drawn over it.
 *
 * **Sky-view LUT** (Hillaire 2020, section 5.3). The air's light toward every
 * direction from the camera is baked into two small textures in a local
 * frame at the camera: u is the azimuth around the vertical, measured from
 * the sun's; v the zenith angle, with the square root of the angle from the
 * sea-level horizon on either side of it, so the rows crowd where the sky
 * changes fastest (model.ts, `skyViewUv`). A compute pass marches each texel
 * (`SKY_VIEW_STEPS` samples, spaced as model.ts's `skyStepFraction`) whenever
 * the camera's height, the sun, the moon, the light or the air has changed
 * by more than a threshold too small to see. A sky pixel then costs two
 * filtered texture reads instead of 32 march steps.
 *
 * - `base` holds Rayleigh single scattering with its phase function, plus
 *   multiple scattering, plus the air lit by the moon and the night sky's
 *   own faint glow.
 * - `mie` holds the sun's Mie single scattering *without* its phase
 *   function. The phase function depends only on the angle between the view
 *   ray and the sun, which is constant along a ray, so it factors out of the
 *   integral exactly; the pixel multiplies it back in. The glow around the
 *   sun is therefore analytic and as sharp as the phase function, at any LUT
 *   resolution, and the LUT holds only smooth functions.
 *
 * Both hold display units (atmosphere.ts's `inScatter` and the illuminances
 * applied).
 *
 * **Above the envelope.** The simulation view ends at 20 km, but the debug
 * free camera climbs to orbit, where the atmosphere is a thin shell far
 * below and the LUT's rows cannot resolve it. Between `MARCH_FROM` and
 * `MARCH_FULL` of altitude the sky cross-fades from the LUT to the march
 * of atmosphere.ts (32 steps per pixel, as before decision 140); above, it
 * is the march alone and nothing is baked. Both are uniform branches.
 *
 * **Sun.** A disk of `SUN_ANGULAR_RADIUS` (1.5 times the real one, so it
 * reads at screen resolution) with limb darkening, seen through the air's
 * transmittance, bright enough for the pipeline's bloom to give it a halo.
 *
 * **Moon.** A disk of `MOON_ANGULAR_RADIUS` (twice the real one) shaded as a
 * sphere lit from the sun's direction, which gives the phase and turns the
 * lit limb toward the sun; faint earthshine on the dark side, a few maria.
 *
 * **Stars.** One star per cell of a cube-face grid on the celestial sphere,
 * placed and sized by an integer hash of the cell: no texture. Few are
 * bright and many faint. The field turns with `starRotation` (core/moon.ts,
 * `celestialRotation`), twinkles with `clock`, dims through the air toward
 * the horizon and appears as the sky darkens, the bright stars first. Each
 * star is a Gaussian about a pixel and a half wide whatever the resolution,
 * which a moving camera samples without flicker. `stars` = 0 skips all of
 * it: day costs no star evaluation.
 */
import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  RepeatWrapping,
  StorageTexture,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { ComputeNode, Node, UniformNode, WebGPURenderer } from 'three/webgpu';
import {
  abs,
  acos,
  atan,
  clamp,
  cos,
  dFdx,
  dot,
  exp,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  normalize,
  normalWorldGeometry,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  textureStore,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DEG, KM } from '../../../core/units';
import { AtmosphereNodes } from './atmosphere';
import { LUMA, SKY_STEP_LINEAR, SKY_VIEW_HEIGHT, SKY_VIEW_WIDTH, skyViewHorizon } from './model';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** Samples per texel of the sky-view LUT's bake. */
export const SKY_VIEW_STEPS = 48;
/** Steps per pixel of the march that stands in for the LUT above `MARCH_FROM`. */
export const SKY_MARCH_STEPS = 32;
/** Steps of that march for surfaces that mirror or borrow the sky's color (`SkyView.radiance`). */
export const SKY_MARCH_STEPS_COARSE = 8;
/** Camera altitudes between which the sky cross-fades from the LUT to the march. */
export const MARCH_FROM = 30 * KM;
export const MARCH_FULL = 50 * KM;

/** The sun's angular radius as drawn: 1.5 times the real 0.267°. */
export const SUN_ANGULAR_RADIUS = 0.4 * DEG;
/** The moon's angular radius as drawn: twice the real 0.259°. */
export const MOON_ANGULAR_RADIUS = 0.52 * DEG;
/**
 * Color of moonlight relative to sunlight: cool, as moonlit scenes are read.
 * Bluer than it looks here, because the air takes blue out of it on the way
 * down (a third at 20° of elevation).
 */
export const MOON_TINT: readonly [number, number, number] = [0.42, 0.64, 1.0];
/**
 * Radiance of the night sky's own light (airglow and unresolved stars) at the
 * zenith, display units: what keeps a moonless sky a shade above black (a
 * dark navy, up to 2.5 times brighter toward the horizon), so the land
 * stands against it.
 */
export const NIGHT_GLOW: readonly [number, number, number] = [0.0035, 0.005, 0.01];

/** Star cells per cube-face edge: 6·64² cells of about 1.4°, of which about a quarter hold a star. */
const STAR_CELLS = 64;
/** Share of the cells with a star, away from the galaxy's band and in its middle. */
const STAR_PRESENCE = 0.22;
const STAR_PRESENCE_BAND = 0.5;
/**
 * How far from its cell's middle a star may sit, as a share of the half cell.
 * The rest is a margin of 0.21° to the cell's edge, which holds a star's
 * Gaussian down to about 540 lines of a 50° view, so no pixel has to look
 * into neighboring cells.
 */
const STAR_JITTER = 0.7;
/** Standard deviation of a star's Gaussian, in pixels. */
const STAR_SIGMA = 0.75;
/** Unit vectors of the galaxy's pole and its center, in the celestial frame. */
const GALAXY_POLE: readonly [number, number, number] = [0.4558, 0.4924, -0.7415];
const GALAXY_CENTER: readonly [number, number, number] = [0.8517, -0.4924, 0.1794];

/** The lights the sky shares with the lighting (PlanetLighting owns them). */
export interface SkyUniforms {
  /** Unit vector toward the moon, world frame. */
  moonDirection: UniformNode<'vec3', Vector3>;
  /** Moonlight on a surface facing the moon, display units; 0 leaves the moon's light out of the air. */
  moonIlluminance: UniformNode<'float', number>;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Radiance of the moon's sunlit face by day and by night, display units. */
const MOON_DISK_DAY = 0.2;
const MOON_DISK_NIGHT = 1.3;
/** Radiance of the new moon's dark side by night, display units. */
const EARTHSHINE = 0.02;

/**
 * Brightness of the stars, 0..1, at a sun elevation (rad) at the camera:
 * exactly 0 until the sun is 1.5° down, so day and sunset evaluate no star,
 * and 1 from 8° down. Which stars show is then up to the sky behind them.
 */
export function starVisibility(sunElevation: number): number {
  return smooth(-1.5 * DEG, -8 * DEG, sunElevation);
}

/** How far the sky is the march and not the LUT, 0..1, at a camera altitude above sea level. */
export function marchBlendAt(altitude: number): number {
  return smooth(MARCH_FROM, MARCH_FULL, altitude);
}

/** PCG hash of a 32-bit unsigned integer (as three's `hash`, kept as an integer). */
function pcg(v: Node<'uint'>): Node<'uint'> {
  const state = v.mul(747796405).add(2891336453);
  const word = state.shiftRight(state.shiftRight(28).add(4)).bitXor(state).mul(277803737);
  return word.shiftRight(22).bitXor(word) as Node<'uint'>;
}

const luminance = (c: V3): F => dot(c, vec3(...LUMA)) as F;

export class SkyView {
  /** Rayleigh single scattering, multiple scattering and the moonlit air (display units). */
  readonly base = SkyView.lutTexture();
  /** The sun's Mie single scattering without its phase function (display units). */
  readonly mie = SkyView.lutTexture();
  /** Radiance of the sun's disk at its center, relative to the sun illuminance. */
  readonly sunDisk = uniform(60);
  /** Radiance of the moon's sunlit face, display units; 0 (with no earthshine) draws no moon. */
  readonly moonDisk = uniform(MOON_DISK_DAY);
  /** Radiance of the moon's dark side (earthshine), display units. */
  readonly earthshine = uniform(0);
  /** Brightness of the stars, 0..1; 0 skips them (day). */
  readonly stars = uniform(0);
  /** Cosine and sine of the celestial sphere's rotation about the world's +Y (core/moon.ts). */
  readonly starRotation = uniform(new Vector2(1, 0));
  /** How much of `NIGHT_GLOW` the sky carries, 0..1 (how far night has fallen). */
  readonly nightGlow = uniform(0);
  /** Animation clock for the twinkle (`WeatherState.clock`, s). */
  readonly clock = uniform(0);
  /** 0 the LUT, 1 the march; set by `update` from the camera's altitude. */
  readonly marchBlend = uniform(0);
  /** Draw the sky by the march at any altitude: for comparisons and tests. */
  forceMarch = false;
  /** Bakes done so far (statistics and tests). */
  bakes = 0;

  // The local frame at the camera, refreshed every frame.
  private readonly up = uniform(new Vector3(0, 1, 0));
  private readonly toSun = uniform(new Vector3(1, 0, 0));
  private readonly side = uniform(new Vector3(0, 0, 1));
  /** Zenith angle of the sea-level horizon, and the angle from there to the nadir. */
  private readonly horizon = uniform(new Vector2(Math.PI / 2, Math.PI / 2));

  // What the bake reads: set when a bake is due.
  private readonly bakeRadius = uniform(1);
  /** r² − R² and r² − top², from float64. */
  private readonly bakeChords = uniform(new Vector2());
  private readonly bakeHorizon = uniform(new Vector2(Math.PI / 2, Math.PI / 2));
  private readonly bakeSun = uniform(new Vector3(1, 0, 0));
  private readonly bakeMoon = uniform(new Vector3(0, -1, 0));
  private readonly bakeSunLight = uniform(0);
  private readonly bakeMoonLight = uniform(0);
  private readonly bakeGlow = uniform(0);

  private kernel: ComputeNode | null = null;
  private baked = {
    r: Number.NaN,
    muS: 0,
    sunLight: 0,
    moonLight: 0,
    moon: new Vector3(),
    glow: 0,
    version: -1,
    density: 0,
    enabled: -1,
    inScatter: 0,
    vibrance: 0,
  };

  constructor(
    private readonly air: AtmosphereNodes,
    private readonly u: SkyUniforms,
  ) {}

  private static lutTexture(): StorageTexture {
    const t = new StorageTexture(SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT);
    t.type = HalfFloatType;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    // The azimuth wraps; the zenith angle does not.
    t.wrapS = RepeatWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false;
    return t;
  }

  /**
   * Sets the night sky for a frame: the stars' brightness from the sun's
   * elevation at the camera (rad), the moon's disk from how far night has
   * fallen (`night`, 0..1) and the lit fraction of its face, the celestial
   * sphere's rotation (rad, core/moon.ts) and the twinkle's clock (s).
   */
  setCelestial(
    sunElevation: number,
    night: number,
    litFraction: number,
    rotation: number,
    clock: number,
  ): void {
    this.stars.value = starVisibility(sunElevation);
    this.moonDisk.value = MOON_DISK_DAY + (MOON_DISK_NIGHT - MOON_DISK_DAY) * night;
    this.earthshine.value = EARTHSHINE * night * (1 - litFraction);
    this.nightGlow.value = night;
    this.starRotation.value.set(Math.cos(rotation), Math.sin(rotation));
    this.clock.value = clock;
  }

  /**
   * Refreshes the local frame at the camera and bakes the LUT if what it
   * depends on has changed. Call once per frame after the lighting's update.
   * Returns whether it baked.
   */
  update(renderer: WebGPURenderer): boolean {
    const air = this.air;
    const P = air.params;
    const eye = air.u.eye.value;
    const sun = air.u.sunDirection.value;
    const moon = this.u.moonDirection.value;
    const distance = eye.length();
    const r = Math.max(distance, P.groundRadius + 1);
    const up = this.up.value;
    if (distance > 0) up.copy(eye).divideScalar(distance);
    else up.set(0, 1, 0);
    const muS = Math.min(1, Math.max(-1, sun.dot(up)));
    // The azimuth's origin: the sun's direction along the ground (any, if it stands overhead).
    const toSun = this.toSun.value.copy(sun).addScaledVector(up, -muS);
    if (toSun.lengthSq() < 1e-8) {
      toSun.set(up.y, -up.x, 0);
      if (toSun.lengthSq() < 1e-8) toSun.set(1, 0, 0);
    }
    toSun.normalize();
    this.side.value.crossVectors(up, toSun);
    const { horizon, below } = skyViewHorizon(P, r);
    this.horizon.value.set(horizon, below);
    this.marchBlend.value = this.forceMarch ? 1 : marchBlendAt(r - P.groundRadius);
    if (this.marchBlend.value >= 1) return false;

    const sunLight = air.u.sunIlluminance.value;
    const moonLight = this.u.moonIlluminance.value;
    const moonLocal = new Vector3(moon.dot(toSun), moon.dot(up), moon.dot(this.side.value));
    const b = this.baked;
    const relative = (x: number, y: number) => Math.abs(x - y) > 2e-3 * Math.max(x, y);
    const stale =
      !(Math.abs(r - b.r) <= 0.25 + 2e-4 * (b.r - P.groundRadius)) ||
      Math.abs(muS - b.muS) > 2e-5 ||
      relative(sunLight, b.sunLight) ||
      relative(moonLight, b.moonLight) ||
      (moonLight > 0 && moonLocal.distanceToSquared(b.moon) > 1e-7) ||
      Math.abs(this.nightGlow.value - b.glow) > 2e-3 ||
      air.version !== b.version ||
      air.density.value !== b.density ||
      air.enabled.value !== b.enabled ||
      air.inScatter.value !== b.inScatter ||
      Math.abs(air.vibrance.value - b.vibrance) > 1e-3;
    if (!stale) return false;

    this.bakeRadius.value = r;
    this.bakeChords.value.set(
      (r - P.groundRadius) * (r + P.groundRadius),
      (r - P.topRadius) * (r + P.topRadius),
    );
    this.bakeHorizon.value.set(horizon, below);
    this.bakeSun.value.set(Math.sqrt(1 - muS * muS), muS, 0);
    this.bakeMoon.value.copy(moonLocal);
    this.bakeSunLight.value = sunLight;
    this.bakeMoonLight.value = moonLight;
    this.bakeGlow.value = this.nightGlow.value;
    this.kernel ??= this.bakeKernel();
    void renderer.compute(this.kernel);
    b.r = r;
    b.muS = muS;
    b.sunLight = sunLight;
    b.moonLight = moonLight;
    b.moon.copy(moonLocal);
    b.glow = this.nightGlow.value;
    b.version = air.version;
    b.density = air.density.value;
    b.enabled = air.enabled.value;
    b.inScatter = air.inScatter.value;
    b.vibrance = air.vibrance.value;
    this.bakes++;
    return true;
  }

  /**
   * The compute pass that fills both textures: one invocation per texel, in
   * the local frame (camera on the y axis, sun in the x–y plane).
   */
  private bakeKernel(): ComputeNode {
    const air = this.air;
    const P = air.params;
    const W = SKY_VIEW_WIDTH;
    const H = SKY_VIEW_HEIGHT;
    const N = SKY_VIEW_STEPS;
    const spacing = (x: F): F => x.mul(float(SKY_STEP_LINEAR).add(x.mul(1 - SKY_STEP_LINEAR))) as F;
    return Fn(() => {
      const row = instanceIndex.div(W);
      const column = instanceIndex.sub(row.mul(W));
      // Texel centers span the unit range of v (model.ts, `skyViewAngles`).
      const unit = clamp(
        float(row)
          .add(0.5)
          .div(H)
          .sub(0.5 / H)
          .div(1 - 1 / H),
        0,
        1,
      );
      const above = unit.lessThan(0.5);
      const ka = float(1).sub(unit.mul(2));
      const kb = unit.mul(2).sub(1);
      const zenith = select(
        above,
        this.bakeHorizon.x.mul(float(1).sub(ka.mul(ka))),
        this.bakeHorizon.x.add(this.bakeHorizon.y.mul(kb.mul(kb))),
      ).toVar();
      const azimuth = float(column)
        .add(0.5)
        .div(W)
        .sub(0.5)
        .mul(2 * Math.PI);
      const sinZ = sin(zenith);
      const rd = vec3(sinZ.mul(cos(azimuth)), cos(zenith), sinZ.mul(sin(azimuth))).toVar();
      const ro = vec3(0, this.bakeRadius, 0);
      // Rays above the horizon end at the top of the air, the others on the ground. The
      // discriminants take r² − R² from the CPU: float32 loses it near the horizon.
      const b = this.bakeRadius.mul(rd.y);
      const toTop = b.negate().add(sqrt(max(b.mul(b).sub(this.bakeChords.y), 0)));
      const toGround = b.negate().sub(sqrt(max(b.mul(b).sub(this.bakeChords.x), 0)));
      const reach = max(select(above, toTop, toGround), 0).toVar();

      const sun = this.bakeSun as unknown as V3;
      const moon = this.bakeMoon as unknown as V3;
      const cosSun = dot(rd, sun) as F;
      const cosMoon = dot(rd, moon) as F;
      const phaseR = AtmosphereNodes.rayleighPhase(cosSun);
      const moonR = AtmosphereNodes.rayleighPhase(cosMoon);
      const moonM = AtmosphereNodes.hgPhase(cosMoon, P.mieG);
      const moonLight = vec3(...MOON_TINT).mul(this.bakeMoonLight);

      const base = vec3(0).toVar();
      const mie = vec3(0).toVar();
      const transmittance = vec3(1).toVar();
      Loop(N, ({ i }) => {
        const ta = reach.mul(spacing(float(i).div(N) as F));
        const tb = reach.mul(spacing(float(i).add(1).div(N) as F));
        const dt = tb.sub(ta);
        const p = ro.add(rd.mul(ta.add(tb).mul(0.5))).toVar();
        const h = max(length(p).sub(P.groundRadius), 0) as F;
        const m = air.medium(h);
        const scatterR = m.scatterR.toVar();
        const scatterM = m.scatterM.toVar();
        const extinction = m.extinction.toVar();
        const stepT = exp(extinction.mul(dt).negate()).toVar();
        // ∫ T over the step, energy-conserving (Hillaire 2020).
        const weight = transmittance
          .sub(transmittance.mul(stepT))
          .div(max(extinction, vec3(1e-12)))
          .toVar();
        const all = scatterR.add(vec3(scatterM)).toVar();
        const sunT = air.lightTransmittance(p as V3, sun).toVar();
        base.addAssign(
          weight
            .mul(
              scatterR
                .mul(phaseR)
                .mul(sunT)
                .add(all.mul(air.multiScattering(p as V3, sun))),
            )
            .mul(this.bakeSunLight),
        );
        mie.addAssign(weight.mul(sunT).mul(scatterM).mul(this.bakeSunLight));
        If(this.bakeMoonLight.greaterThan(0), () => {
          const single = scatterR.mul(moonR).add(vec3(scatterM.mul(moonM)));
          base.addAssign(
            weight
              .mul(
                single
                  .mul(air.lightTransmittance(p as V3, moon))
                  .add(all.mul(air.multiScattering(p as V3, moon))),
              )
              .mul(moonLight),
          );
        });
        transmittance.mulAssign(stepT);
      });
      const scale = air.enabled.mul(air.inScatter);
      // The night's own glow, brighter toward the horizon where the line of sight
      // through its layer is longer; nothing of it in front of the ground.
      const slant = float(1).add(pow(float(1).sub(clamp(rd.y, 0, 1)), 3).mul(1.5));
      const glow = vec3(...NIGHT_GLOW)
        .mul(this.bakeGlow.mul(slant))
        .mul(select(above, 1, 0));
      const texel = uvec2(column, row);
      // Graded here, once per texel: the grade is linear, so the two parts take it apart.
      textureStore(
        this.base,
        texel,
        vec4(
          air
            .graded(base as V3)
            .mul(scale)
            .add(glow),
          1,
        ),
      ).toWriteOnly();
      textureStore(this.mie, texel, vec4(air.graded(mie as V3).mul(scale), 1)).toWriteOnly();
    })().compute(W * H);
  }

  /** LUT coordinates of a world-space unit direction (TSL twin of model.ts's `skyViewUv`). */
  private lutUv(rd: V3): V2 {
    const y = dot(rd, this.up);
    const x = dot(rd, this.toSun);
    const z = dot(rd, this.side);
    const zenith = acos(clamp(y, -1, 1));
    const above = step(zenith, this.horizon.x);
    const upper = float(0.5).mul(
      float(1).sub(sqrt(max(float(1).sub(zenith.div(this.horizon.x)), 0))),
    );
    const lower = float(0.5).add(
      float(0.5).mul(sqrt(clamp(zenith.sub(this.horizon.x).div(this.horizon.y), 0, 1))),
    );
    const v = mix(lower, upper, above);
    // At the zenith and the nadir the azimuth is arbitrary: keep atan's arguments off (0, 0).
    const overhead = step(abs(x).add(abs(z)), 1e-6);
    const u = atan(z, x.add(overhead))
      .div(2 * Math.PI)
      .add(0.5);
    return vec2(u, v.mul(1 - 1 / SKY_VIEW_HEIGHT).add(0.5 / SKY_VIEW_HEIGHT)) as V2;
  }

  /** The LUT's sky toward a world-space unit direction: two texture reads and the Mie phase function. */
  private lookup(rd: V3): V3 {
    const uv = this.lutUv(rd).toVar();
    const base = texture(this.base, uv).level(int(0)).rgb;
    const mie = texture(this.mie, uv).level(int(0)).rgb;
    const phase = AtmosphereNodes.hgPhase(
      dot(rd, this.air.u.sunDirection) as F,
      this.air.params.mieG,
    );
    // The grade can push a channel of either part below zero.
    return max(base.add(mie.mul(phase)), 0) as V3;
  }

  /** The march along a view ray from the camera: in-scattered light (display units) and transmittance. */
  private marched(
    rd: V3,
    steps = SKY_MARCH_STEPS,
    segments = 4,
  ): { radiance: V3; transmittance: V3 } {
    const air = this.air;
    const ro = air.u.eye as unknown as V3;
    const radiance = vec3(0).toVar();
    const transmittance = vec3(1).toVar();
    const topHit = AtmosphereNodes.raySphere(ro, rd, air.params.topRadius);
    const groundHit = AtmosphereNodes.raySphere(ro, rd, air.params.groundRadius);
    const hitsGround = groundHit.y.greaterThan(0).and(groundHit.x.greaterThan(0));
    If(topHit.y.greaterThan(0).and(air.enabled.greaterThan(0.5)), () => {
      const t0 = max(topHit.x, 0);
      const t1 = select(hitsGround, groundHit.x, topHit.y);
      const s = air.march(ro, rd, t0 as F, t1 as F, steps, segments, true);
      radiance.assign(max(air.graded(s.inscatter), 0).mul(air.u.sunIlluminance.mul(air.inScatter)));
      transmittance.assign(s.transmittance);
    });
    return { radiance: radiance as V3, transmittance: transmittance as V3 };
  }

  /**
   * The air's light toward a world-space unit direction, in display units,
   * without the sun's disk, the moon or the stars: the LUT inside the
   * simulation view's envelope, the march far above it (see the file
   * comment). Usable in any shader stage. `marchSteps` is the march's
   * length per call above the envelope: the default is the background's;
   * a surface that only mirrors or borrows the sky's color (water, fog)
   * should pass `SKY_MARCH_STEPS_COARSE`, or from orbit each of its pixels
   * costs a whole sky pixel.
   */
  radiance(rd: V3, marchSteps = SKY_MARCH_STEPS): V3 {
    return Fn(() => {
      const out = vec3(0).toVar();
      If(this.marchBlend.lessThan(1), () => {
        out.assign(this.lookup(rd).mul(float(1).sub(this.marchBlend)));
      });
      If(this.marchBlend.greaterThan(0), () => {
        const segments = marchSteps >= 16 ? 4 : 2;
        out.addAssign(this.marched(rd, marchSteps, segments).radiance.mul(this.marchBlend));
      });
      return out;
    })() as V3;
  }

  /**
   * Transmittance from the camera to space along a world-space unit direction
   * whose zenith angle is `zenith`: zero below the horizon. From outside the
   * atmosphere the ray is taken from where it enters.
   */
  private toSpace(rd: V3, zenith: F): V3 {
    const air = this.air;
    const ro = air.u.eye as unknown as V3;
    const top = AtmosphereNodes.raySphere(ro, rd, air.params.topRadius);
    const entry = ro.add(rd.mul(max(top.x, 0)));
    const r = min(length(entry), air.params.topRadius);
    const t = air.transmittanceToTop(r as F, dot(entry, rd).div(r) as F);
    const clear = select(top.y.greaterThan(0), mix(vec3(1), t, air.enabled), vec3(1));
    return clear.mul(step(zenith, this.horizon.x)) as V3;
  }

  /** The stars and the galaxy's band toward a unit direction, before extinction and the sky's fade. */
  private starField(rd: V3, mu: F, pixel: F, skyLuminance: F): V3 {
    // Into the celestial frame: back by the sphere's rotation about +Y.
    const c = this.starRotation.x;
    const s = this.starRotation.y;
    const d = vec3(rd.x.mul(c).sub(rd.z.mul(s)), rd.y, rd.x.mul(s).add(rd.z.mul(c))).toVar();
    // The cube face the direction falls on, and equi-angular coordinates on it.
    const ad = abs(d);
    const longest = max(ad.x, max(ad.y, ad.z));
    const onX = step(longest, ad.x);
    const onY = float(1).sub(onX).mul(step(longest, ad.y));
    const onZ = float(1).sub(onX).sub(onY);
    const major = d.x.mul(onX).add(d.y.mul(onY)).add(d.z.mul(onZ));
    const plane = d.yz.mul(onX).add(d.zx.mul(onY)).add(d.xy.mul(onZ)).div(longest);
    const face = onY.mul(2).add(onZ.mul(4)).add(step(major, 0));
    const grid = atan(plane)
      .mul(2 / Math.PI)
      .add(0.5)
      .mul(STAR_CELLS)
      .toVar();
    const cell = min(floor(grid), vec2(STAR_CELLS - 1)).toVar();
    const within = grid.sub(cell);
    const seed = cell.x
      .add(cell.y.mul(STAR_CELLS))
      .add(face.mul(STAR_CELLS * STAR_CELLS))
      .toUint();
    const h0 = pcg(seed).toVar();
    const h1 = pcg(h0).toVar();
    const h2 = pcg(h1).toVar();
    const h3 = pcg(h2).toVar();
    const unit = (h: Node<'uint'>): F => h.toFloat().mul(1 / 2 ** 32) as F;
    // The star sits well inside its cell, so no pixel needs a neighbor's star.
    const center = vec2(unit(h0), unit(h1)).sub(0.5).mul(STAR_JITTER).add(0.5);
    const offset = within
      .sub(center)
      .mul(Math.PI / 2 / STAR_CELLS)
      .div(pixel);
    const spot = exp(dot(offset, offset).div(-2 * STAR_SIGMA * STAR_SIGMA));

    // The galaxy: a band around a great circle, brighter toward its center, with more stars in it.
    const latitude = dot(d, vec3(...GALAXY_POLE));
    const band = exp(latitude.mul(latitude).div(-2 * 0.13 * 0.13));
    const bulge = exp(
      dot(d, vec3(...GALAXY_CENTER))
        .sub(1)
        .div(0.12),
    );
    const present = step(
      unit(h3),
      float(STAR_PRESENCE).add(band.mul(STAR_PRESENCE_BAND - STAR_PRESENCE)),
    );

    // Few bright and many faint: a power law of a uniform variate, capped.
    const rank = max(unit(h2), 1e-4);
    const peak = min(pow(rank, -0.9).mul(0.012), 1.8);
    const warmth = unit(h3.shiftRight(8).bitXor(h1));
    const tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.8, 0.58), warmth.mul(warmth));
    // Scintillation: two slow sines per star, stronger near the horizon.
    const depth = float(0.12).add(pow(float(1).sub(clamp(mu, 0, 1)), 4).mul(0.5));
    const rate = unit(h1)
      .mul(3)
      .add(2)
      .mul(2 * Math.PI);
    const phase = unit(h0).mul(2 * Math.PI);
    const flicker = sin(this.clock.mul(rate).add(phase))
      .mul(0.6)
      .add(sin(this.clock.mul(rate.mul(1.618)).add(phase.mul(2.3))).mul(0.4));
    const twinkle = float(1).add(depth.mul(flicker));
    // A star shows once it stands out against the sky behind it: the bright ones first.
    const shows = smoothstep(6, 24, peak.div(skyLuminance.add(1e-4)));
    const star = tint.mul(peak.mul(spot).mul(present).mul(twinkle).mul(shows));
    const glow = vec3(0.78, 0.84, 1.0)
      .mul(band.mul(float(0.0035).add(bulge.mul(0.007))))
      .mul(float(1).sub(smoothstep(0.002, 0.012, skyLuminance)));
    return star.add(glow).mul(this.stars) as V3;
  }

  /** The moon's disk toward a unit direction: rgb radiance (display units) and its coverage in a. */
  private moonAt(rd: V3, cosMoon: F): Node<'vec4'> {
    const moon = this.u.moonDirection as unknown as V3;
    const sun = this.air.u.sunDirection as unknown as V3;
    // The disk as a sphere: q is the offset across it in radii, n the surface normal.
    const q = rd.sub(moon.mul(cosMoon)).div(Math.sin(MOON_ANGULAR_RADIUS)).toVar();
    const rr = dot(q, q).toVar();
    const n = q.sub(moon.mul(sqrt(max(float(1).sub(rr), 0))));
    const lit = dot(n, sun);
    // The real moon is nearly as bright at its limb as at its center.
    const day = smoothstep(0, 0.14, lit).mul(mix(0.72, 1, sqrt(max(lit, 0))));
    // Maria, fixed on the face: the moon keeps one side toward the planet.
    const east = normalize(vec3(moon.z, 0, moon.x.negate()));
    const north = moon.cross(east);
    const f = vec2(dot(q, east), dot(q, north));
    const blot = (x: number, y: number, size: number): F =>
      exp(dot(f.sub(vec2(x, y)), f.sub(vec2(x, y))).div(-size * size)) as F;
    const maria = clamp(
      blot(-0.32, 0.36, 0.3)
        .add(blot(0.18, 0.3, 0.24))
        .add(blot(0.42, -0.02, 0.2))
        .add(blot(-0.12, -0.3, 0.26).mul(0.7)),
      0,
      1,
    );
    const albedo = vec3(1.0, 0.97, 0.92).mul(float(1).sub(maria.mul(0.45)));
    const cover = float(1).sub(smoothstep(0.86, 1, rr));
    const radiance = albedo
      .mul(day.mul(this.moonDisk))
      .add(vec3(0.62, 0.74, 1.0).mul(this.earthshine))
      .mul(cover);
    return vec4(radiance, cover) as Node<'vec4'>;
  }

  /** The sky behind everything, for `scene.backgroundNode`: the air, the sun's disk, the moon and the stars. */
  background(): V3 {
    const air = this.air;
    return Fn(() => {
      // Three draws the background on a unit sphere at the camera: its normal is the view ray.
      const rd = normalize(normalWorldGeometry).toVar();
      // Angle between neighboring pixels' rays, for the stars' size.
      const pixel = max(length(dFdx(rd)), 1e-6).toVar();
      const mu = dot(rd, this.up).toVar();
      const zenith = acos(clamp(mu, -1, 1)).toVar();
      const color = vec3(0).toVar();
      const marchT = vec3(1).toVar();
      If(this.marchBlend.lessThan(1), () => {
        color.assign(this.lookup(rd as V3).mul(float(1).sub(this.marchBlend)));
      });
      If(this.marchBlend.greaterThan(0), () => {
        const m = this.marched(rd as V3);
        color.addAssign(m.radiance.mul(this.marchBlend));
        marchT.assign(m.transmittance);
      });
      // What lies beyond the air is seen through it; from high up, through the march's own result.
      const beyond = (): V3 =>
        mix(
          this.toSpace(rd as V3, zenith as F),
          marchT.mul(step(zenith, this.horizon.x)),
          this.marchBlend,
        ) as V3;

      // Starlight is hidden by the moon's disk, dark side included.
      const open = float(1).toVar();
      const cosMoon = dot(rd, this.u.moonDirection).toVar();
      If(
        cosMoon
          .greaterThan(Math.cos(MOON_ANGULAR_RADIUS * 1.02))
          .and(this.moonDisk.add(this.earthshine).greaterThan(0)),
        () => {
          const moon = this.moonAt(rd as V3, cosMoon as F).toVar();
          color.addAssign(beyond().mul(moon.rgb));
          open.assign(float(1).sub(moon.a));
        },
      );
      If(this.stars.greaterThan(0).and(zenith.lessThan(this.horizon.x)), () => {
        const field = this.starField(rd as V3, mu as F, pixel as F, luminance(color as V3));
        color.addAssign(beyond().mul(field).mul(open));
      });
      const cosSun = dot(rd, air.u.sunDirection).toVar();
      If(cosSun.greaterThan(Math.cos(SUN_ANGULAR_RADIUS * 1.02)), () => {
        // Across the disk in radii; the limb is darker and redder than the center.
        const across = sqrt(max(float(1).sub(cosSun.mul(cosSun)), 0)).div(
          Math.sin(SUN_ANGULAR_RADIUS),
        );
        const depth = sqrt(max(float(1).sub(across.mul(across)), 0));
        const limb = vec3(1).sub(vec3(0.42, 0.54, 0.7).mul(float(1).sub(depth)));
        const disk = float(1).sub(smoothstep(0.9, 1, across));
        color.addAssign(beyond().mul(limb).mul(disk.mul(this.sunDisk).mul(air.u.sunIlluminance)));
      });
      return color;
    })() as V3;
  }

  dispose(): void {
    this.kernel?.dispose();
    this.kernel = null;
    this.base.dispose();
    this.mie.dispose();
  }
}
