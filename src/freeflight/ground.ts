/**
 * The ground under a Free Flight aircraft (decision 134): the surface the
 * renderer draws, graded flat at airfields (decision 108), as a GroundQuery for
 * the flight model.
 *
 * On an airfield's pad the height is the pad's elevation, exactly the number the
 * terrain's `surfaceSampler` returns there, at every tile level, so wheels and
 * pavement agree to the millimeter. Elsewhere it is the finest drawn surface
 * (`TerrainRenderer.displaySurfaceAt`) once its tile has loaded, and the global
 * height map, graded the same way, before that.
 */
import { Vec3d } from '../core/vec3d';
import type { GradePad, SurfaceGrading } from '../render/common/terrain/grading';
import type { GroundQuery, SurfaceKind } from '../sim/flight/flightModel';
import {
  nearestRunway,
  onRunway,
  runwayFrame,
  RUNWAY_WIDTH_M,
  toRunway,
} from '../sim/flight/runway';
import type { Runway, RunwayFrame } from '../sim/flight/runway';
import type { Infrastructure } from '../worldgen/strategic/infrastructure';

/** One runway per airbase, in `infra.airbases` order, at its graded pad's elevation. */
export function runwaysOf(infra: Infrastructure, pads: readonly GradePad[]): Runway[] {
  return infra.airbases.map((b, i) => ({
    id: b.id,
    name: b.name,
    side: b.side,
    center: new Vec3d(...b.point).normalize(),
    heading: b.heading,
    length: b.runwayLength,
    width: RUNWAY_WIDTH_M,
    elevation: pads[i]?.elevation ?? 0,
  }));
}

export class AirfieldGround implements GroundQuery {
  private readonly frames = new Map<Runway, RunwayFrame>();

  constructor(
    readonly runways: readonly Runway[],
    private readonly grading: SurfaceGrading,
    /** The graded global height (m) at a unit direction: the fallback before tiles load. */
    private readonly global: (d: Readonly<Vec3d>) => number,
    readonly radius: number,
    /** The finest drawn surface (m, sea and lakes at their surface), or null until loaded. */
    public drawn: ((d: Readonly<Vec3d>) => number | null) | null = null,
  ) {}

  height(dir: Readonly<Vec3d>): number {
    const h = this.drawn?.(dir) ?? null;
    return h ?? Math.max(0, this.global(dir));
  }

  surface(dir: Readonly<Vec3d>): SurfaceKind {
    const n = nearestRunway(this.runways, dir, this.radius);
    if (n && n.distance < n.runway.length) {
      let f = this.frames.get(n.runway);
      if (!f) this.frames.set(n.runway, (f = runwayFrame(n.runway)));
      const c = toRunway(n.runway, f, dir.clone().scale(this.radius), this.radius);
      if (onRunway(n.runway, c.along, c.across)) return 'runway';
    }
    if (this.grading.cover(dir) > 0.999) return 'field';
    return this.global(dir) <= 0 ? 'water' : 'land';
  }
}
