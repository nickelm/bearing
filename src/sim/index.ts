/**
 * sim: the headless simulation of the world (formations, flights, convoys,
 * airbases, the front line). It runs in a Web Worker (src/workers) and knows
 * nothing about rendering. Lint forbids imports from render, ui, three/webgpu,
 * three/tsl and lil-gui, and forbids Math.random.
 *
 * Fidelity is a level of detail. Every unit exists at one level:
 *   - aggregate: formation, flight or convoy. Always simulated, cheaply.
 *   - entity:    individual vehicles and squads, only inside the promotion bubble.
 *   - full:      physical simulation, only for the player's unit.
 * Promotion expands deterministically from the unit's seed and strength;
 * demotion folds entity losses back into aggregate strength.
 *
 * Time: discrete events for analytic processes, fixed ticks of game time for
 * iterative ones. GameTime is float64 seconds since campaign start.
 *
 * Nothing is implemented yet (milestone 6).
 */
export type { GameTime } from '../core/units';
