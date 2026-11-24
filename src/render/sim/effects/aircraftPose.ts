/**
 * An airframe's pose as the effects need it (decision 329): its body axes, load factor and
 * size, for `EffectsSystem.aircraft`.
 */
import { Vec3d } from '../../../core/vec3d';
import type { ModelSpec } from '../../common/models/spec';
import type { AircraftPose } from './effectsSystem';

/** What `airframePose` reads of an airframe (the flight model's own fields). */
export interface PosedAirframe {
  pos: Readonly<Vec3d>;
  vel: Readonly<Vec3d>;
  telemetry: { load: number };
  bodyAxis(axis: 0 | 1 | 2, out?: Vec3d): Vec3d;
}

/**
 * The right wingtip of model `spec` relative to the center of gravity `cg` (model frame, m):
 * how far forward of it (negative: aft) and how far out, where the wingtip vortex sheds
 * (decision 319). The tip is the outermost mirrored, horizontal wing part's, three
 * quarters of the way back along its tip chord. Null without such a wing.
 */
export function wingtipOf(
  spec: Pick<ModelSpec, 'parts'>,
  cg: readonly number[],
): readonly [number, number] | null {
  let best: [number, number] | null = null;
  for (const p of spec.parts) {
    if (p.type !== 'wing' || !p.mirror || p.vertical) continue;
    const d = ((p.dihedral ?? 0) * Math.PI) / 180;
    const out = p.root[2] + p.span * Math.cos(d);
    if (best && out <= best[1]) continue;
    const le = p.root[0] - p.span * Math.tan((p.sweep * Math.PI) / 180);
    best = [le - 0.75 * p.tipChord - (cg[0] ?? 0), out];
  }
  return best;
}

/**
 * The effects' pose of an airframe of wingspan `span` (m); a fighter's length is assumed.
 * `tip` places the wingtip vortices (`wingtipOf`); without it they start abreast the center.
 */
export function airframePose(
  a: PosedAirframe,
  span: number,
  damage = 0,
  length = 16,
  tip: readonly [number, number] | null = null,
): AircraftPose {
  return {
    tip: tip ?? undefined,
    pos: a.pos,
    vel: a.vel,
    forward: a.bodyAxis(0, new Vec3d()),
    right: a.bodyAxis(1, new Vec3d()),
    load: Number.isFinite(a.telemetry.load) ? a.telemetry.load : 1,
    span,
    length,
    damage,
  };
}
