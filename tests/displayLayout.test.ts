/**
 * The display slots' layout (src/ui/displays/layout.ts; Proposal 0006,
 * decision 195): fixed by the viewport and the UI scale alone, inside the
 * screen, never overlapping, never reaching into the central column, with the
 * strip below it, and pinned at 1920 × 1080 so a change of position is a
 * deliberate one.
 */
import { describe, expect, it } from 'vitest';
import {
  CENTER_SHARE,
  LARGE_SHARE,
  layout,
  overlaps,
  SLOT_IDS,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
} from '../src/ui/displays/layout';
import type { Rect } from '../src/ui/displays/layout';

const VIEWPORTS: [number, number][] = [
  [1920, 1080],
  [1366, 768],
  [1280, 720],
  [2560, 1440],
  [3840, 2160],
  [1680, 1050],
  [1440, 1080],
  [1024, 768],
  [3440, 1440],
  [800, 600],
  [640, 360],
  [720, 1280],
];
const SCALES = [UI_SCALE_MIN, 1, 1.25, UI_SCALE_MAX];

const inside = (r: Rect, W: number, H: number) =>
  r.x >= 0 && r.y >= 0 && r.x + r.width <= W && r.y + r.height <= H;
const whole = (r: Rect) => [r.x, r.y, r.width, r.height].every(Number.isInteger);

describe('display layout', () => {
  for (const [W, H] of VIEWPORTS)
    for (const s of SCALES)
      it(`${W} × ${H} at UI scale ${s}`, () => {
        const L = layout({ width: W, height: H }, s);
        const rects = SLOT_IDS.map((id) => L.slots[id].rect);
        for (const r of rects) {
          expect(inside(r, W, H)).toBe(true);
          expect(whole(r)).toBe(true);
          expect(r.width).toBeGreaterThan(0);
          expect(r.height).toBeGreaterThan(0);
        }
        // No two slots overlap.
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++)
            expect(overlaps(rects[i]!, rects[j]!), `${SLOT_IDS[i]} and ${SLOT_IDS[j]}`).toBe(false);
        // The central column spans the middle 60% of the width, above the strip, and only
        // the strip (below it) shares its width.
        const c = L.center;
        expect(c.x).toBeLessThanOrEqual(Math.ceil(((1 - CENTER_SHARE) / 2) * W));
        expect(c.x + c.width).toBeGreaterThanOrEqual(Math.floor(((1 + CENTER_SHARE) / 2) * W));
        for (const id of SLOT_IDS) {
          const r = L.slots[id].rect;
          expect(overlaps(r, c), `${id} in the central column`).toBe(false);
        }
        const strip = L.slots.strip.rect;
        expect(strip.y).toBeGreaterThanOrEqual(c.y + c.height);
        expect(strip.x).toBeGreaterThanOrEqual(c.x);
        expect(strip.x + strip.width).toBeLessThanOrEqual(c.x + c.width);
        // Large slots are squares at 28% of the height, unless the side bands are narrower.
        const left = L.slots.leftMfd.rect;
        const right = L.slots.rightMfd.rect;
        expect(left.width).toBe(left.height);
        expect(left.width).toBeLessThanOrEqual(LARGE_SHARE * H * L.scale);
        // Mirrored left and right; the small slots at the top.
        expect(left.x).toBe(W - right.x - right.width);
        expect(left.y).toBe(right.y);
        expect(L.slots.messages.rect.y).toBe(L.slots.threat.rect.y);
        // Tabs: on their screen edge, at the slot's outer corner, inside it.
        for (const id of SLOT_IDS) {
          const { rect, tab, edge } = L.slots[id];
          if (id === 'strip') {
            expect(tab).toBeNull();
            continue;
          }
          expect(tab).not.toBeNull();
          const t = tab!;
          expect(whole(t)).toBe(true);
          expect(t.x >= rect.x && t.x + t.width <= rect.x + rect.width).toBe(true);
          if (edge === 'bottom') expect(t.y + t.height).toBe(rect.y + rect.height);
          else expect(t.y).toBe(rect.y);
        }
      });

  it('makes large slots 28% of the height on a 16:9 screen, and scales them together', () => {
    const a = layout({ width: 1920, height: 1080 }, 1);
    const b = layout({ width: 1920, height: 1080 }, 1.1);
    expect(a.slots.leftMfd.rect.width).toBe(Math.floor(0.28 * 1080));
    expect(b.slots.leftMfd.rect.width).toBe(Math.floor(0.28 * 1.1 * 1080));
    expect(b.slots.threat.rect.width / a.slots.threat.rect.width).toBeCloseTo(1.1, 1);
  });

  it('stops growing the slots at the central column: above about 1.16 on 16:9', () => {
    const big = layout({ width: 1920, height: 1080 }, 1.5);
    expect(big.slots.leftMfd.rect.width).toBe(384 - 2 * 16);
    const wide = layout({ width: 3440, height: 1440 }, 1.5);
    expect(wide.slots.leftMfd.rect.width).toBe(Math.floor(0.28 * 1.5 * 1440));
  });

  it('clamps the UI scale', () => {
    expect(layout({ width: 1920, height: 1080 }, 9).scale).toBe(UI_SCALE_MAX);
    expect(layout({ width: 1920, height: 1080 }, 0.1).scale).toBe(UI_SCALE_MIN);
    expect(layout({ width: 1920, height: 1080 }, Number.NaN).scale).toBe(1);
  });

  it('keeps slots out of the central column on narrow screens by shrinking them', () => {
    const narrow = layout({ width: 1024, height: 768 });
    expect(narrow.slots.leftMfd.rect.width).toBeLessThan(Math.floor(0.28 * 768));
    expect(narrow.slots.leftMfd.rect.x + narrow.slots.leftMfd.rect.width).toBeLessThanOrEqual(
      narrow.center.x - narrow.margin,
    );
  });

  it('is pinned at 1920 × 1080, UI scale 1', () => {
    const L = layout({ width: 1920, height: 1080 });
    expect(L.margin).toBe(16);
    expect(L.slots.leftMfd.rect).toEqual({ x: 16, y: 762, width: 302, height: 302 });
    expect(L.slots.rightMfd.rect).toEqual({ x: 1602, y: 762, width: 302, height: 302 });
    expect(L.slots.messages.rect).toEqual({ x: 16, y: 16, width: 302, height: 181 });
    expect(L.slots.threat.rect).toEqual({ x: 1723, y: 16, width: 181, height: 181 });
    expect(L.slots.strip.rect).toEqual({ x: 480, y: 1021, width: 960, height: 43 });
    expect(L.center).toEqual({ x: 384, y: 0, width: 1152, height: 1005 });
    expect(L.slots.leftMfd.tab).toEqual({ x: 16, y: 1042, width: 151, height: 22 });
  });
});
