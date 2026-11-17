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
 * - **Switchbacks** (`roadStations`, decision 186): the aligned roads' most
 *   winding stretches, 700 m to the side and 350 m up, looking at them.
 * - **Wonders** (`wonderStations`, decision 220): the war's natural wonders,
 *   from WONDER_VIEW_DISTANCE out on the side with the lowest ground, 600 m up,
 *   looking at the wonder's anchor.
 */
import { Vec3d } from '../../../core/vec3d';
import type { Infrastructure } from '../../../worldgen/strategic/infrastructure';
import { FeatureKind, WONDER_KIND_NAMES } from '../../../worldgen/strategic/graph';
import type { FeatureList } from '../../../worldgen/strategic/graph';
import { alignedPoint } from '../../../worldgen/networks/alignments';
import type { Alignments } from '../../../worldgen/networks/alignments';
import { CLASS_KEYS } from '../../../worldgen/networks/link';
import { APRON_LENGTH, APRON_OFFSET, localFrame, offsetPoint } from '../infra/infraScene';

export type StationKind = 'airbase' | 'port' | 'road' | 'wonder';

export interface ObserverStation {
  /** Stable identifier, e.g. "airbase-3". */
  key: string;
  /** For pickers: "Alliance · Name (main airbase)". */
  label: string;
  kind: StationKind;
  /** The side whose site it is; null for roads and wonders. */
  side: 'alliance' | 'pact' | null;
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

/**
 * Stations over the `count` most winding stretches of the aligned roads and
 * railways (decision 186): the 2 km of line with the most stored points (they
 * gather on curves and grade breaks), mountain classes counting double, at
 * least 30 km apart.
 */
export function roadStations(al: Alignments, radius: number, count = 8): ObserverStation[] {
  const WINDOW = 2000;
  const mountain = new Set([
    CLASS_KEYS.indexOf('mountainRoad'),
    CLASS_KEYS.indexOf('mountainRailway'),
    CLASS_KEYS.indexOf('track'),
  ]);
  const found: { score: number; k: number; i: number; j: number }[] = [];
  const a = new Vec3d();
  const b = new Vec3d();
  for (let k = 0; k < al.count; k++) {
    const o = al.offsets[k]!;
    const e = al.offsets[k + 1]!;
    let j = o;
    let score = 0;
    for (let i = o; i < e; i++) {
      alignedPoint(al, k, i, a);
      while (j < e && alignedPoint(al, k, j, b).distanceTo(a) * radius < WINDOW) {
        score += mountain.has(al.cls[j]!) ? 2 : 1;
        j++;
      }
      found.push({ score, k, i, j });
      score -= mountain.has(al.cls[i]!) ? 2 : 1;
    }
  }
  found.sort((x, y) => y.score - x.score || x.k - y.k || x.i - y.i);
  const out: ObserverStation[] = [];
  const picked: Vec3d[] = [];
  for (const f of found) {
    if (out.length >= count) break;
    const mid = alignedPoint(al, f.k, (f.i + f.j - 1) >> 1);
    if (picked.some((p) => p.distanceTo(mid) * radius < 30_000)) continue;
    picked.push(mid);
    const ahead = alignedPoint(al, f.k, Math.min(f.j - 1, ((f.i + f.j - 1) >> 1) + 1));
    const heading = ahead.distanceTo(mid) > 0 ? bearingTo(mid, ahead) : 0;
    const eye = offsetPoint(mid, heading, 0, -700, radius);
    const lat = (Math.asin(mid.y) * 180) / Math.PI;
    const lon = (Math.atan2(mid.x, mid.z) * 180) / Math.PI;
    out.push({
      key: `road-${f.k}-${f.i}`,
      label:
        `Roads · switchbacks ${out.length + 1} (${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}, ` +
        `${Math.abs(lon).toFixed(2)}° ${lon < 0 ? 'W' : 'E'})`,
      kind: 'road',
      side: null,
      point: eye,
      facing: bearingTo(eye, mid),
      height: 350,
      pitch: -25 * (Math.PI / 180),
    });
  }
  return out;
}

/** How far out the wonder observer stands (m): a coarse cell and a half, so the anchor's cell is in view. */
export const WONDER_VIEW_DISTANCE = 7000;
export const WONDER_EYE_HEIGHT = 600;
/** The height (m) above the ground at the wonder that the sight line aims at: about a shape's top. */
export const WONDER_TARGET_RISE = 300;

/**
 * Stations at the war's natural wonders (decision 220), `ids` being the
 * features the cast selected (`cast.wonders`). The wonder's anchor is a coarse
 * cell's center, so the observer stands back far enough to frame the cell: on
 * the bearing whose ground is lowest (open view, usually across a valley or the
 * sea), looking down at the anchor's ground.
 */
export function wonderStations(
  f: FeatureList,
  ids: readonly number[],
  radius: number,
  heightAt?: (d: Readonly<Vec3d>) => number,
  /** Where the tiles shape each wonder (decision 221), by feature; else its anchor. */
  sited?: ReadonlyMap<number, readonly [number, number, number]>,
): ObserverStation[] {
  const out: ObserverStation[] = [];
  for (const i of ids) {
    if (f.kind[i] !== FeatureKind.Wonder) continue;
    const at = sited?.get(i) ?? [f.anchor[3 * i]!, f.anchor[3 * i + 1]!, f.anchor[3 * i + 2]!];
    const anchor = new Vec3d(at[0], at[1], at[2]);
    // Closer for small shapes: a blue hole is a few hundred meters across, a monolith 3 km.
    const kindId = f.measure[i]!;
    const viewDistance = kindId === 10 ? 1500 : kindId === 9 ? 5000 : WONDER_VIEW_DISTANCE;
    const eyeHeight = kindId === 10 ? 400 : WONDER_EYE_HEIGHT;
    // The bearing (of 16) whose sight line to the wonder clears the ground best, the
    // lower eye breaking ties; where the best is still blocked, the eye rises over it.
    let from = 0;
    let height = eyeHeight;
    if (heightAt) {
      const target = Math.max(0, heightAt(anchor)) + WONDER_TARGET_RISE;
      let best = Infinity;
      for (let k = 0; k < 16; k++) {
        const b = (k / 16) * 2 * Math.PI;
        const eyeGround = Math.max(0, heightAt(offsetPoint(anchor, b, viewDistance, 0, radius)));
        const eyeAlt = eyeGround + eyeHeight;
        let blocked = 0;
        for (let t = 0.15; t < 0.9; t += 0.075) {
          const g = heightAt(offsetPoint(anchor, b, viewDistance * (1 - t), 0, radius));
          blocked = Math.max(blocked, g - (eyeAlt + (target - eyeAlt) * t));
        }
        const cost = 1000 * blocked + eyeGround;
        if (cost < best) {
          best = cost;
          from = b;
          height = Math.min(3000, eyeHeight + (blocked > 0 ? 2 * blocked + 100 : 0));
        }
      }
    }
    const eye = offsetPoint(anchor, from, viewDistance, 0, radius);
    const drop = heightAt
      ? Math.max(0, heightAt(eye)) + height - Math.max(0, heightAt(anchor)) - WONDER_TARGET_RISE
      : height;
    const kind = WONDER_KIND_NAMES[f.measure[i]!] ?? 'wonder';
    out.push({
      key: `wonder-${i}`,
      label: `Wonders · ${f.names[i] ?? 'unnamed'} (${kind})`,
      kind: 'wonder',
      side: null,
      point: eye,
      facing: bearingTo(eye, anchor),
      height,
      pitch: -Math.max(2 * (Math.PI / 180), Math.min(0.6, Math.atan2(drop, WONDER_VIEW_DISTANCE))),
    });
  }
  return out;
}
