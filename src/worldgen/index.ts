/**
 * worldgen: the planet generation pipeline (design doc, "World Generation Pipeline").
 *
 * Stages, each drawing randomness only from its own named stream, rng(seed, "<stage>"):
 *   continents · plates · boundaries · uplift · elevation and sea level ·
 *   climate (provisional) · biomes
 * Later milestones add detail noise, GPU erosion, rivers, the geography check,
 * the front line, settlements, roads and airbases.
 *
 * May use three/webgpu and three/tsl for GPU compute. Must not import render or ui.
 */
export * from './params';
export * from './pipeline';
export { Biome, BIOME_NAMES } from './biomes';
export { BoundaryType, BOUNDARY_NAMES } from './boundaries';
