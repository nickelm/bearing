/**
 * Airfields graded into the terrain for the renderer (V3): the scene's airbase
 * sites handed to the assembly in `worldgen/edits/airfields.ts` (R1.6), which
 * the sim worker uses too, so both build the same edits (rule 13).
 */
import type { Vec3d } from '../../../core/vec3d';
import { airfieldPads as padsOf, terrainEditsFor } from '../../../worldgen/edits/airfields';
import type { TerrainEdits } from '../../../worldgen/edits';
import type { ChannelSource, CorridorEdit, PadEdit } from '../../../worldgen/edits';
import type { InfraScene } from './infraScene';

export {
  AIRFIELD_BEYOND_APRON,
  AIRFIELD_FOOTPRINT,
  AIRFIELD_MARGIN,
  AIRFIELD_MIN_ELEVATION,
  AIRFIELD_OVERRUN,
  globalMapSampler,
  globalMaskSampler,
} from '../../../worldgen/edits/airfields';

const fieldsOf = (infra: InfraScene) => infra.sites.filter((s) => s.kind === 'airbase');

/** One graded pad per airbase in `infra`, at the mean global height over the pad. */
export function airfieldPads(
  infra: InfraScene,
  heightAt: (d: Readonly<Vec3d>) => number,
): PadEdit[] {
  return padsOf(fieldsOf(infra), infra.radius, heightAt);
}

/**
 * The terrain edits of every airfield in `infra` over the global height map
 * `height` (n per face), with the carved channels of `channels` kept last.
 */
export function airfieldGrading(
  infra: InfraScene,
  height: Float32Array,
  n: number,
  channels: ChannelSource | null = null,
  corridors: readonly CorridorEdit[] = [],
): TerrainEdits {
  return terrainEditsFor({
    radius: infra.radius,
    fields: fieldsOf(infra),
    height,
    n,
    channels,
    corridors,
  });
}
