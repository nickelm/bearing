/**
 * Label layout and placement in screen space (visual-style Part II, Labels;
 * decision 98). Pure TypeScript: tests run it on synthetic layouts and on real
 * worlds without a GPU.
 *
 * - **Text.** `layoutText` sets a string in a style: kerning, tracking, capitals.
 * - **Point labels** (settlements, peaks, straits) try right of the anchor, then
 *   left, above and below, past the marker gap. Theater names sit centered on their
 *   anchor, or above or below the front or lane they are anchored on.
 * - **Line labels** (rivers, ranges) run along the projected polyline, centered at
 *   one of several stations along its longest visible stretch, turned so the text
 *   is never upside down, and rejected where it bends more than `MAX_BEND`
 *   between letters.
 * - **Area labels** (seas, deserts, forests, plains…) run along the feature's
 *   axis, letter-spaced to fill about `AREA_FILL` of it; where the axis is too
 *   short or too steep, they sit level on the anchor.
 * - **Collision.** `placeLabels` takes labels in order of importance (a label that
 *   was placed last time gets `STICKY` extra, so the layout does not flicker),
 *   lays each out by its candidates, and keeps the first candidate whose glyph
 *   boxes (ink plus halo) lie inside the viewport and overlap no placed glyph.
 * - **Per frame.** Between placement passes, `layoutLabel` lays a placed label
 *   out again with its chosen candidate, so text follows the camera without a
 *   new collision pass.
 */
import { EM_PX, SPREAD } from './fontAtlas';
import type { FontAtlas, GlyphMetrics } from './fontAtlas';
import type { MapLabel } from './labelModel';
import { LABEL_STYLES } from './labelStyles';
import type { LabelStyle } from './labelStyles';
import type { Point } from '../../../worldgen/strategic/graph';

/** Projects a unit direction at a raw terrain height to screen pixels, or null if hidden. */
export interface LabelView {
  width: number;
  height: number;
  project(p: Readonly<Point>, height: number): [number, number] | null;
}

type V3 = { readonly x: number; readonly y: number; readonly z: number };

/**
 * The strategic camera's projection for labels: a perspective view from `eye`
 * (planet-centered, m) along `forward` with `up`, in CSS pixels. Ground points
 * stand at radius + height × exaggeration; points on the far side of the globe,
 * or seen within about 12° of the horizon (`GRAZING`), are hidden.
 */
export function perspectiveView(c: {
  eye: V3;
  forward: V3;
  up: V3;
  fovY: number;
  width: number;
  height: number;
  near: number;
  radius: number;
  exaggeration: number;
}): LabelView {
  const { eye, forward: f, up: u, width: W, height: H, radius: R } = c;
  const ty = Math.tan(c.fovY / 2);
  const tx = (ty * W) / H;
  const right = { x: f.y * u.z - f.z * u.y, y: f.z * u.x - f.x * u.z, z: f.x * u.y - f.y * u.x };
  return {
    width: W,
    height: H,
    project: (p, h) => {
      // Hidden behind the globe: the ground point must face the eye.
      if (p[0] * eye.x + p[1] * eye.y + p[2] * eye.z < R) return null;
      const r = R + Math.max(0, h) * c.exaggeration;
      const x = p[0] * r - eye.x;
      const y = p[1] * r - eye.y;
      const z = p[2] * r - eye.z;
      const depth = x * f.x + y * f.y + z * f.z;
      if (depth <= c.near) return null;
      // Ground seen at a grazing angle near the horizon squashes text: hide it.
      const d = Math.hypot(x, y, z);
      if (-(p[0] * x + p[1] * y + p[2] * z) / d < GRAZING) return null;
      const sx = (x * right.x + y * right.y + z * right.z) / (depth * tx);
      const sy = (x * u.x + y * u.y + z * u.z) / (depth * ty);
      return [((sx + 1) / 2) * W, ((1 - sy) / 2) * H];
    },
  };
}

/** One glyph on screen. */
export interface GlyphQuad {
  /** Center (px), size (px) and rotation (rad, clockwise on screen). */
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  glyph: GlyphMetrics;
}

export type Candidate =
  { mode: 'point'; side: 0 | 1 | 2 | 3 } | { mode: 'path'; station: number } | { mode: 'level' };

/** Largest turn between neighboring letters on a path (rad). */
export const MAX_BEND = 0.5;
/** Share of an area's axis its label spans at most. */
export const AREA_FILL = 0.6;
/** Importance bonus for a label placed in the previous pass. */
export const STICKY = 0.08;
/** Stations along a path, as fractions of its visible length. */
const STATIONS = [0.5, 0.35, 0.65, 0.2, 0.8];
/** Least cosine between the ground's normal and the view ray for a label point. */
export const GRAZING = 0.2;
/** Viewport margin (px). */
const MARGIN = 3;

export interface TextRun {
  chars: { ch: string; x: number; m: GlyphMetrics }[];
  /** Advance width (px). */
  width: number;
  size: number;
}

/** Sets text in a style: pen positions (px) from the start, kerning and tracking applied. */
export function layoutText(atlas: FontAtlas, style: LabelStyle, text: string, extra = 0): TextRun {
  const font = atlas.fonts[style.font];
  const s = style.uppercase ? text.toUpperCase() : text;
  const chars: TextRun['chars'] = [];
  let x = 0;
  let prev = '';
  for (const ch of s) {
    const m = font.glyphs.get(ch) ?? font.glyphs.get('?')!;
    if (prev) x += font.kerning(prev, ch) * style.size;
    chars.push({ ch, x, m });
    x += m.advance * style.size + style.tracking * style.size + extra;
    prev = ch;
  }
  // The last letter carries no tracking after it.
  const width = chars.length > 0 ? x - style.tracking * style.size - extra : 0;
  return { chars, width, size: style.size };
}

/** Screen-space path with cumulative length. */
interface ScreenPath {
  pts: [number, number][];
  len: number[];
}

function screenPath(
  view: LabelView,
  path: Float64Array,
  height: number,
  densify: number,
): ScreenPath | null {
  // Densify on the sphere, so long axes follow the globe's curvature on screen.
  const n = path.length / 3;
  const runs: [number, number][][] = [[]];
  for (let i = 0; i < n; i++) {
    const a: Point = [path[i * 3]!, path[i * 3 + 1]!, path[i * 3 + 2]!];
    const steps = i + 1 < n ? densify : 1;
    for (let k = 0; k < steps; k++) {
      let p = a;
      if (k > 0) {
        const b: Point = [path[i * 3 + 3]!, path[i * 3 + 4]!, path[i * 3 + 5]!];
        const t = k / steps;
        const q: Point = [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ];
        const l = Math.hypot(...q);
        p = [q[0] / l, q[1] / l, q[2] / l];
      }
      const s = view.project(p, height);
      if (s) runs[runs.length - 1]!.push(s);
      else if (runs[runs.length - 1]!.length > 0) runs.push([]);
    }
  }
  let best: [number, number][] = [];
  let bestLen = 0;
  for (const r of runs) {
    let l = 0;
    for (let i = 1; i < r.length; i++)
      l += Math.hypot(r[i]![0] - r[i - 1]![0], r[i]![1] - r[i - 1]![1]);
    if (r.length >= 2 && l > bestLen) {
      best = r;
      bestLen = l;
    }
  }
  if (best.length < 2) return null;
  // Read left to right: reverse a path that runs mostly leftward.
  if (best[best.length - 1]![0] < best[0]![0]) best.reverse();
  const len = [0];
  for (let i = 1; i < best.length; i++) {
    len.push(
      len[i - 1]! + Math.hypot(best[i]![0] - best[i - 1]![0], best[i]![1] - best[i - 1]![1]),
    );
  }
  return { pts: best, len };
}

/** Point and tangent angle at arc length s along a screen path. */
function at(p: ScreenPath, s: number): { x: number; y: number; angle: number } {
  const L = p.len;
  let i = 1;
  while (i < L.length - 1 && L[i]! < s) i++;
  const a = p.pts[i - 1]!;
  const b = p.pts[i]!;
  const seg = L[i]! - L[i - 1]! || 1;
  const t = (s - L[i - 1]!) / seg;
  return {
    x: a[0] + (b[0] - a[0]) * t,
    y: a[1] + (b[1] - a[1]) * t,
    angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
  };
}

/** Glyph box center offset from the pen on the baseline (px), and quad size. */
function glyphBox(m: GlyphMetrics, size: number) {
  const k = size / EM_PX;
  return {
    cx: m.left * size + (m.w * k) / 2,
    cy: m.top * size + (m.h * k) / 2,
    w: m.w * k,
    h: m.h * k,
  };
}

/** Baseline shift (px) that centers capitals and lowercase on a line. */
const centerShift = (size: number) => 0.33 * size;

function levelQuads(run: TextRun, x0: number, baseline: number): GlyphQuad[] {
  const out: GlyphQuad[] = [];
  for (const c of run.chars) {
    if (c.m.w === 0) continue;
    const b = glyphBox(c.m, run.size);
    out.push({ x: x0 + c.x + b.cx, y: baseline + b.cy, w: b.w, h: b.h, angle: 0, glyph: c.m });
  }
  return out;
}

function pathQuads(run: TextRun, p: ScreenPath, start: number): GlyphQuad[] | null {
  const out: GlyphQuad[] = [];
  let prevAngle: number | null = null;
  const shift = centerShift(run.size);
  for (const c of run.chars) {
    const adv = c.m.advance * run.size;
    const mid = start + c.x + adv / 2;
    if (mid < 0 || mid > p.len[p.len.length - 1]!) return null;
    const q = at(p, mid);
    if (prevAngle !== null) {
      let d = q.angle - prevAngle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > MAX_BEND) return null;
    }
    prevAngle = q.angle;
    if (c.m.w === 0) continue;
    const b = glyphBox(c.m, run.size);
    // Offset of the glyph box center from the letter's midpoint on the path.
    const ox = b.cx - adv / 2;
    const oy = b.cy + shift;
    const cs = Math.cos(q.angle);
    const sn = Math.sin(q.angle);
    out.push({
      x: q.x + ox * cs - oy * sn,
      y: q.y + ox * sn + oy * cs,
      w: b.w,
      h: b.h,
      angle: q.angle,
      glyph: c.m,
    });
  }
  return out;
}

/** Lays out a label with one candidate; null if it does not fit the view that way. */
export function layoutLabel(
  atlas: FontAtlas,
  label: MapLabel,
  cand: Candidate,
  view: LabelView,
): GlyphQuad[] | null {
  const style = LABEL_STYLES[label.style];
  if (cand.mode === 'point' || cand.mode === 'level') {
    const a = view.project(label.anchor, label.height);
    if (!a) return null;
    const run = layoutText(atlas, style, label.text);
    const shift = centerShift(style.size);
    if (cand.mode === 'level') return levelQuads(run, a[0] - run.width / 2, a[1] + shift);
    const g = label.gap;
    const capH = 0.7 * style.size;
    switch (cand.side) {
      case 0:
        return levelQuads(run, a[0] + g + 2, a[1] + shift);
      case 1:
        return levelQuads(run, a[0] - g - 2 - run.width, a[1] + shift);
      case 2:
        return levelQuads(run, a[0] - run.width / 2, a[1] - g - 3);
      case 3:
        return levelQuads(run, a[0] - run.width / 2, a[1] + g + 3 + capH);
    }
  }
  if (!label.path) return null;
  const area = label.placement === 'area';
  const p = screenPath(view, label.path, label.height, area ? 8 : 2);
  if (!p) return null;
  const total = p.len[p.len.length - 1]!;
  let run = layoutText(atlas, style, label.text);
  if (area) {
    // Spread letters to fill AREA_FILL of the axis, up to an em of extra spacing.
    const gaps = Math.max(1, run.chars.length - 1);
    const extra = Math.min(style.size, Math.max(0, (AREA_FILL * total - run.width) / gaps));
    run = layoutText(atlas, style, label.text, extra);
    const tilt = Math.abs(
      Math.atan2(
        p.pts[p.pts.length - 1]![1] - p.pts[0]![1],
        p.pts[p.pts.length - 1]![0] - p.pts[0]![0],
      ),
    );
    if (run.width > total || tilt > (50 * Math.PI) / 180) return null;
  } else if (run.width > 0.9 * total) {
    return null;
  }
  return pathQuads(run, p, cand.station * total - run.width / 2);
}

/** The candidates of a label, best first. */
export function candidates(label: MapLabel): Candidate[] {
  if (label.placement === 'point') {
    if (label.style !== 'theater')
      return [0, 1, 2, 3].map((side) => ({ mode: 'point', side }) as Candidate);
    // Theater names sit centered on their anchor, or above or below a front or lane
    // they would otherwise cover (decision 101).
    return label.gap > 0
      ? [2, 3, 0, 1].map((side) => ({ mode: 'point', side }) as Candidate)
      : [{ mode: 'level' }];
  }
  const path = STATIONS.map((station) => ({ mode: 'path', station }) as Candidate);
  return label.placement === 'area' ? [{ mode: 'path', station: 0.5 }, { mode: 'level' }] : path;
}

/** Axis-aligned box of a glyph's ink plus the style's halo (px). */
export function glyphBounds(
  q: GlyphQuad,
  size: number,
  halo: number,
): [number, number, number, number] {
  const pad = (SPREAD * size) / EM_PX - halo; // the quad includes the SDF padding
  const hw = Math.max(0.5, q.w / 2 - pad);
  const hh = Math.max(0.5, q.h / 2 - pad);
  const c = Math.abs(Math.cos(q.angle));
  const s = Math.abs(Math.sin(q.angle));
  const ex = hw * c + hh * s;
  const ey = hw * s + hh * c;
  return [q.x - ex, q.y - ey, q.x + ex, q.y + ey];
}

/** A grid of boxes for overlap tests. */
export class BoxIndex {
  private readonly cells = new Map<number, [number, number, number, number][]>();
  constructor(private readonly cell = 48) {}
  private *keys(b: readonly number[]) {
    const c = this.cell;
    for (let i = Math.floor(b[0]! / c); i <= Math.floor(b[2]! / c); i++)
      for (let j = Math.floor(b[1]! / c); j <= Math.floor(b[3]! / c); j++) yield i * 100_003 + j;
  }
  hits(b: readonly [number, number, number, number]): boolean {
    for (const k of this.keys(b)) {
      for (const o of this.cells.get(k) ?? []) {
        if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true;
      }
    }
    return false;
  }
  add(b: [number, number, number, number]): void {
    for (const k of this.keys(b)) {
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(b);
    }
  }
}

export interface Placement {
  candidate: Candidate;
  quads: GlyphQuad[];
}

/**
 * The collision pass: labels by importance, each at its first candidate that fits
 * inside the view and clear of every placed glyph. `previous` holds last pass's
 * placements (for stickiness). Returns placements by label id.
 */
export function placeLabels(
  atlas: FontAtlas,
  labels: readonly MapLabel[],
  view: LabelView,
  previous: ReadonlyMap<number, Placement> = new Map(),
): Map<number, Placement> {
  const order = [...labels].sort((a, b) => {
    const ka = a.importance + (previous.has(a.id) ? STICKY : 0);
    const kb = b.importance + (previous.has(b.id) ? STICKY : 0);
    return kb - ka || a.id - b.id;
  });
  const index = new BoxIndex();
  const out = new Map<number, Placement>();
  for (const label of order) {
    const style = LABEL_STYLES[label.style];
    const prev = previous.get(label.id)?.candidate;
    const cands = candidates(label);
    if (prev) cands.sort((a, b) => Number(sameCandidate(b, prev)) - Number(sameCandidate(a, prev)));
    for (const cand of cands) {
      const quads = layoutLabel(atlas, label, cand, view);
      if (!quads || quads.length === 0) continue;
      const boxes = quads.map((q) => glyphBounds(q, style.size, style.haloWidth));
      const inside = boxes.every(
        (b) =>
          b[0] >= MARGIN &&
          b[1] >= MARGIN &&
          b[2] <= view.width - MARGIN &&
          b[3] <= view.height - MARGIN,
      );
      if (!inside || boxes.some((b) => index.hits(b))) continue;
      for (const b of boxes) index.add(b);
      out.set(label.id, { candidate: cand, quads });
      break;
    }
  }
  return out;
}

function sameCandidate(a: Candidate, b: Candidate): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'point' && b.mode === 'point') return a.side === b.side;
  if (a.mode === 'path' && b.mode === 'path') return a.station === b.station;
  return true;
}
