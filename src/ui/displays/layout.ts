/**
 * Where the display slots sit (Proposal 0006, decisions 189 and 195): a pure
 * function of the viewport and the UI scale. Nothing else enters it (not the
 * master mode, the aircraft or its avionics profile), so a slot has one place
 * for every aircraft and every mode; the profile only decides which slots are
 * drawn. Rects are in CSS pixels, rounded to whole pixels for crisp chrome.
 *
 * - **Large slots** (left and right MFD): squares docked in the lower corners,
 *   about 28% of the viewport's height at UI scale 1.
 * - **Small slots:** the threat display, a square in the upper right, and the
 *   messages log, as wide as a large slot, in the upper left; both 60% of a
 *   large slot's side high.
 * - **Status strip:** bottom center, below the aircraft.
 * - **Central column:** the middle 60% of the width, above the strip, belongs to
 *   the aircraft and the HUD. Slots never reach into it: on narrow viewports
 *   (4:3, portrait) the large slots shrink to the width the column leaves, and
 *   the small slots with them. The UI scale grows the slots only until they
 *   meet the column: on 16:9 that is at about 1.16; wider screens have room up
 *   to the scale's maximum.
 * - **Tabs:** a collapsed slot is a tab on its screen edge, at its outer corner
 *   (the bottom edge for the large slots, the top edge for the small ones). The
 *   strip has no tab: it is shown or hidden.
 */

export type SlotId = 'leftMfd' | 'rightMfd' | 'threat' | 'messages' | 'strip';

/** The slots in a fixed order: left to right along the bottom, then the upper corners. */
export const SLOT_IDS: readonly SlotId[] = ['leftMfd', 'strip', 'rightMfd', 'messages', 'threat'];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SlotLayout {
  /** The expanded slot. */
  rect: Rect;
  /** The collapsed slot's tab, on the screen edge; null for the strip. */
  tab: Rect | null;
  /** The screen edge the slot is docked to (and its tab sits on). */
  edge: 'top' | 'bottom';
}

export interface DisplayLayout {
  viewport: { width: number; height: number };
  /** The UI scale used, after clamping. */
  scale: number;
  /** The gap to the screen edges and between slots (px). */
  margin: number;
  slots: Record<SlotId, SlotLayout>;
  /** The central column above the strip: the aircraft's and the HUD's. */
  center: Rect;
}

/** The UI scale setting's range. */
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.5;

/** A large slot's side as a share of the viewport's height at UI scale 1 (Proposal 0006). */
export const LARGE_SHARE = 0.28;
/** The central column's share of the width (Proposal 0006: roughly the middle 60%). */
export const CENTER_SHARE = 0.6;
/** A small slot's height as a share of a large slot's side. */
export const SMALL_SHARE = 0.6;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The slots' rects for a viewport of `width` × `height` CSS px at UI scale `uiScale`. */
export function layout(viewport: { width: number; height: number }, uiScale = 1): DisplayLayout {
  const W = Math.max(1, Math.round(viewport.width));
  const H = Math.max(1, Math.round(viewport.height));
  const s = clamp(Number.isFinite(uiScale) ? uiScale : 1, UI_SCALE_MIN, UI_SCALE_MAX);
  const m = Math.round(Math.max(8, 0.015 * H));
  // The column's edge; a slot ends a margin short of it.
  const side = Math.floor(((1 - CENTER_SHARE) / 2) * W);
  const strip = Math.max(24, Math.round(0.04 * H * s));
  // Large slots: the share of the height, no wider than the side bands, and short enough
  // that a small slot fits above them.
  const byHeight = (H - 3 * m) / (1 + SMALL_SHARE);
  const L = Math.max(0, Math.floor(Math.min(LARGE_SHARE * H * s, side - 2 * m, byHeight)));
  const S = Math.round(SMALL_SHARE * L);
  const tabH = Math.max(16, Math.round(22 * s));
  const tabW = Math.round(L / 2);

  const leftMfd: Rect = { x: m, y: H - m - L, width: L, height: L };
  const rightMfd: Rect = { x: W - m - L, y: H - m - L, width: L, height: L };
  const messages: Rect = { x: m, y: m, width: L, height: S };
  const threat: Rect = { x: W - m - S, y: m, width: S, height: S };
  const stripW = Math.max(0, Math.min(Math.round(0.5 * W), W - 2 * side - 2 * m));
  const stripRect: Rect = {
    x: Math.round((W - stripW) / 2),
    y: H - m - strip,
    width: stripW,
    height: strip,
  };
  const bottomTab = (r: Rect, outerLeft: boolean): Rect => ({
    x: outerLeft ? r.x : r.x + r.width - Math.min(tabW, r.width),
    y: H - m - tabH,
    width: Math.min(tabW, r.width),
    height: tabH,
  });
  const topTab = (r: Rect, outerLeft: boolean): Rect => ({
    x: outerLeft ? r.x : r.x + r.width - Math.min(tabW, r.width),
    y: m,
    width: Math.min(tabW, r.width),
    height: tabH,
  });

  return {
    viewport: { width: W, height: H },
    scale: s,
    margin: m,
    slots: {
      leftMfd: { rect: leftMfd, tab: bottomTab(leftMfd, true), edge: 'bottom' },
      rightMfd: { rect: rightMfd, tab: bottomTab(rightMfd, false), edge: 'bottom' },
      messages: { rect: messages, tab: topTab(messages, true), edge: 'top' },
      threat: { rect: threat, tab: topTab(threat, false), edge: 'top' },
      strip: { rect: stripRect, tab: null, edge: 'bottom' },
    },
    center: { x: side, y: 0, width: W - 2 * side, height: stripRect.y - m },
  };
}

/** Whether two rects share any area (touching edges do not). */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
