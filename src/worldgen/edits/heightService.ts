/**
 * The height service (roadmap R1.6, owner decision 9): the ground's height from
 * the global eroded grid plus the terrain edits, through the one edit function
 * (rule 13). What the execution layer asks when it cannot wait for tiles: AI
 * sensing and line of sight, in the sim worker and on the main thread alike.
 * The tiles' detail (48 m samples) is left out, so it is the ground at the
 * grid's resolution (about 1.5 km at 1024 cells per face on the campaign
 * planet) with the airfields, corridors and channels graded in.
 */
import type { Vec3d } from '../../core/vec3d';
import { globalMapSampler } from './airfields';
import type { AirfieldSite } from './airfields';
import type { TerrainEdits } from './terrainEdits';

export class HeightService {
  private readonly sample: (d: Readonly<Vec3d>) => number;

  constructor(
    readonly radius: number,
    height: Float32Array,
    readonly n: number,
    readonly edits: TerrainEdits,
    /** The sited airfields the edits were built from (presentation data beside the coarse points). */
    readonly fields: readonly AirfieldSite[] = [],
  ) {
    this.sample = globalMapSampler(height, n);
  }

  /** Height (m above the sea; below zero on the sea floor) at a unit direction. */
  height(dir: Readonly<Vec3d>): number {
    return this.edits.apply(dir, this.sample(dir));
  }
}
