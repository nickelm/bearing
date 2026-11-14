/**
 * The atmosphere's settings between the debug panel and the scene (decision
 * 143): post-processing, volumetric quality, particles, lightning, shadows,
 * snow sparkle, haze and the weather's sound.
 *
 * `readAtmosphere` takes the panel's starting values from the scene, so the
 * tuned defaults live in the code that uses them and nowhere else.
 * `applyAtmosphere` writes the panel's values back, together with the
 * performance governor's level (render/common/qualityGovernor.ts): while the
 * automatic quality is on, each of the governor's steps down takes one thing
 * away, soft things first (`governed`):
 *
 *   1. the volumetric quality one level under the panel's choice,
 *   2. half the particles.
 *
 * A change of volumetric quality, bloom or grading makes the pipeline build
 * new shader variants, so `applyAtmosphere` then asks the particles and the
 * lightning to draw once empty (`warm`): the compile lands on that frame and
 * not on the first drop or bolt.
 */
import type { GlobeScene } from '../render/sim/globeScene';
import type { VolumetricQuality } from '../render/sim/clouds/volumetrics';
import type { WeatherPreset } from '../sim/weather/presets';
import type { AtmosphereGuiParams } from './debugGui';
import type { SoundSettings } from './flight/flightCards';

/** The volumetric quality levels, cheapest first. */
export const QUALITY_ORDER: readonly VolumetricQuality[] = ['low', 'medium', 'high'];
/** Steps the governor can take down (see the file comment). */
export const GOVERNOR_STEPS = 2;
/** Share of the particles left by the governor's second step. */
export const GOVERNED_DENSITY = 0.5;

/** The panel's starting values, as the scene and the audio have them. */
export function readAtmosphere(
  scene: GlobeScene,
  audio: Readonly<SoundSettings>,
  weather: WeatherPreset,
): AtmosphereGuiParams {
  const pipeline = scene.pipeline;
  return {
    post: scene.postEnabled && pipeline !== null,
    bloom: pipeline?.bloom ?? false,
    grade: pipeline?.grading ?? false,
    grain: pipeline?.grain ?? false,
    autoQuality: true,
    quality: scene.volumetrics.quality,
    volumetricClouds: scene.volumetrics.cloudsEnabled,
    volumetricAir: scene.volumetrics.airEnabled,
    cirrus: scene.volumetrics.cirrus.value,
    weather,
    particles: scene.precipitation?.enabled ?? false,
    particleDensity: scene.precipitation?.density ?? 1,
    lightning: scene.lightning.enabled,
    shadows: scene.shadows.enabled,
    shadowSoftness: scene.shadows.softness.value,
    sparkle: scene.terrain.land.sparkle.value,
    haze: scene.lighting.atmosphere.haze.value,
    volume: audio.volume,
    mute: audio.muted,
    status: '—',
  };
}

/**
 * The volumetric quality and the particle density in effect: the panel's
 * choices, lowered by the governor's level while the automatic quality is on.
 */
export function governed(
  p: Pick<AtmosphereGuiParams, 'autoQuality' | 'quality' | 'particleDensity'>,
  level: number,
): { quality: VolumetricQuality; density: number } {
  if (!p.autoQuality || level <= 0) return { quality: p.quality, density: p.particleDensity };
  const index = Math.max(0, QUALITY_ORDER.indexOf(p.quality) - 1);
  return {
    quality: QUALITY_ORDER[index]!,
    density: level >= 2 ? p.particleDensity * GOVERNED_DENSITY : p.particleDensity,
  };
}

/** One line on what the automatic quality has set. */
export function governorStatus(
  p: Pick<AtmosphereGuiParams, 'autoQuality' | 'quality' | 'particleDensity'>,
  level: number,
): string {
  if (!p.autoQuality) return 'manual';
  const g = governed(p, level);
  if (level <= 0) return `full (${g.quality})`;
  return `step ${level}: volumetrics ${g.quality}${level >= 2 ? `, particles ×${GOVERNED_DENSITY}` : ''}`;
}

/**
 * Writes the panel's values into the scene and the audio, with the governor's
 * level. Returns true if the pipeline has new shader variants to compile (the
 * particles and the lightning were asked to warm up).
 */
export function applyAtmosphere(
  p: Readonly<AtmosphereGuiParams>,
  scene: GlobeScene,
  audio: SoundSettings,
  level: number,
): boolean {
  const pipeline = scene.pipeline;
  const variant = () =>
    `${scene.postEnabled}/${pipeline?.bloom}/${pipeline?.grading}/${scene.volumetrics.quality}`;
  const before = variant();
  scene.postEnabled = p.post;
  if (pipeline) {
    pipeline.bloom = p.bloom;
    pipeline.grading = p.grade;
    pipeline.grain = p.grain;
  }
  const g = governed(p, level);
  scene.volumetrics.quality = g.quality;
  scene.volumetrics.cloudsEnabled = p.volumetricClouds;
  scene.volumetrics.airEnabled = p.volumetricAir;
  scene.volumetrics.cirrus.value = p.cirrus;
  if (scene.precipitation) {
    scene.precipitation.enabled = p.particles;
    scene.precipitation.density = g.density;
  }
  scene.lightning.enabled = p.lightning;
  scene.shadows.enabled = p.shadows;
  scene.shadows.softness.value = p.shadowSoftness;
  scene.terrain.land.sparkle.value = p.sparkle;
  scene.lighting.atmosphere.haze.value = p.haze;
  audio.volume = p.volume;
  audio.muted = p.mute;
  const changed = variant() !== before;
  if (changed) {
    scene.precipitation?.warm();
    scene.lightning.warm();
  }
  return changed;
}
