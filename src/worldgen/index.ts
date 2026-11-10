/**
 * worldgen: the planet generation pipeline (design doc, "World Generation Pipeline").
 *
 * Stages, each drawing randomness only from its own named stream, rng(seed, "<stage>"):
 *   plates (unsteered seeds and types) · crust · boundaries · uplift · elevation and sea level ·
 *   climate (provisional) · biomes
 * Later stages add detail noise, GPU erosion and rivers; milestone 4 adds the
 * validity check, the strategic graph, theater detection and casting; then
 * settlements, roads, ports and airbases.
 *
 * May use three/webgpu and three/tsl for GPU compute. Must not import render or ui.
 */
export * from './params';
export * from './pipeline';
export { Biome, BIOME_NAMES } from './biomes';
export { BoundaryType, BOUNDARY_NAMES } from './boundaries';
