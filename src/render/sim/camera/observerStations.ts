/**
 * Where the observer camera can stand (V1, decision 72): one station per
 * airbase and port of the cast's infrastructure, both sides, Alliance first,
 * main bases before forward, bomber and island fields, then ports.
 *
 * - **Airbases:** beside the control tower's cab, on the runway and apron
 *   side, at cab height, looking along the apron at the middle of the hangar row, with
 *   the taxiway and runway a turn to the right (structureLayer.ts layout).
 * - **Ports:** at the port's site, 30 m up, looking toward the lowest ground
 *   within a few kilometers, which is the sea. Port points come from the
 *   coarse pass (decision 65), so they can sit a little inland or offshore.
 */
import { Vec3d } from '../../../core/vec3d';
import type { Infrastructure } from '../../../worldgen/strategic/infrastructure';
import { APRON_LENGTH, APRON_OFFSET, localFrame, offsetPoint } from '../infra/infraScene';

export type StationKind = 'airbase' | 'port';

export interface ObserverStation {
  /** Stable identifier, e.g. "airbase-3". */
  key: string;
  /** For pickers: "Alliance · Name (main airbase)". */
  label: string;
  kind: StationKind;
  side: 'alliance' | 'pact';
  /** Unit direction of the spot the observer stands over. */
  point: Vec3d;
  /** Compass heading the observer faces at first (rad, clockwise from north). */
  facing: number;
  /** Eye height above the ground (m). */
  height: number;
  /** Pitch at first (rad, negative looks down). */
  pitch: number;
}

/** The tower's position on the apron and the observer's spot in front of its cab (m). */
export const TOWER_ALONG = APRON_LENGTH / 2 + 80;
export const TOWER_EYE_INSET = 8;
/** And this far from the tower toward the apron, so the cab is behind the observer (m). */
export const TOWER_EYE_BACK = 15;
export const TOWER_EYE_HEIGHT = 19;
export const PORT_EYE_HEIGHT = 30;
/** The airbase observer looks at the middle of the hangar row, this far across (m; structureLayer.ts). */
export const TOWER_AIM_ACROSS = APRON_OFFSET + 140;

const SIDE_LABEL = { alliance: 'Alliance', pact: 'Pact' } as const;
const KIND_ORDER = { main: 0, forward: 1, bomber: 2, island: 3 } as const;

/**
 * The observer stations of a world. `heightAt` (physical m at a unit
 * direction, e.g. a sampler of the global height map) turns port observers
 * toward the sea; without it they face north.
 */
export function observerStations(
  infra: Infrastructure,
  radius: number,
  heightAt?: (d: Readonly<Vec3d>) => number,
): ObserverStation[] {
  const out: ObserverStation[] = [];
  const sides = ['alliance', 'pact'] as const;
  for (const side of sides) {
    const bases = infra.airbases
      .filter((b) => b.side === side)
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id - b.id);
    for (const b of bases) {
      const p = new Vec3d(...b.point);
      // The tower stands at (TOWER_ALONG, APRON_OFFSET), its cab facing the runway.
      const eye = offsetPoint(
        p,
        b.heading,
        TOWER_ALONG - TOWER_EYE_BACK,
        APRON_OFFSET - TOWER_EYE_INSET,
        radius,
      );
      const aim = offsetPoint(p, b.heading, 0, TOWER_AIM_ACROSS, radius);
      out.push({
        key: `airbase-${b.id}`,
        label: `${SIDE_LABEL[side]} · ${b.name} (${b.kind} airbase)`,
        kind: 'airbase',
        side,
        point: eye,
        facing: bearingTo(eye, aim),
        height: TOWER_EYE_HEIGHT,
        pitch: -3 * (Math.PI / 180),
      });
    }
  }
  for (const side of sides) {
    for (const port of infra.ports.filter((x) => x.side === side)) {
      const p = new Vec3d(...port.point);
      out.push({
        key: `port-${port.id}`,
        label: `${SIDE_LABEL[side]} · ${port.name} (${port.kind} port)`,
        kind: 'port',
        side,
        point: p,
        facing: heightAt ? seaward(p, radius, heightAt) : 0,
        height: PORT_EYE_HEIGHT,
        pitch: -3 * (Math.PI / 180),
      });
    }
  }
  return out;
}

/** Compass bearing (rad, clockwise from north) from unit direction a toward b. */
export function bearingTo(a: Readonly<Vec3d>, b: Readonly<Vec3d>): number {
  const { east, north } = localFrame(a);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.atan2(
    dx * east.x + dy * east.y + dz * east.z,
    dx * north.x + dy * north.y + dz * north.z,
  );
}

/** The bearing among 16 whose ground 2–6 km out is lowest on average. */
function seaward(p: Readonly<Vec3d>, radius: number, heightAt: (d: Readonly<Vec3d>) => number) {
  let best = 0;
  let lowest = Infinity;
  for (let k = 0; k < 16; k++) {
    const h = (k / 16) * 2 * Math.PI;
    let sum = 0;
    for (const r of [2000, 4000, 6000]) sum += heightAt(offsetPoint(p, h, r, 0, radius));
    if (sum < lowest) {
      lowest = sum;
      best = h;
    }
  }
  return best;
}
