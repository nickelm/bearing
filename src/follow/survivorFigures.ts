/**
 * Downed pilots in the simulation view (roadmap R2.9; `docs/visual-style.md` Part I,
 * Infantry): each survivor down within FIGURE_RANGE of the camera stands where it came
 * down, a toy-like figure in a flight suit, an oversized flight helmet and a survival
 * vest, waving, at 1.4 times life size as soldiers are (decision 331), with ink and a
 * contact shadow (decision 340). The survivors of a followed rescue at full fidelity
 * wait at the edge of its landing zone, put out orange signal smoke as the helicopter
 * comes in, and are gone once it has been on the ground long enough to take them
 * aboard. No civilians and no gore (rule 21).
 */
import type { Meters } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { modelSpec } from '../render/common/models/library';
import { TrafficLayer } from '../render/sim/aircraft/trafficLayer';
import type { TrafficAircraft } from '../render/sim/aircraft/trafficLayer';
import type { GlobeScene } from '../render/sim/globeScene';
import type { SurvivorPicture } from '../workers/protocol';

/** Survivors are drawn within this of the camera (m). */
export const FIGURE_RANGE: Meters = 4000;
/** Drawn size over life size, as soldiers (decision 331). */
export const FIGURE_SCALE = 1.4;
/** A rescue's survivors wait this far from its landing zone, toward where they came down (m). */
export const LZ_EDGE: Meters = 25;
/** The helicopter within this of the landing zone sets off the signal smoke (m). */
export const SMOKE_RANGE: Meters = 3000;

const SPECS = {
  alliance: modelSpec('figure-pilot-alliance'),
  pact: modelSpec('figure-pilot-pact'),
};

/** Where a followed rescue's survivors are, and whether they are aboard. */
export interface RescueScene {
  /** The rescue's survivor ids. */
  survivors: readonly number[];
  /** The landing zone on the ground (world, m). */
  lz: Readonly<Vec3d>;
  /** The rescue helicopter's position (world, m). */
  helicopter: Readonly<Vec3d>;
  /** Whether the survivors are aboard (the pickup's wait has run long enough). */
  aboard: boolean;
}

export class SurvivorFigures {
  private readonly layer: TrafficLayer;
  private readonly smoking = new Set<string>();

  constructor(
    private readonly globe: GlobeScene,
    private readonly radius: Meters,
  ) {
    this.layer = new TrafficLayer(globe.lighting, { ink: true, contactShadows: true });
    globe.vehicles.add(this.layer.group);
  }

  /**
   * Draws the survivors down near `eye` for the frame about to be rendered; `ground` is the
   * drawn ground's height (m) at a unit direction, or null while unknown.
   */
  update(
    list: readonly SurvivorPicture[],
    eye: Readonly<Vec3d>,
    rpp: number,
    ground: (d: Readonly<Vec3d>) => number | null,
    rescue: RescueScene | null,
  ): void {
    const R = this.radius;
    const out: TrafficAircraft[] = [];
    const smoke = new Set<string>();
    for (const s of list) {
      if (s.state !== 'down' || s.water) continue;
      const own = new Vec3d(s.point[0], s.point[1], s.point[2]);
      let d = own.clone();
      let face: Vec3d | null = null;
      const mine = rescue?.survivors.includes(s.id) ?? false;
      if (mine && rescue) {
        if (rescue.aboard) continue;
        // At the landing zone's edge toward where it came down, facing the helicopter.
        const lz = rescue.lz.clone().normalize();
        const to = own.clone().sub(lz.clone().scale(own.dot(lz)));
        const k = to.length() > 1e-9 ? LZ_EDGE / R / to.length() : 0;
        const spread = (s.id % 5) * 2.5;
        d = lz
          .clone()
          .addScaled(to, k)
          .addScaled(perpendicular(lz, to), spread / R)
          .normalize();
        face = rescue.lz.clone();
      }
      const h = ground(d);
      if (h === null) continue;
      const pos = d.clone().scale(R + h);
      if (pos.distanceTo(eye) > FIGURE_RANGE) continue;
      const up = d;
      const toward = (face ?? eye).clone().sub(pos);
      toward.addScaled(up, -toward.dot(up));
      const fwd = toward.length() > 1e-6 ? toward.normalize() : perpendicular(up, up);
      out.push({
        spec: SPECS[s.side],
        scheme: null,
        gearDown: false,
        pos: [pos.x, pos.y, pos.z],
        forward: [fwd.x, fwd.y, fwd.z],
        up: [up.x, up.y, up.z],
        scale: FIGURE_SCALE,
      });
      if (mine && rescue && rescue.helicopter.distanceTo(pos) < SMOKE_RANGE) {
        const key = `survivor:${s.id}`;
        smoke.add(key);
        this.globe.effects.track(key, 'signal-smoke', { pos: pos.clone().addScaled(up, 0.5) });
      }
    }
    for (const k of this.smoking) if (!smoke.has(k)) this.globe.effects.remove(k);
    this.smoking.clear();
    for (const k of smoke) this.smoking.add(k);
    this.layer.radPerPixel = rpp;
    this.layer.update(out, eye);
  }

  /** Draws none and stops the smoke (the follow ended). */
  hide(): void {
    this.update([], new Vec3d(), 0.001, () => null, null);
  }

  dispose(): void {
    for (const k of this.smoking) this.globe.effects.remove(k);
    this.globe.vehicles.remove(this.layer.group);
    this.layer.dispose();
  }
}

/** A unit vector at right angles to both a and b (or to a alone when b is parallel). */
function perpendicular(a: Readonly<Vec3d>, b: Readonly<Vec3d>): Vec3d {
  const c = a.clone().cross(b);
  if (c.length() > 1e-9) return c.normalize();
  const x = Math.abs(a.x) < 0.9 ? new Vec3d(1, 0, 0) : new Vec3d(0, 1, 0);
  return a.clone().cross(x).normalize();
}
