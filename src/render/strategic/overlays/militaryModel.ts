/**
 * What the map's military overlays draw (visual-style Part II, Military Overlays;
 * decision 101), from the strategic graph, the cast and the territory raster. Pure
 * TypeScript: tests run it on generated worlds without a GPU; militaryLayer.ts draws it.
 *
 * - **Front lines.** The start line of every continental-front theater, near-black
 *   and bold, with teeth in the attacker's color on the attacker's side. The side is
 *   read from the territory raster beside the line (a vote over its points), so the
 *   teeth sit where the attacker's tint is; the line's side centroids decide when
 *   there is no raster.
 * - **Defensive lines.** The front's other barrier lines, thin and dashed.
 * - **Invasion corridors.** Arrows across the start line's weak segments, from the
 *   attacker's side to the defender's, in the attacker's color; their names are
 *   labels (labelModel.ts).
 * - **Sea lanes.** The lanes of sea-lane theaters and the lanes that chokepoint
 *   theaters control, dashed, in the color of the side that sails them.
 * - **Chokepoints.** Diamonds on the chokepoints of chokepoint theaters and of the
 *   lanes shown.
 *
 * Widths, dashes and mark sizes are CSS pixels; the layer converts them per frame.
 * Lines are densified to great-circle steps of at most `MAX_STEP`, so they can be
 * draped on the relief.
 */
import type { Cast, Side, Theater } from '../../../campaign/cast';
import { polylinePoint, surfaceDistance } from '../../../worldgen/strategic/graph';
import type { Point, StrategicGraph } from '../../../worldgen/strategic/graph';
import type { ZoomBand } from '../zoomBands';

export type OverlayLayer = 'front' | 'defense' | 'corridors' | 'lanes' | 'chokepoints';
export const OVERLAY_LAYERS: readonly OverlayLayer[] = [
  'front',
  'defense',
  'corridors',
  'lanes',
  'chokepoints',
];

/** Part II's faction colors (sRGB hex): symbols, front teeth, labels, territory tint. */
export const FACTION_COLORS: Record<Side, number> = { alliance: 0x2f6fb5, pact: 0xd0532b };
/** The front line itself, and neutral military marks. */
export const FRONT_COLOR = 0x2a2a2a;
export const NEUTRAL_COLOR = 0x8c8c8c;
/** Pale casing under lines and marks, the label halo color. */
export const CASING_COLOR = 0xf4efe4;

/**
 * Icon badges (decision 133). Forces that move (flights, naval groups) are discs in
 * their side's color with a pale symbol and a dark rim; fixed sites are pale tiles
 * with a rim and symbol in their holder's color. A selected icon grows and takes the
 * selection rim. Sizes are CSS px; the symbol fills SYMBOL_SHARE of the badge.
 */
export const UNIT_RIM = 0x1e1e1e;
export const SELECTION_RIM = 0xffc83d;
export const SYMBOL_SHARE = { unit: 0.66, site: 0.64 } as const;

export function unitBadge(color: number, size: number, selected = false): MarkBadge {
  return {
    shape: 'disc',
    size: selected ? size * 1.25 : size,
    fill: color,
    rim: selected ? SELECTION_RIM : UNIT_RIM,
    rimWidth: selected ? 3 : 1.5,
  };
}

export function siteBadge(color: number, size: number): MarkBadge {
  return { shape: 'square', size, fill: CASING_COLOR, rim: color, rimWidth: 2 };
}

/** Teeth along a line: triangles on one side, spaced along the line. */
export interface TeethStyle {
  /** +1: on the line's left (looking from point 0 toward the end), −1: on its right. */
  side: 1 | -1;
  color: number;
  /** Base width, height and spacing (px). */
  base: number;
  height: number;
  period: number;
}

export interface LineStyle {
  color: number;
  /** Line width (px). */
  width: number;
  /** Pale casing width on each side (px) and its opacity; 0 for none. */
  casing: number;
  casingOpacity: number;
  /** Dash period (px) and the share of it drawn; period 0 for a solid line. */
  dash: number;
  duty: number;
  /** Round ends (true) or flat ends cut at the end point. */
  roundEnds: boolean;
  teeth: TeethStyle | null;
  /** Casing color (sRGB hex); the pale `CASING_COLOR` when absent. */
  casingColor?: number;
}

export interface OverlayLine<L extends string = OverlayLayer> {
  layer: L;
  /** Unit directions, xyz interleaved, at most MAX_STEP apart. */
  points: Float64Array;
  style: LineStyle;
  bands: readonly ZoomBand[];
  /** A corridor's name and its attacker, for its label. */
  name?: string;
  side?: Side;
}

/**
 * Mark shapes. Arrowheads and diamonds are sized by `length` × `width`; the symbols
 * after them (decision 104) fit a square `length` px wide, drawn upright on screen
 * unless `axis` orients them (an airbase's runway, a bridge's road).
 */
export type MarkShape =
  | 'arrowhead'
  | 'diamond'
  | 'airbase'
  | 'port'
  | 'factory'
  | 'refinery'
  | 'power-plant'
  | 'supply-depot'
  | 'fuel-depot'
  | 'rail-yard'
  | 'bridge'
  | 'star'
  | 'aircraft'
  | 'carrier';
export const MARK_SHAPES: readonly MarkShape[] = [
  'arrowhead',
  'diamond',
  'airbase',
  'port',
  'factory',
  'refinery',
  'power-plant',
  'supply-depot',
  'fuel-depot',
  'rail-yard',
  'bridge',
  'star',
  'aircraft',
  'carrier',
];

/** A mark lying on the map at a point: its own frame is `axis` (along) and the left of it. */
export interface OverlayMark<L extends string = OverlayLayer> {
  layer: L;
  shape: MarkShape;
  point: Point;
  /** Unit tangent at the point: an arrowhead points along it. [0, 0, 0]: upright on screen. */
  axis: Point;
  /** Length along the axis and width across it (px). */
  length: number;
  width: number;
  color: number;
  /** Outline width (px) for hollow marks; 0 for filled. */
  outline: number;
  casing: number;
  bands: readonly ZoomBand[];
  /** Casing color (sRGB hex); the pale `CASING_COLOR` when absent. */
  casingColor?: number;
  /**
   * A badge behind a symbol (decision 133): the mark faces the screen, the badge
   * fills a disc or rounded square of `size` px with a rim, and the symbol (`length`
   * px, in `color`) turns to `axis` as seen on screen. The casing rings the badge.
   */
  badge?: MarkBadge;
  /** Identifies a pickable mark, e.g. "mission:12" or "carrier:0". */
  key?: string;
}

export interface MarkBadge {
  shape: 'disc' | 'square';
  size: number;
  fill: number;
  rim: number;
  rimWidth: number;
}

export interface MilitaryOverlays<L extends string = OverlayLayer> {
  lines: OverlayLine<L>[];
  marks: OverlayMark<L>[];
}

/** Longest great-circle step of a drawn line (radians on the unit sphere, about 10 km on Earth). */
export const MAX_STEP = 0.0016;

const ALL: readonly ZoomBand[] = ['globe', 'theater', 'region'];
const BELOW_GLOBE: readonly ZoomBand[] = ['theater', 'region'];

export const FRONT_STYLE: Omit<LineStyle, 'teeth'> = {
  color: FRONT_COLOR,
  width: 3,
  casing: 1.5,
  casingOpacity: 0.8,
  dash: 0,
  duty: 1,
  roundEnds: true,
};
export const TEETH = { base: 8, height: 6, period: 20 } as const;
export const DEFENSE_STYLE: LineStyle = {
  color: FRONT_COLOR,
  width: 1.6,
  casing: 1,
  casingOpacity: 0.6,
  dash: 14,
  duty: 0.6,
  roundEnds: true,
  teeth: null,
};
export const CORRIDOR_SHAFT = { width: 4, casing: 1.5, casingOpacity: 0.75 } as const;
export const ARROWHEAD = { length: 15, width: 16 } as const;
export const LANE_STYLE = {
  width: 2,
  casing: 1,
  casingOpacity: 0.65,
  dash: 12,
  duty: 0.55,
} as const;
export const CHOKEPOINT = { size: 11, theaterSize: 15, outline: 2 } as const;

/** Cells of the territory raster by direction; null where there is no raster. */
export interface TerritoryLookup {
  /** TERRITORY_* code (−1 sea, 0 neutral, 1 Alliance, 2 Pact) at a unit direction. */
  ownerAt(p: Readonly<Point>): number;
  /** About one raster cell, in radians, for sampling beside a line. */
  cellAngle: number;
}

const CODE: Record<Side, number> = { alliance: 1, pact: 2 };
const other = (s: Side): Side => (s === 'alliance' ? 'pact' : 'alliance');

export function buildMilitaryOverlays(
  graph: StrategicGraph,
  cast: Cast | null,
  territory: TerritoryLookup | null,
): MilitaryOverlays {
  const lines: OverlayLine[] = [];
  const marks: OverlayMark[] = [];
  if (!cast) return { lines, marks };
  for (const t of cast.theaters) {
    if (t.kind !== 'continental-front' || t.front === undefined) continue;
    const f = graph.fronts[t.front];
    if (!f || f.start < 0) continue;
    const owner = cast.owners[f.node];
    const start = graph.barrierLines[f.start]!;
    const attacker: Side = t.attacker === 'alliance' ? 'alliance' : 'pact';
    // The attacker's line side (0 or 1): the cast's split records the Pact's side.
    const pactSide = owner?.kind === 'split' ? owner.pactSide : f.forwardSide;
    const attackerSide = attacker === 'pact' ? pactSide : pactSide === 0 ? 1 : 0;
    const points = densify(start.points);
    lines.push({
      layer: 'front',
      points,
      style: {
        ...FRONT_STYLE,
        teeth: {
          side: teethSide(points, attacker, start.sides[attackerSide].centroid, territory),
          color: FACTION_COLORS[attacker],
          ...TEETH,
        },
      },
      bands: ALL,
    });
    for (const id of f.lines) {
      if (id === f.start) continue;
      lines.push({
        layer: 'defense',
        points: densify(graph.barrierLines[id]!.points),
        style: DEFENSE_STYLE,
        bands: BELOW_GLOBE,
      });
    }
    for (const k of f.corridors) {
      if (k.line !== f.start) continue;
      // From the attacker's side across the line; `from` lies on side 0.
      const [a, b] = attackerSide === 0 ? [k.from, k.to] : [k.to, k.from];
      lines.push({
        layer: 'corridors',
        points: greatCircle(a, b),
        style: {
          color: FACTION_COLORS[attacker],
          width: CORRIDOR_SHAFT.width,
          casing: CORRIDOR_SHAFT.casing,
          casingOpacity: CORRIDOR_SHAFT.casingOpacity,
          dash: 0,
          duty: 1,
          roundEnds: false,
          teeth: null,
        },
        bands: BELOW_GLOBE,
        name: k.name,
        side: attacker,
      });
      marks.push({
        layer: 'corridors',
        shape: 'arrowhead',
        point: b,
        axis: tangentAt(b, a, -1),
        length: ARROWHEAD.length,
        width: ARROWHEAD.width,
        color: FACTION_COLORS[attacker],
        outline: 0,
        casing: CORRIDOR_SHAFT.casing,
        bands: BELOW_GLOBE,
      });
    }
  }

  // Sea lanes and chokepoints in play.
  const laneUse = new Map<number, Theater>();
  const chokes = new Map<number, boolean>(); // id → in a chokepoint theater
  for (const t of cast.theaters) {
    if (t.kind === 'sea-lane' && t.lane !== undefined) laneUse.set(t.lane, t);
    if (t.kind === 'chokepoint' && t.chokepoint !== undefined) {
      chokes.set(t.chokepoint, true);
      for (const l of graph.chokepoints[t.chokepoint]?.lanes ?? [])
        if (!laneUse.has(l)) laneUse.set(l, t);
    }
  }
  for (const [id, t] of laneUse) {
    const lane = graph.lanes[id];
    if (!lane) continue;
    const side = laneSide(cast, lane.a, lane.b, t);
    lines.push({
      layer: 'lanes',
      points: densify(lane.points),
      style: {
        color: side ? FACTION_COLORS[side] : FRONT_COLOR,
        ...LANE_STYLE,
        roundEnds: true,
        teeth: null,
      },
      // A sea-lane theater's lane is its front: it shows with the theater names.
      bands: t.kind === 'sea-lane' && t.lane === id ? ALL : BELOW_GLOBE,
    });
    for (const k of graph.chokepoints)
      if (k.lanes.includes(id) && !chokes.has(k.id)) chokes.set(k.id, false);
  }
  for (const [id, inTheater] of chokes) {
    const k = graph.chokepoints[id];
    if (!k) continue;
    const lane = graph.lanes[k.lanes[0] ?? -1];
    const size = inTheater ? CHOKEPOINT.theaterSize : CHOKEPOINT.size;
    marks.push({
      layer: 'chokepoints',
      shape: 'diamond',
      point: k.point,
      axis: lane ? laneTangent(lane.points, k.point) : northOf(k.point),
      length: size,
      width: size,
      color: FRONT_COLOR,
      outline: CHOKEPOINT.outline,
      casing: 1,
      bands: BELOW_GLOBE,
    });
  }
  return { lines, marks };
}

/** Who sails a lane: the side holding both ends, else the defender of its theater. */
function laneSide(cast: Cast, a: number, b: number, t: Theater): Side | null {
  const held = (n: number): Side | null => {
    const o = cast.owners[n];
    return o?.kind === 'whole' ? o.side : null;
  };
  const sa = held(a);
  const sb = held(b);
  if (sa && sa === sb) return sa;
  if (t.attacker !== 'mutual') return other(t.attacker);
  return sa ?? sb;
}

/**
 * Which side of the line (+1 left, −1 right, looking along the points) the attacker
 * holds: a vote over the territory raster about two cells off the line, else the side
 * of the attacker's centroid.
 */
export function teethSide(
  points: Float64Array,
  attacker: Side,
  centroid: Readonly<Point>,
  territory: TerritoryLookup | null,
): 1 | -1 {
  const n = points.length / 3;
  if (territory && n >= 2) {
    const code = CODE[attacker];
    let vote = 0;
    const off = 2 * territory.cellAngle;
    for (let i = 0; i < n; i++) {
      const p = polylinePoint(points, i);
      const left = leftOf(points, i);
      const l = territory.ownerAt(offset(p, left, off)) === code;
      const r = territory.ownerAt(offset(p, left, -off)) === code;
      vote += (l ? 1 : 0) - (r ? 1 : 0);
    }
    if (vote !== 0) return vote > 0 ? 1 : -1;
  }
  const mid = Math.floor(n / 2);
  const p = polylinePoint(points, mid);
  const left = leftOf(points, mid);
  const d = dot3(sub3(centroid, p), left);
  return d >= 0 ? 1 : -1;
}

/** Unit vector to the left of the polyline at point i, in the tangent plane. */
function leftOf(points: Float64Array, i: number): Point {
  const n = points.length / 3;
  const p = polylinePoint(points, i);
  const a = polylinePoint(points, Math.max(0, i - 1));
  const b = polylinePoint(points, Math.min(n - 1, i + 1));
  return normalize(cross3(p, sub3(b, a)));
}

function offset(p: Readonly<Point>, dir: Readonly<Point>, angle: number): Point {
  return normalize([
    p[0] * Math.cos(angle) + dir[0] * Math.sin(angle),
    p[1] * Math.cos(angle) + dir[1] * Math.sin(angle),
    p[2] * Math.cos(angle) + dir[2] * Math.sin(angle),
  ]);
}

/** The polyline split so no great-circle step exceeds MAX_STEP. */
export function densify(points: Float64Array, maxStep = MAX_STEP): Float64Array {
  const n = points.length / 3;
  if (n < 2) return Float64Array.from(points);
  const out: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const seg = greatCircle(polylinePoint(points, i), polylinePoint(points, i + 1), maxStep);
    // Every segment but the first starts where the last one ended.
    for (let k = i === 0 ? 0 : 3; k < seg.length; k++) out.push(seg[k]!);
  }
  return Float64Array.from(out);
}

/** Points along the great circle from a to b, at most `maxStep` apart, both ends included. */
export function greatCircle(
  a: Readonly<Point>,
  b: Readonly<Point>,
  maxStep = MAX_STEP,
): Float64Array {
  const angle = Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));
  const steps = Math.max(1, Math.ceil(angle / maxStep));
  const s = Math.sin(angle);
  const out = new Float64Array((steps + 1) * 3);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wa = s < 1e-12 ? 1 - t : Math.sin((1 - t) * angle) / s;
    const wb = s < 1e-12 ? t : Math.sin(t * angle) / s;
    const p = normalize([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
    out.set(p, i * 3);
  }
  return out;
}

/** Unit tangent at p toward q (sign +1) or away from it (−1). */
function tangentAt(p: Readonly<Point>, q: Readonly<Point>, sign: 1 | -1): Point {
  const d = sub3(q, p);
  const t = sub3(d, scale3(p, dot3(d, p)));
  return scale3(normalize(t), sign);
}

/** Tangent of a lane at the point of it nearest to `p`. */
function laneTangent(points: Float64Array, p: Readonly<Point>): Point {
  const n = points.length / 3;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = surfaceDistance(polylinePoint(points, i), p, 1);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const a = polylinePoint(points, Math.max(0, best - 1));
  const b = polylinePoint(points, Math.min(n - 1, best + 1));
  const d = sub3(b, a);
  const t = sub3(d, scale3(p, dot3(d, p)));
  return Math.hypot(...t) > 1e-12 ? normalize(t) : northOf(p);
}

function northOf(p: Readonly<Point>): Point {
  const t = sub3([0, 1, 0], scale3(p, p[1]));
  return Math.hypot(...t) > 1e-9 ? normalize(t) : [0, 0, 1];
}

function dot3(a: Readonly<Point>, b: Readonly<Point>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function sub3(a: Readonly<Point>, b: Readonly<Point>): Point {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale3(a: Readonly<Point>, s: number): Point {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function cross3(a: Readonly<Point>, b: Readonly<Point>): Point {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Readonly<Point>): Point {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
