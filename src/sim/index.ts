/**
 * sim: the headless simulation of the world (formations, flights, convoys,
 * airbases, the front line, weather). It runs in a Web Worker
 * (workers/sim.worker.ts) and knows nothing about rendering. Lint forbids
 * imports from render, ui, three/webgpu, three/tsl and lil-gui, and forbids
 * Math.random.
 *
 * Fidelity is a level of detail. Every unit exists at one level:
 *   - aggregate: formation, flight or convoy. Always simulated, cheaply.
 *   - entity:    individual vehicles and squads, only inside the promotion bubble.
 *   - full:      physical simulation, only for the player's unit.
 * Promotion expands deterministically from the unit's seed and strength;
 * demotion folds entity losses back into aggregate strength.
 *
 * Time (decision 67): discrete events for analytic processes and fixed ticks
 * of game time for iterative ones, interleaved by time in one queue
 * (simulation.ts). GameTime is float64 seconds since campaign start.
 * Weather (decision 68) is an hourly process (weather/).
 */
export type { GameTime } from '../core/units';
export * from './scheduler';
export * from './simulation';
export * from './host';
export * from './stateHash';
export * from './world';
export * from './weather/grid';
export * from './weather/climate';
export * from './weather/frame';
export * from './weather/model';
