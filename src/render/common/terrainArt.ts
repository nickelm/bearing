/**
 * Terrain art settings (Proposal 0010 and the owner's addendum, decision 296): one
 * object that says which of the new layers draw and how strongly, by a quality tier
 * (what the machine can afford) and a style (what the game wants to look like).
 *
 * - Quality `off` draws none of the new layers and costs nothing: the terrain looks
 *   as it did before the proposal. `low`, `medium` (the default) and `high` step the
 *   costly layers (rock dressing's range and density, mist, particles) and leave the
 *   cheap ones (curvature, strata, drift: a few ALU per fragment) on.
 * - Styles keep the faceted, retro, cartoony look and change only its strength:
 *   `bearing` (the default), `storybook` (bolder curvature and drift, a big sun and
 *   moon, aurora), `muted` (a quieter version for games that want less color).
 * - The quality governor sheds the costly layers in steps (`governed`), after the
 *   volumetrics and particles (decision 143).
 *
 * Plain data, no three.js: the renderers copy the numbers into their uniforms, and
 * a game can build its own settings and pass them in.
 */

export const ART_QUALITIES = ['off', 'low', 'medium', 'high'] as const;
export type ArtQuality = (typeof ART_QUALITIES)[number];
export const ART_STYLES = ['bearing', 'storybook', 'muted'] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

export interface TerrainArtSettings {
  quality: ArtQuality;
  style: ArtStyle;
  /** Curvature shading: concave darker, convex lighter (0 off, 1 default). */
  curvature: number;
  /** Strata bands in layered rock (0 off, 1 default). */
  strata: number;
  /** Color drift by altitude, aspect and noise (0 off, 1 default). */
  drift: number;
  /** Rock dressing: on, density factor, and the two LOD ranges (m). */
  rocks: { enabled: boolean; density: number; near: number; far: number };
  /** Valley mist and zone height fog strength (0 off). */
  mist: number;
  heightFog: number;
  /** Ambient particles (pollen, leaves, dust, snow, fireflies): density factor, 0 off. */
  particles: number;
  /** The stylized sky: the sun's and the moon's disk scale, and aurora strength. */
  sky: { sunScale: number; moonScale: number; aurora: number };
  /** Waterfalls drawn, rapids' foam bands and lakes' extra sky reflection (0 off). */
  waterfalls: boolean;
  rapids: number;
  lakeMirror: number;
  /** Points of interest drawn. */
  structures: boolean;
}

const STYLE: Record<
  ArtStyle,
  Pick<TerrainArtSettings, 'curvature' | 'strata' | 'drift' | 'mist' | 'heightFog'> & {
    sky: TerrainArtSettings['sky'];
  }
> = {
  bearing: {
    curvature: 1,
    strata: 1,
    drift: 1,
    mist: 1,
    heightFog: 1,
    sky: { sunScale: 1.6, moonScale: 1.4, aurora: 1 },
  },
  storybook: {
    curvature: 1.5,
    strata: 1.3,
    drift: 1.5,
    mist: 1.3,
    heightFog: 1.2,
    sky: { sunScale: 2.4, moonScale: 2, aurora: 1.5 },
  },
  muted: {
    curvature: 0.6,
    strata: 0.6,
    drift: 0.5,
    mist: 0.7,
    heightFog: 0.7,
    sky: { sunScale: 1, moonScale: 1, aurora: 0.5 },
  },
};

const QUALITY: Record<
  Exclude<ArtQuality, 'off'>,
  { rocks: TerrainArtSettings['rocks']; mist: number; particles: number }
> = {
  low: { rocks: { enabled: true, density: 0.5, near: 800, far: 2500 }, mist: 0, particles: 0.4 },
  medium: { rocks: { enabled: true, density: 1, near: 1500, far: 5000 }, mist: 1, particles: 1 },
  high: { rocks: { enabled: true, density: 1.4, near: 2500, far: 9000 }, mist: 1, particles: 1.6 },
};

/** The settings for a quality tier and a style. */
export function terrainArtSettings(
  quality: ArtQuality = 'medium',
  style: ArtStyle = 'bearing',
): TerrainArtSettings {
  // Unknown names (a mistyped URL or preview option) fall back to the defaults.
  if (!(ART_QUALITIES as readonly string[]).includes(quality)) quality = 'medium';
  if (!(ART_STYLES as readonly string[]).includes(style)) style = 'bearing';
  const s = STYLE[style];
  if (quality === 'off') {
    return {
      quality,
      style,
      curvature: 0,
      strata: 0,
      drift: 0,
      rocks: { enabled: false, density: 0, near: 0, far: 0 },
      mist: 0,
      heightFog: 0,
      particles: 0,
      sky: { sunScale: 1, moonScale: 1, aurora: 0 },
      waterfalls: false,
      rapids: 0,
      lakeMirror: 0,
      structures: false,
    };
  }
  const q = QUALITY[quality];
  return {
    quality,
    style,
    curvature: s.curvature,
    strata: s.strata,
    drift: s.drift,
    rocks: { ...q.rocks },
    mist: s.mist * q.mist,
    heightFog: s.heightFog,
    particles: q.particles,
    sky: { ...s.sky },
    waterfalls: true,
    rapids: 1,
    lakeMirror: 1,
    structures: true,
  };
}

/** Steps the governor may take, cheapest loss first (decision 296). */
export const ART_GOVERNOR_STEPS = 3;

/**
 * Settings after `step` governor steps (0 leaves them): 1 halves the particles and
 * the rocks' far range, 2 drops the mist and the far rocks, 3 drops rocks and
 * particles altogether. The shading layers stay: they cost almost nothing.
 */
export function governed(s: TerrainArtSettings, step: number): TerrainArtSettings {
  if (step <= 0 || s.quality === 'off') return s;
  const out: TerrainArtSettings = { ...s, rocks: { ...s.rocks }, sky: { ...s.sky } };
  if (step >= 1) {
    out.particles *= 0.5;
    out.rocks.far = Math.max(out.rocks.near, out.rocks.far * 0.5);
  }
  if (step >= 2) {
    out.mist = 0;
    out.rocks.far = out.rocks.near;
  }
  if (step >= 3) {
    out.particles = 0;
    out.rocks = { ...out.rocks, enabled: false };
  }
  return out;
}

/** Quality and style from a URL's query (`?art=low&artStyle=storybook`); unknown values fall back. */
export function artFromQuery(query: URLSearchParams): { quality: ArtQuality; style: ArtStyle } {
  const q = query.get('art');
  const st = query.get('artStyle');
  return {
    quality: (ART_QUALITIES as readonly string[]).includes(q ?? '') ? (q as ArtQuality) : 'medium',
    style: (ART_STYLES as readonly string[]).includes(st ?? '') ? (st as ArtStyle) : 'bearing',
  };
}
