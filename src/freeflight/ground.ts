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
import type { GroundQuery, SurfaceKind } from '../sim/flight/contact';
import {
  nearestRunway,
  onRunway,
  runwayFrame,
  RUNWAY_WIDTH_M,
  toRunway,
} from '../sim/flight/runway';
import type { Runway, RunwayFrame } from '../sim/flight/runway';
import { HeightService } from '../worldgen/edits';
import type { PadEdit, TerrainEdits } from '../worldgen/edits';
import type { Infrastructure } from '../worldgen/strategic/infrastructure';
import { airfieldPads, globalMapSampler } from '../render/sim/infra/airfieldGrading';
import type { InfraScene } from '../render/sim/infra/infraScene';

/** One runway per airbase, in `infra.airbases` order, at its graded pad's elevation. */
export function runwaysOf(infra: Infrastructure, pads: readonly PadEdit[]): Runway[] {
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
    private readonly edits: TerrainEdits,
    /** The graded global height (m) at a unit direction: the fallback before tiles load. */
    private readonly global: (d: Readonly<Vec3d>) => number,
    readonly radius: number,
    /** The finest drawn surface (m, sea and lakes at their surface), or null until loaded. */
    public drawn: ((d: Readonly<Vec3d>) => number | null) | null = null,
    /**
     * The top (m) of a landform prop over a direction, or null (decision 225): a tower
     * is ground the aircraft can hit and the camera keeps clear of.
     */
    public obstacle: ((d: Readonly<Vec3d>) => number | null) | null = null,
    /**
     * The drawn surface where its tiles are already resident, without asking for more
     * (decision 227): what the sensors read over tens of kilometers.
     */
    public resident: ((d: Readonly<Vec3d>) => number | null) | null = null,
  ) {}

  /**
   * The ground's height for the sensors (line of sight, the ground map, the elevation map):
   * as `height`, but from resident tiles only, the global grid elsewhere (decision 227).
   */
  sensedHeight(dir: Readonly<Vec3d>): number {
    const h = (this.resident ?? this.drawn)?.(dir) ?? null;
    const ground = h ?? Math.max(0, this.global(dir));
    const top = this.obstacle?.(dir) ?? null;
    return top !== null && top > ground ? top : ground;
  }

  /**
   * The ground for line of sight (R1.6, owner decision 9): the global grid plus edits
   * (the height service) and the landform props, never tiles, so the flown aircraft
   * and the AI see over the same ground. The ground map and the elevation map keep
   * `sensedHeight`.
   */
  sightHeight(dir: Readonly<Vec3d>): number {
    const ground = Math.max(0, this.global(dir));
    const top = this.obstacle?.(dir) ?? null;
    return top !== null && top > ground ? top : ground;
  }

  height(dir: Readonly<Vec3d>): number {
    const h = this.drawn?.(dir) ?? null;
    const ground = h ?? Math.max(0, this.global(dir));
    const top = this.obstacle?.(dir) ?? null;
    return top !== null && top > ground ? top : ground;
  }

  surface(dir: Readonly<Vec3d>): SurfaceKind {
    const n = nearestRunway(this.runways, dir, this.radius);
    if (n && n.distance < n.runway.length) {
      let f = this.frames.get(n.runway);
      if (!f) this.frames.set(n.runway, (f = runwayFrame(n.runway)));
      const c = toRunway(n.runway, f, dir.clone().scale(this.radius), this.radius);
      if (onRunway(n.runway, c.along, c.across)) return 'runway';
    }
    if (this.edits.cover(dir) > 0.999) return 'field';
    // A drowned tower is rock, not sea.
    if (this.obstacle?.(dir) != null) return 'land';
    return this.global(dir) <= 0 ? 'water' : 'land';
  }
}

/** What the ground of a flown aircraft is built from, once the global pass is done. */
export interface FlownTerrain {
  infra: InfraScene;
  edits: TerrainEdits;
  height: Float32Array;
  n: number;
  airbases: Infrastructure;
}

/** The drawn surface the ground reads: the terrain's finest loaded tiles (decision 227). */
export interface DrawnSurface {
  displaySurfaceAt(d: Readonly<Vec3d>, load?: boolean): number | null;
}

/**
 * The sited runways and the ground of a flown aircraft (Free Flight's, and a campaign
 * flight's at full fidelity, R2.5): the airfields' graded pads give the runways their
 * elevations (decision 108); the drawn surface, the height service (the global grid plus
 * the edits, as the sim worker's, R1.6) before tiles load, and the landform props as
 * obstacles (decision 225).
 */
export function flownGround(
  t: FlownTerrain,
  radius: number,
  terrain: DrawnSurface,
  obstacle: (d: Readonly<Vec3d>) => number | null,
): { runways: Runway[]; ground: AirfieldGround } {
  const pads = airfieldPads(t.infra, globalMapSampler(t.height, t.n));
  const runways = runwaysOf(t.airbases, pads);
  const heights = new HeightService(radius, t.height, t.n, t.edits);
  const ground = new AirfieldGround(
    runways,
    t.edits,
    (d) => heights.height(d),
    radius,
    (d) => terrain.displaySurfaceAt(d),
    obstacle,
    // The sensors read resident tiles only (decision 227).
    (d) => terrain.displaySurfaceAt(d, false),
  );
  return { runways, ground };
}
