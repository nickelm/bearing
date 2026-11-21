/**
 * Waterfalls and rapids (Proposal 0010, *Water*; decision 301): the knickpoints of
 * Proposal 0005 made explicit. Each river's water surface comes stepped from the river
 * index (decision 146): on steep reaches it falls down the rock layers in pools and
 * drops. A run of segments whose stepped surface falls steeply is one waterfall: its lip
 * is the run's first point, its height the run's total drop, its width the river's.
 * Gentler steep runs are rapids. Tall falls are named.
 *
 * Pure, deterministic and game-agnostic, like the zones: presentation data that the
 * water layer draws and a game may read (a named fall is a landmark).
 */
import { rng } from '../core/rng';
import type { WorldSeed } from '../core/rng';
import { Toponymy } from './names/toponymy';
import type { RiverIndex } from './riverIndex';
import { RIVER_SEGMENT_FIELDS } from './riverIndex';

export const WATERFALL_TUNING = {
  /** A segment is part of a fall where its stepped surface drops this steeply (m/m)... */
  fallGradient: 0.12,
  /** ...and part of rapids where it drops at least this steeply. */
  rapidsGradient: 0.025,
  /** Falls lower than this (m) are rapids. */
  minDrop: 6,
  /** Rivers narrower than this (m) have no falls drawn. */
  minWidth: 6,
  /** Falls at least this tall (m) are named. */
  namedDrop: 40,
  /** A "major" fall for the proposal's check: a river at least this wide (m). */
  majorWidth: 20,
};

export interface Waterfall {
  /** Unit direction of the lip (top of the fall) and of the foot. */
  lip: [number, number, number];
  foot: [number, number, number];
  /** Water surface at the lip and at the foot (m). */
  top: number;
  bottom: number;
  /** River width at the lip (m). */
  width: number;
  /** River polyline (into the index's lines). */
  line: number;
  /** A name for tall falls, else null. */
  name: string | null;
}

export interface Rapids {
  /** Segment range [from, to) in the index. */
  from: number;
  to: number;
  /** Mean drop (m/m). */
  gradient: number;
}

export interface RiverDrops {
  falls: Waterfall[];
  rapids: Rapids[];
}

const F = RIVER_SEGMENT_FIELDS;

/** Falls and rapids of every river in `index`. */
export function findWaterfalls(
  index: RiverIndex,
  radius: number,
  seed: WorldSeed,
  tuning: Partial<typeof WATERFALL_TUNING> = {},
): RiverDrops {
  const t = { ...WATERFALL_TUNING, ...tuning };
  const d = index.segments.data;
  const lines = index.lines;
  const names = new Toponymy(rng(seed, 'waterfalls'));
  const falls: Waterfall[] = [];
  const rapids: Rapids[] = [];
  const segLength = (s: number) => {
    const o = s * F;
    const dot = d[o]! * d[o + 3]! + d[o + 1]! * d[o + 4]! + d[o + 2]! * d[o + 5]!;
    return Math.max(1, radius * Math.acos(Math.min(1, dot)));
  };
  // Stepped surface at a and b (fields 10, 11), or the smooth one (8, 9) without steps.
  const surf = (s: number, end: 0 | 1) => {
    const o = s * F;
    const st = d[o + 10 + end]!;
    return Number.isFinite(st) && st < 1e8 ? st : d[o + 8 + end]!;
  };
  for (let k = 0; k + 1 < lines.length; k++) {
    const from = lines[k]!;
    const to = lines[k + 1]!;
    let runStart = -1;
    let rapidStart = -1;
    let rapidDrop = 0;
    let rapidLen = 0;
    // A run of steep segments [runStart, end) becomes one fall if it drops far enough.
    const closeFall = (end: number) => {
      if (runStart < 0) return;
      const a = runStart * F;
      const b = (end - 1) * F;
      const top = surf(runStart, 0);
      const bottom = surf(end - 1, 1);
      const width = d[a + 6]!;
      runStart = -1;
      if (top > 1e8 || top - bottom < t.minDrop || width < t.minWidth) return;
      falls.push({
        lip: [d[a]!, d[a + 1]!, d[a + 2]!],
        foot: [d[b + 3]!, d[b + 4]!, d[b + 5]!],
        top,
        bottom,
        width,
        line: k,
        name: null,
      });
    };
    for (let s = from; s < to; s++) {
      const L = segLength(s);
      const drop = surf(s, 0) - surf(s, 1);
      const g = drop / L;
      if (g >= t.fallGradient) {
        if (runStart < 0) runStart = s;
      } else {
        closeFall(s);
      }
      if (g >= t.rapidsGradient && g < t.fallGradient) {
        if (rapidStart < 0) rapidStart = s;
        rapidDrop += drop;
        rapidLen += L;
      } else if (rapidStart >= 0) {
        rapids.push({ from: rapidStart, to: s, gradient: rapidDrop / rapidLen });
        rapidStart = -1;
        rapidDrop = 0;
        rapidLen = 0;
      }
    }
    closeFall(to);
    if (rapidStart >= 0) rapids.push({ from: rapidStart, to, gradient: rapidDrop / rapidLen });
  }
  for (const f of falls) if (f.top - f.bottom >= t.namedDrop) f.name = `${names.proper(0)} Falls`;
  return { falls, rapids };
}
