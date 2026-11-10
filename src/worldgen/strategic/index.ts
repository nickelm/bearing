/**
 * The strategic graph: types (graph.ts) for campaign logic, and the builder,
 * which alone reads world maps (decision 52).
 */
export * from './graph';
export { buildStrategicGraph } from './builder';
export type { StrategicInput } from './input';
