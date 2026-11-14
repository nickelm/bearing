/**
 * The atmosphere's settings between the debug panel and the scene
 * (ui/atmosphereSettings.ts), on a stand-in for the scene: the panel starts
 * from the scene's values, the governor's steps lower quality and particles,
 * and new pipeline variants warm the particles and the lightning up.
 */
import { describe, expect, it } from 'vitest';
import type { GlobeScene } from '../src/render/sim/globeScene';
import {
  applyAtmosphere,
  governed,
  GOVERNED_DENSITY,
  GOVERNOR_STEPS,
  governorStatus,
  readAtmosphere,
} from '../src/ui/atmosphereSettings';

/** The parts of a GlobeScene the settings read and write, with counters for the warm-ups. */
function standIn(options: { pipeline?: boolean } = {}) {
  const warmed = { particles: 0, lightning: 0 };
  const scene = {
    postEnabled: true,
    pipeline: options.pipeline === false ? null : { bloom: true, grading: true, grain: true },
    volumetrics: {
      quality: 'medium' as 'low' | 'medium' | 'high',
      cloudsEnabled: true,
      airEnabled: true,
      cirrus: { value: 0.5 },
    },
    precipitation:
      options.pipeline === false
        ? null
        : { enabled: true, density: 1, warm: () => void warmed.particles++ },
    lightning: { enabled: true, warm: () => void warmed.lightning++ },
    shadows: { enabled: true, softness: { value: 1 } },
    terrain: { land: { sparkle: { value: 1 } } },
    lighting: { atmosphere: { haze: { value: 0.32 } } },
  };
  return { scene, asScene: scene as unknown as GlobeScene, warmed };
}

describe('atmosphere settings', () => {
  it("starts the panel from the scene's own values, and applying them changes nothing", () => {
    const { scene, asScene, warmed } = standIn();
    scene.volumetrics.cirrus.value = 0.35;
    scene.lighting.atmosphere.haze.value = 0.4;
    const audio = { volume: 0.8, muted: false };
    const p = readAtmosphere(asScene, audio, 'live');
    expect(p).toMatchObject({
      post: true,
      bloom: true,
      grade: true,
      grain: true,
      autoQuality: true,
      quality: 'medium',
      volumetricClouds: true,
      volumetricAir: true,
      cirrus: 0.35,
      weather: 'live',
      particles: true,
      particleDensity: 1,
      lightning: true,
      shadows: true,
      shadowSoftness: 1,
      sparkle: 1,
      haze: 0.4,
      volume: 0.8,
      mute: false,
    });
    const before = JSON.stringify(scene);
    expect(applyAtmosphere(p, asScene, audio, 0)).toBe(false);
    expect(JSON.stringify(scene)).toBe(before);
    expect(warmed).toEqual({ particles: 0, lightning: 0 });
    expect(audio).toEqual({ volume: 0.8, muted: false });
  });

  it('writes every value of the panel', () => {
    const { scene, asScene } = standIn();
    const audio = { volume: 0.8, muted: false };
    const p = readAtmosphere(asScene, audio, 'fair');
    Object.assign(p, {
      autoQuality: false,
      post: false,
      bloom: false,
      grade: false,
      grain: false,
      quality: 'high',
      volumetricClouds: false,
      volumetricAir: false,
      cirrus: 0.9,
      particles: false,
      particleDensity: 1.5,
      lightning: false,
      shadows: false,
      shadowSoftness: 2,
      sparkle: 0.25,
      haze: 0.6,
      volume: 0.3,
      mute: true,
    });
    expect(applyAtmosphere(p, asScene, audio, 0)).toBe(true);
    expect(scene).toMatchObject({
      postEnabled: false,
      pipeline: { bloom: false, grading: false, grain: false },
      volumetrics: {
        quality: 'high',
        cloudsEnabled: false,
        airEnabled: false,
        cirrus: { value: 0.9 },
      },
      precipitation: { enabled: false, density: 1.5 },
      lightning: { enabled: false },
      shadows: { enabled: false, softness: { value: 2 } },
      terrain: { land: { sparkle: { value: 0.25 } } },
      lighting: { atmosphere: { haze: { value: 0.6 } } },
    });
    expect(audio).toEqual({ volume: 0.3, muted: true });
  });

  it("lowers the volumetric quality, then the particles, with the governor's steps", () => {
    const p = { autoQuality: true, quality: 'medium' as const, particleDensity: 1 };
    expect(GOVERNOR_STEPS).toBe(2);
    expect(governed(p, 0)).toEqual({ quality: 'medium', density: 1 });
    expect(governed(p, 1)).toEqual({ quality: 'low', density: 1 });
    expect(governed(p, 2)).toEqual({ quality: 'low', density: GOVERNED_DENSITY });
    // One level under the panel's choice, whatever that is; low has nothing under it.
    expect(governed({ ...p, quality: 'high' }, 2)).toEqual({
      quality: 'medium',
      density: GOVERNED_DENSITY,
    });
    expect(governed({ ...p, quality: 'low' }, 1).quality).toBe('low');
    expect(governed({ ...p, particleDensity: 1.6 }, 2).density).toBeCloseTo(0.8, 9);
    // A choice by hand stands.
    expect(governed({ ...p, autoQuality: false }, 2)).toEqual({ quality: 'medium', density: 1 });
    expect(governorStatus(p, 0)).toBe('full (medium)');
    expect(governorStatus(p, 1)).toBe('step 1: volumetrics low');
    expect(governorStatus(p, 2)).toBe('step 2: volumetrics low, particles ×0.5');
    expect(governorStatus({ ...p, autoQuality: false }, 2)).toBe('manual');
  });

  it('warms the particles and the lightning up when the pipeline gets new variants', () => {
    const { scene, asScene, warmed } = standIn();
    const audio = { volume: 0.8, muted: false };
    const p = readAtmosphere(asScene, audio, 'live');
    // The governor's first step changes the volumetric quality: new shaders.
    expect(applyAtmosphere(p, asScene, audio, 1)).toBe(true);
    expect(scene.volumetrics.quality).toBe('low');
    expect(warmed).toEqual({ particles: 1, lightning: 1 });
    // Its second step only thins the particles.
    expect(applyAtmosphere(p, asScene, audio, 2)).toBe(false);
    expect(scene.precipitation!.density).toBe(GOVERNED_DENSITY);
    expect(warmed).toEqual({ particles: 1, lightning: 1 });
    // Back up, and bloom off: two more.
    expect(applyAtmosphere(p, asScene, audio, 0)).toBe(true);
    expect(scene.volumetrics.quality).toBe('medium');
    expect(scene.precipitation!.density).toBe(1);
    p.bloom = false;
    expect(applyAtmosphere(p, asScene, audio, 0)).toBe(true);
    expect(warmed).toEqual({ particles: 3, lightning: 3 });
    // Grain, cirrus and haze are uniforms or a variant the overlay does not share: no warm-up.
    p.cirrus = 0.1;
    p.haze = 0.5;
    expect(applyAtmosphere(p, asScene, audio, 0)).toBe(false);
  });

  it('works without a pipeline: no post-processing, no particles', () => {
    const { asScene, warmed } = standIn({ pipeline: false });
    const audio = { volume: 0.5, muted: true };
    const p = readAtmosphere(asScene, audio, 'storm');
    expect(p).toMatchObject({
      post: false,
      bloom: false,
      grade: false,
      grain: false,
      particles: false,
      particleDensity: 1,
      weather: 'storm',
      mute: true,
    });
    p.quality = 'low';
    p.autoQuality = false;
    expect(applyAtmosphere(p, asScene, audio, 0)).toBe(true);
    expect(warmed).toEqual({ particles: 0, lightning: 1 });
  });
});
