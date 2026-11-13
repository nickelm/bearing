/**
 * Planet lighting (decision 34): the uniforms every lit planet material shares
 * (sun direction, camera eye) and the TSL shading function that turns an
 * albedo and a normal into radiance. Materials compute their own lighting
 * instead of using three's scene lights, because sunlight and sky light depend
 * on where the point sits relative to the terminator and, from milestone 3's
 * atmosphere on, on the air between it and the sun.
 *
 * Twilight and night (decision 140). The display's exposure is fixed, but an
 * eye or a camera opens up as the light goes: `update` raises the sun's
 * illuminance by `twilightGain` as the sun sinks (up to about 4.6 stops at
 * −18°), which carries the sky, the sky light and aerial perspective through
 * a long dusk without touching lamps or the night's own light. By night the
 * moon lights the ground: a dim, cool directional term through the air's
 * transmittance, scaled by the moon's phase, with its own sky light; a floor
 * of starlight keeps a moonless night from going black. The night's light
 * falls on a surface's albedo with most of its color taken out
 * (`NIGHT_DESATURATION`), as an eye sees by night: moonlit sand reads
 * blue-gray, not brown.
 *
 * Sky light and the sun's height (decision 140). By day the sky's light on
 * surfaces is below the consistent amount (`skyLight`), which keeps shadows
 * deep under a high sun. A low sun lights little of the ground directly, and
 * a fill that small would leave most of the picture near black under a
 * bright sky, so `update` raises it by `lowSunFill` as the sun sinks
 * (`skyFillGain`), to the consistent amount: shadows stay cool and deep, and
 * readable. It ends with the twilight; the night has its own light.
 * The sky's own colors are graded up at the same hours
 * (`skyVibrance`, atmosphere.ts `vibrance`).
 *
 * The ground under a low sun (decision 139). A low sun lights level ground
 * weakly, and what a mountain shades has the sky's light alone: exposed for
 * the sky, fields fall near display black and forest onto it. A photographer
 * holds the sky back with a graduated filter; `update` does the same and
 * exposes the light on surfaces (sun and sky alike, so shadows keep their
 * depth) up to three quarters of a stop above the sky's (`surfaceExposure`). The air in front
 * of a surface is not raised, so far terrain still fades into the sky drawn.
 *
 * Positions: meshes are drawn camera-relative (rule 4), so a fragment's
 * `positionWorld` is relative to the camera. The planet-centered position is
 * `positionWorld + eye`, in float32. Its error is about 0.1 m at R = 1,000 km,
 * which is plenty for lighting.
 */
import { Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { dot, max, mix, normalize, select, uniform, vec3 } from 'three/tsl';
import { moonlightFraction } from '../../../core/moon';
import { DEG, KM, PLANET_RADIUS } from '../../../core/units';
import type { Vec3d } from '../../../core/vec3d';
import { AtmosphereNodes } from '../atmosphere/atmosphere';
import { earthLikeAtmosphere, LUMA } from '../atmosphere/model';
import { MOON_TINT } from '../atmosphere/skyView';

export type Vec3Node = Node<'vec3'>;

/** Light at one point, shared by the layers a material shades there (see `PlanetLighting.at`). */
export interface LightAt {
  /** Planet-centered position. */
  p: Vec3Node;
  /** Unit radial direction. */
  up: Vec3Node;
  /** Sunlight after the atmosphere, the clouds and the terrain's shadow, at the surfaces' exposure. */
  sunlight: Vec3Node;
  /** Sky irradiance on a surface facing straight up, at the surfaces' exposure. */
  sky: Vec3Node;
  /** Moonlight after the atmosphere (zero by day). */
  moonlight: Vec3Node;
  /** The moonlit sky's irradiance on a surface facing straight up (zero by day). */
  moonSky: Vec3Node;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Stops by which the light is raised at the end of twilight. */
export const TWILIGHT_STOPS = 4.6;

/**
 * The factor on the sun's illuminance at a sun elevation (rad) at the camera:
 * 1 from 8° up, about 2 at the horizon, 6 at −6°, 16 at −12° and 24 from −18°
 * down, as an eye or a camera opens up through dusk. Above the atmosphere
 * (`altitude`, m) it returns to 1: from orbit the day side sets the exposure.
 */
export function twilightGain(sunElevation: number, altitude = 0): number {
  const stops = TWILIGHT_STOPS * smooth(8 * DEG, -18 * DEG, sunElevation);
  return 2 ** (stops * (1 - smooth(60 * KM, 200 * KM, altitude)));
}

/** How far the night's own light (moon, stars) has taken over, 0..1, at a sun elevation (rad). */
export function nightness(sunElevation: number): number {
  return smooth(-2 * DEG, -18 * DEG, sunElevation);
}

/**
 * The factor on the sky's light on surfaces at a sun elevation (rad): 1 with
 * the sun 30° up or higher, `lowSunFill` from 6° down through twilight, and
 * 0 from 18° down, where the sun's light has left the sky and the night's
 * own light stands alone.
 */
export function skyFillGain(sunElevation: number, lowSunFill = LOW_SUN_FILL): number {
  return (
    (1 + (lowSunFill - 1) * smooth(30 * DEG, 6 * DEG, sunElevation)) *
    (1 - smooth(-14 * DEG, -18 * DEG, sunElevation))
  );
}

/**
 * Saturation of the sky's light at a sun elevation (rad), for the
 * atmosphere's `vibrance`: 1 by day (from 12° up), `peak` from 3° up to 8°
 * down (golden hour, sunset and the blue hour), and 1 again by night (from
 * 16° down).
 */
export function skyVibrance(sunElevation: number, peak = SUNSET_VIBRANCE): number {
  return (
    1 +
    (peak - 1) *
      smooth(12 * DEG, 3 * DEG, sunElevation) *
      (1 - smooth(-8 * DEG, -16 * DEG, sunElevation))
  );
}

/**
 * The factor on the light that falls on surfaces, over the sky's exposure, at
 * a sun elevation (rad): 1 with the sun 16° up or higher, `peak` from 4° down
 * to 4° under the horizon, and 1 again from 12° under it, where the twilight
 * gain has taken over. Above the atmosphere (`altitude`, m) it returns to 1.
 */
export function surfaceExposure(
  sunElevation: number,
  peak = LOW_SUN_EXPOSURE,
  altitude = 0,
): number {
  return (
    1 +
    (peak - 1) *
      smooth(16 * DEG, 4 * DEG, sunElevation) *
      (1 - smooth(-4 * DEG, -12 * DEG, sunElevation)) *
      (1 - smooth(60 * KM, 200 * KM, altitude))
  );
}

/**
 * The sky's light on surfaces under a low sun, as a multiple of `skyLight`:
 * with the default `skyLight` of 2 it comes to π, the amount consistent with
 * the sky drawn.
 */
export const LOW_SUN_FILL = Math.PI / 2;
/**
 * The exposure of lit surfaces over the sky's under a low sun (`surfaceExposure`): three
 * quarters of a stop.
 */
export const LOW_SUN_EXPOSURE = 1.7;
/** Saturation of the sky's light around sunset (`skyVibrance`). */
export const SUNSET_VIBRANCE = 1.9;
/** How far a surface's color fades to its luminance under the night's light, 0..1. */
export const NIGHT_DESATURATION = 0.75;

export class PlanetLighting {
  /** Unit vector toward the sun, world frame. */
  readonly sunDirection = uniform(new Vector3(1, 0, 0));
  /** Camera eye, planet-centered world frame (float32). */
  readonly eye = uniform(new Vector3());
  /**
   * Sunlight on a surface facing the sun, in display units (before exposure):
   * `daylight` times the twilight gain, set by `update`.
   */
  readonly sunIlluminance = uniform(1.4);
  /** Sunlight on a surface facing the sun by day, in display units. */
  daylight = 1.4;
  /** Raise the light through twilight (`twilightGain`); off keeps `daylight` at every hour. */
  twilightAdaptation = true;
  /**
   * Multiplies the atmosphere's sky light on surfaces. 1 is the sky's
   * irradiance with multiple scattering, taken as the surface's radiance
   * without the factor π of the display units (atmosphere.ts), so π is the
   * amount consistent with the sky drawn. 2 keeps shadows deeper than that
   * (ground a mountain or a cloud shades is about 4 stops under ground facing
   * a low sun, and blue) without crushing them: at 1, shaded fields and
   * forest at sunset fell to display black under a bright sky (decision 139).
   */
  readonly skyLight = uniform(2);
  /**
   * The sky's light under a low sun, as a multiple of `skyLight` (`skyFillGain`):
   * with `skyLight` 2 it reaches the consistent amount, π.
   */
  lowSunFill = LOW_SUN_FILL;
  /** `skyLight` times `skyFillGain` at the camera: what surfaces are shaded with. Set by `update`. */
  readonly skyFill = uniform(2);
  /**
   * The exposure of the light on surfaces over the sky's under a low sun (`surfaceExposure`);
   * 1 exposes the ground as the sky.
   */
  lowSunExposure = LOW_SUN_EXPOSURE;
  /** `surfaceExposure` at the camera: multiplies the sun's and the sky's light in `at`. Set by `update`. */
  readonly surfaceGain = uniform(1);
  /** Saturation of the sky's light around sunset (`skyVibrance`); 1 leaves the sky as computed. */
  sunsetVibrance = SUNSET_VIBRANCE;
  /**
   * How much brighter the sky is toward the sun, as it lights surfaces: its light on a surface
   * is scaled by 1 + skyLean × (the normal's horizontal part along the sun's azimuth, times
   * the cosine of the sun's elevation), so by 1 ± skyLean at most (a wall under a setting
   * sun). 0 lights every slope by the sky it sees alone.
   */
  readonly skyLean = uniform(0.5);
  /**
   * Starlight and airglow on the night side: under it snow is faintly visible and
   * other ground stays a silhouette, darker than the sky above the horizon.
   */
  readonly nightLight = uniform(0.02);
  /** Unit vector toward the moon, world frame. */
  readonly moonDirection = uniform(new Vector3(0, -1, 0));
  /**
   * Moonlight on a surface facing the moon, in display units: `fullMoon` by
   * the moon's phase, faded in through dusk and out with the moon far below
   * the horizon. 0 by day, which skips the moon's terms in every shader.
   */
  readonly moonIlluminance = uniform(0);
  /**
   * The full moon's light on a surface facing it at night, in display units: a twelfth of
   * daylight, as for an eye adapted to the night. It has to be about that much to show at
   * all: under the tone curve ground lit by less than about 0.05 is display black (at 0.02
   * a full moon lit nothing, and the only light on the ground was the settlements' glow).
   */
  fullMoon = 0.12;
  /** The sun's elevation at the camera (rad) and how far night has fallen there (0..1), as of `update`. */
  sunElevation = Math.PI / 2;
  night = 0;
  /** The air: transmittance LUT, sky and scattering (decision 35). */
  readonly atmosphere: AtmosphereNodes;
  /**
   * Optional fraction of sunlight that reaches a planet-centered point past
   * the clouds (1 = clear). Set by the cloud layer before materials are built.
   */
  sunVisibility: ((p: Vec3Node) => Node<'float'>) | null = null;
  /**
   * Optional fraction of sunlight that reaches a planet-centered point past
   * the terrain (lighting/terrainShadow.ts). Set before materials are built.
   */
  terrainShadow: ((p: Vec3Node) => Node<'float'>) | null = null;

  constructor(readonly radius = PLANET_RADIUS) {
    this.atmosphere = new AtmosphereNodes(
      earthLikeAtmosphere(radius),
      { sunDirection: this.sunDirection, sunIlluminance: this.sunIlluminance, eye: this.eye },
      { moonDirection: this.moonDirection, moonIlluminance: this.moonIlluminance },
    );
  }

  /**
   * Sets the camera and the lights for a frame. `moon` is the unit vector
   * toward the moon (core/moon.ts); without it the moon stays where it was.
   */
  update(eye: Readonly<Vec3d>, sun: Readonly<Vec3d>, moon?: Readonly<Vec3d>): void {
    this.eye.value.set(eye.x, eye.y, eye.z);
    this.sunDirection.value.set(sun.x, sun.y, sun.z).normalize();
    if (moon) this.moonDirection.value.set(moon.x, moon.y, moon.z).normalize();
    const distance = Math.hypot(eye.x, eye.y, eye.z) || 1;
    const up = this.eye.value;
    const sunElevation = Math.asin(
      Math.min(1, Math.max(-1, this.sunDirection.value.dot(up) / distance)),
    );
    const moonElevation = Math.asin(
      Math.min(1, Math.max(-1, this.moonDirection.value.dot(up) / distance)),
    );
    // A camera that is not at the planet (a model viewer at the origin) gets plain daylight.
    const atPlanet = distance > 0.5 * this.radius;
    this.sunElevation = atPlanet ? sunElevation : Math.PI / 2;
    this.night = nightness(this.sunElevation);
    this.sunIlluminance.value =
      this.daylight *
      (this.twilightAdaptation ? twilightGain(this.sunElevation, distance - this.radius) : 1);
    this.skyFill.value = this.skyLight.value * skyFillGain(this.sunElevation, this.lowSunFill);
    this.surfaceGain.value = surfaceExposure(
      this.sunElevation,
      this.lowSunExposure,
      distance - this.radius,
    );
    this.atmosphere.vibrance.value = skyVibrance(this.sunElevation, this.sunsetVibrance);
    // The ground in view reaches some 11° around the planet from 20 km up: the moon lights
    // parts of it while it is still below the camera's horizon.
    this.moonIlluminance.value =
      this.fullMoon *
      moonlightFraction(this.sunDirection.value, this.moonDirection.value) *
      this.night *
      smooth(-14 * DEG, -10 * DEG, moonElevation);
  }

  /** Sunlight at a planet-centered point: illuminance × atmosphere transmittance × clouds × terrain shadow. */
  sunlightAt(p: Vec3Node): Vec3Node {
    let t = this.atmosphere.sunTransmittance(p).mul(this.sunIlluminance);
    if (this.sunVisibility) t = t.mul(this.sunVisibility(p));
    if (this.terrainShadow) t = t.mul(this.terrainShadow(p));
    return t as Vec3Node;
  }

  /**
   * Moonlight at a planet-centered point: illuminance × atmosphere transmittance,
   * zero where the moon is below the horizon. Costs a transmittance read by night
   * and nothing by day (a branch on `moonIlluminance`). Clouds do not shade it.
   */
  moonlightAt(p: Vec3Node): Vec3Node {
    return select(
      this.moonIlluminance.greaterThan(0),
      this.atmosphere
        .lightTransmittance(p, this.moonDirection as unknown as Vec3Node)
        .mul(vec3(...MOON_TINT).mul(this.moonIlluminance)),
      vec3(0),
    ) as Vec3Node;
  }

  /** The moonlit sky's irradiance on level ground where the radial direction is `up` (zero by day). */
  moonSkyAt(up: Vec3Node): Vec3Node {
    return select(
      this.moonIlluminance.greaterThan(0),
      this.atmosphere
        .skyIrradiance(dot(up, this.moonDirection))
        .mul(vec3(...MOON_TINT).mul(this.moonIlluminance.mul(this.skyLight))),
      vec3(0),
    ) as Vec3Node;
  }

  /**
   * The night's light on a surface that faces mostly upward and does its own
   * shading (cloud tops): the floor of starlight, the moonlit sky, and the
   * moon by how high it stands.
   */
  nightLightAt(p: Vec3Node, up: Vec3Node): Vec3Node {
    const moonUp = max(dot(up, this.moonDirection), 0);
    return vec3(0.55, 0.65, 1.0)
      .mul(this.nightLight)
      .add(this.moonlightAt(p).mul(moonUp))
      .add(this.moonSkyAt(up)) as Vec3Node;
  }

  /** Planet-centered position of a camera-relative world position. */
  planetPosition(relative: Vec3Node): Vec3Node {
    return relative.add(this.eye) as Vec3Node;
  }

  /**
   * Radiance of a diffuse surface: sunlight by N·L, filtered by the air
   * between the point and the sun (red at sunset, zero in the planet's
   * shadow); sky light from the atmosphere's irradiance LUT by the sun's
   * elevation at the point, weighted by how much sky the normal sees and by
   * how far it leans toward the sun's side of the sky (`skyLean`); by
   * night the moon's light and its sky light the same way; and a faint night
   * floor. Aerial perspective is applied separately (`applyAerial`).
   * `normal` is a unit world-space normal; `relative` the camera-relative position.
   */
  shadeDiffuse(
    albedo: Vec3Node,
    normal: Vec3Node,
    relative: Vec3Node,
    at: LightAt = this.at(relative),
  ): Vec3Node {
    const sunFacing = dot(normal, this.sunDirection);
    const upFacing = dot(normal, at.up);
    const direct = at.sunlight.mul(max(sunFacing, 0));
    const skyFacing = upFacing.mul(0.5).add(0.5);
    // The sky is brighter toward the sun: a surface that leans toward the sun's azimuth takes
    // more of its light, one that leans away less, and level ground the same. In shadow and
    // through dusk this is what tells the terrain's facets apart (decision 139).
    const sunward = sunFacing.sub(upFacing.mul(dot(at.up, this.sunDirection)));
    const sky = at.sky.mul(skyFacing.mul(sunward.mul(this.skyLean).add(1)));
    const night = vec3(0.55, 0.65, 1.0).mul(this.nightLight);
    const moon = at.moonlight
      .mul(max(dot(normal, this.moonDirection), 0))
      .add(at.moonSky.mul(skyFacing));
    // By night an eye sees little color: the night's light falls on a grayer surface.
    const nightAlbedo = mix(albedo, vec3(dot(albedo, vec3(...LUMA))), NIGHT_DESATURATION);
    return albedo.mul(direct.add(sky)).add(nightAlbedo.mul(night.add(moon))) as Vec3Node;
  }

  /**
   * The light arriving at a camera-relative position, independent of the
   * surface's normal and albedo. A material that shades several layers at one
   * point (land, water, roads) builds this once and passes it to each
   * `shadeDiffuse` call, so the sun's transmittance, the cloud shadow and the
   * sky light are evaluated once per fragment (decision 69).
   */
  at(relative: Vec3Node): LightAt {
    const p = this.planetPosition(relative);
    const up = normalize(p) as Vec3Node;
    const sky = this.atmosphere
      .skyIrradiance(dot(up, this.sunDirection))
      .mul(this.sunIlluminance.mul(this.skyFill).mul(this.surfaceGain)) as Vec3Node;
    return {
      p,
      up,
      // Surfaces are exposed above the sky under a low sun (`surfaceExposure`).
      sunlight: this.sunlightAt(p).mul(this.surfaceGain).toVar() as Vec3Node,
      sky: sky.toVar() as Vec3Node,
      moonlight: this.moonlightAt(p).toVar() as Vec3Node,
      moonSky: this.moonSkyAt(up).toVar() as Vec3Node,
    };
  }

  /** Surface radiance seen through the air: L·T + in-scatter (per-vertex values from aerialPerspective). */
  applyAerial(radiance: Vec3Node, inscatter: Vec3Node, transmittance: Vec3Node): Vec3Node {
    return radiance.mul(transmittance).add(inscatter.mul(this.sunIlluminance)) as Vec3Node;
  }
}
