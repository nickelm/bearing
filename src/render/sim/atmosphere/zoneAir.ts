/**
 * The zones' air at the camera (Proposal 0010, *Air*; decision 300): each frame, the
 * look recipe of the zone under the camera (decision 213) sets the ground fog's color
 * and density, the lowest ground around the camera sets where valley mist pools, and
 * the sun's height, the time of day and the ground's wetness set how much mist there
 * is. Values ease toward their targets over a few seconds, so crossing a zone boundary
 * blends instead of popping. It also names the zone's ambient particles for the
 * particle layer.
 *
 * Plain CPU code over the global maps; the shaders read only `GroundFog`'s uniforms.
 */
import { globalMapSampler } from '../../../worldgen/edits/airfields';
import type { Zones, ZoneRecipe, ZoneRecord, AmbientParticles } from '../../../worldgen/zones';
import { Biome } from '../../../worldgen/biomes';
import type { AmbientParticleSpec } from '../weather/precipitation';
import { NO_ZONE } from '../../../worldgen/zones';
import { directionToCubeFace } from '../../../core/coords';
import type { CubeFaceUv } from '../../../core/coords';
import { DEG } from '../../../core/units';
import { Vec3d } from '../../../core/vec3d';
import type { GroundFog } from './groundFog';

export const ZONE_AIR_TUNING = {
  /** Height fog's density at its base (1/m) for a recipe's hazeDensity of 1. */
  fogDensity: 1 / 30_000,
  /** Height fog's scale height above the area's mean ground (m). */
  fogScale: 450,
  /** Valley mist's density at its base (1/m) at full amount; its scale height (m). */
  mistDensity: 1 / 1400,
  mistScale: 30,
  /** Mist pools this far (m) above the lowest ground around the camera. */
  mistLift: 15,
  /** Rings (m) around the camera where the ground is read. */
  rings: [2500, 6000],
  /** Seconds for the eased values to cover most of the way to their targets. */
  ease: 2.5,
};

export interface ZoneAirWorld {
  n: number;
  /** The global heights (exaggerated, as drawn). */
  height: Float32Array;
  zones?: Zones | null;
}

export interface ZoneAirSettings {
  /** Valley mist and height fog strengths (TerrainArtSettings.mist, heightFog; 0 off). */
  mist: number;
  heightFog: number;
  /** Ambient particles' density factor (TerrainArtSettings.particles; 0 off). */
  particles: number;
}

const DECIDUOUS: ReadonlySet<number> = new Set([
  Biome.TemperateForest,
  Biome.TropicalSeasonalForest,
]);
const HUMID: ReadonlySet<number> = new Set([
  Biome.TropicalRainforest,
  Biome.TropicalSeasonalForest,
  Biome.TemperateRainforest,
  Biome.Mangrove,
  Biome.CloudForest,
]);

/**
 * The ambient particles of a zone (decision 300), as a low level of one precipitation
 * kind with a tint and glow: pollen and seeds over meadows (pale motes), leaves in
 * deciduous forest (orange flakes), blowing dust in dry zones, drifting snow in cold
 * ones, and fireflies at dusk in humid ones. `density` is the art settings' factor;
 * `sunElevation` (rad) decides dusk. Null: none.
 */
export function ambientFor(
  record: Pick<ZoneRecord, 'biome'> & { recipe: Pick<ZoneRecipe, 'particles'> },
  sunElevation: number,
  density: number,
): AmbientParticleSpec | null {
  if (!(density > 0)) return null;
  const dusk = sunElevation > -9 * DEG && sunElevation < 3 * DEG;
  if (dusk && HUMID.has(record.biome))
    return {
      kind: 'dust',
      level: 0.035 * density,
      tint: [0.15, 0.15, 0.15],
      glow: [0.7, 0.9, 0.25],
    };
  switch (record.recipe.particles) {
    case 'pollen':
      if (DECIDUOUS.has(record.biome))
        return { kind: 'snow', level: 0.05 * density, tint: [1.35, 0.62, 0.24], glow: [0, 0, 0] };
      return { kind: 'dust', level: 0.05 * density, tint: [1.8, 2.4, 3.6], glow: [0, 0, 0] };
    case 'dust':
      return { kind: 'dust', level: 0.12 * density, tint: [1, 1, 1], glow: [0, 0, 0] };
    case 'snow':
      return { kind: 'snow', level: 0.04 * density, tint: [1, 1, 1], glow: [0, 0, 0] };
    default:
      return null;
  }
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * How much valley mist there is, 0..1: full before and at sunrise, burning off as the
 * sun climbs through the morning, a little at dusk, and more on wet ground.
 */
export function mistAmount(sunElevation: number, morning: boolean, wetness: number): number {
  const e = sunElevation;
  const dawn = morning
    ? smooth(-14 * DEG, -4 * DEG, e) * (1 - smooth(6 * DEG, 30 * DEG, e))
    : 0.25 * smooth(-10 * DEG, -2 * DEG, e) * (1 - smooth(2 * DEG, 12 * DEG, e));
  const night = 0.35 * (1 - smooth(-14 * DEG, -6 * DEG, e));
  return Math.min(1, Math.max(dawn, night) + 0.7 * Math.min(1, Math.max(0, wetness)));
}

/** A recipe's mist factor: misty zones more, dusty (dry) zones none. */
export function recipeMist(r: Pick<ZoneRecipe, 'clouds' | 'particles'> | null): number {
  if (!r) return 1;
  if (r.particles === 'dust') return 0;
  if (r.particles === 'mist' || r.clouds === 'fog') return 1.6;
  if (r.clouds === 'low') return 1.2;
  return 1;
}

export class ZoneAir {
  /** The zone under the camera's ambient particles (for the particle layer). */
  particles: AmbientParticles = 'none';
  /** What the precipitation overlay should draw for them (null: none). */
  ambient: AmbientParticleSpec | null = null;
  /** The zone under the camera's id, or NO_ZONE. */
  zone = NO_ZONE;

  private world: ZoneAirWorld | null = null;
  private ground: ((d: Readonly<Vec3d>) => number) | null = null;
  private records = new Map<number, ZoneRecord>();
  private readonly uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  private readonly target = { fog: 0, fogBase: 0, mist: 0, mistBase: 0, color: [0.8, 0.84, 0.9] };
  private primed = false;

  constructor(private readonly fog: GroundFog) {}

  setWorld(w: ZoneAirWorld | null): void {
    this.world = w;
    this.ground = w ? globalMapSampler(w.height, w.n) : null;
    this.records = new Map((w?.zones?.records ?? []).map((r) => [r.id, r]));
    this.primed = false;
    if (!w) {
      this.fog.fogDensity.value = 0;
      this.fog.mistDensity.value = 0;
    }
  }

  /**
   * Sets the fog for a frame: `eye` (planet-centered m), `sun` (unit), the ground's
   * wetness 0..1, the art settings' strengths, the planet radius and the frame's time (s).
   */
  update(
    eye: Readonly<Vec3d>,
    sun: Readonly<Vec3d>,
    wetness: number,
    settings: ZoneAirSettings,
    radius: number,
    dt: number,
  ): void {
    const f = this.fog;
    const T = ZONE_AIR_TUNING;
    const len = Math.hypot(eye.x, eye.y, eye.z) || 1;
    f.eyeHeight.value = len - radius;
    if (
      !this.world ||
      !this.ground ||
      settings.mist + settings.heightFog + settings.particles <= 0
    ) {
      f.fogDensity.value = 0;
      f.mistDensity.value = 0;
      this.ambient = null;
      return;
    }
    const up = new Vec3d(eye.x / len, eye.y / len, eye.z / len);
    // The ground around the camera: the area's mean for the height fog, its lowest for mist.
    const east = new Vec3d(0, 1, 0).cross(up);
    if (east.length() < 1e-9) east.set(1, 0, 0);
    east.normalize();
    const north = up.clone().cross(east);
    let sum = Math.max(0, this.ground(up));
    let low = sum;
    let count = 1;
    const d = new Vec3d();
    for (const ring of T.rings) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 2 * Math.PI;
        d.copy(up)
          .addScaled(east, (ring * Math.cos(a)) / radius)
          .addScaled(north, (ring * Math.sin(a)) / radius)
          .normalize();
        const h = Math.max(0, this.ground(d));
        sum += h;
        low = Math.min(low, h);
        count++;
      }
    }
    // The zone under the camera.
    const zones = this.world.zones;
    let record: ZoneRecord | null = null;
    if (zones) {
      directionToCubeFace(up, this.uv);
      const n = this.world.n;
      const i = Math.min(n - 1, Math.max(0, Math.floor(this.uv.u * n)));
      const j = Math.min(n - 1, Math.max(0, Math.floor(this.uv.v * n)));
      this.zone = zones.zone[(this.uv.face * n + j) * n + i]!;
      record = this.records.get(this.zone) ?? null;
    }
    const recipe: ZoneRecipe | null = record?.recipe ?? null;
    this.particles = recipe?.particles ?? 'none';
    // The sun: its elevation, and whether it is in the eastern half of the sky.
    const sunEl = Math.asin(Math.max(-1, Math.min(1, sun.x * up.x + sun.y * up.y + sun.z * up.z)));
    const morning = sun.x * east.x + sun.y * east.y + sun.z * east.z > 0;
    this.ambient = record ? ambientFor(record, sunEl, settings.particles) : null;
    // Drifting snow belongs to high ground: none over a low valley under a clear sky.
    if (this.ambient?.kind === 'snow' && record?.recipe.particles === 'snow' && sum / count < 2500)
      this.ambient = null;
    const t = this.target;
    t.fog = T.fogDensity * (recipe?.hazeDensity ?? 1) * settings.heightFog;
    t.fogBase = sum / count;
    t.mist =
      T.mistDensity * mistAmount(sunEl, morning, wetness) * recipeMist(recipe) * settings.mist;
    t.mistBase = low + T.mistLift;
    const haze = recipe?.haze ?? [0.8, 0.84, 0.9];
    t.color = haze.map(srgbToLinear);
    // Ease toward the targets (at once on the first frame of a world).
    const k = this.primed ? 1 - Math.exp(-Math.max(0, dt) / T.ease) : 1;
    this.primed = true;
    const ease = (u: { value: number }, v: number) => (u.value += (v - u.value) * k);
    ease(f.fogDensity, t.fog);
    ease(f.fogBase, t.fogBase);
    ease(f.mistDensity, t.mist);
    ease(f.mistBase, t.mistBase);
    f.fogScale.value = T.fogScale;
    f.mistScale.value = T.mistScale;
    const c = f.fogColor.value;
    c.set(
      c.x + (t.color[0]! - c.x) * k,
      c.y + (t.color[1]! - c.y) * k,
      c.z + (t.color[2]! - c.z) * k,
    );
  }
}
