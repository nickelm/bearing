/**
 * Signed-distance-field glyph atlas for map labels (decision 98), generated at
 * load time from the label fonts with opentype.js. Pure TypeScript: it runs the
 * same in the browser, in Node previews and in tests.
 *
 * - **Glyphs.** Each glyph outline is flattened to line segments at `EM_PX` pixels
 *   per em; every texel stores the signed distance to the outline (inside
 *   positive, by the nonzero winding rule), mapped so 0.5 is the edge and ±`SPREAD`
 *   pixels span 0..1.
 * - **Packing.** Rows of glyphs into an atlas `ATLAS_WIDTH` wide, one byte per texel.
 * - **Metrics.** Advance, bearings and kerning in em units, so layout scales to any
 *   size; the shader reconstructs a sharp edge from the distance at any scale.
 *
 * A single-channel SDF rounds the sharpest corners a little at large sizes; map labels
 * stay under about 24 px, where the rounding is invisible (decision 98).
 */
import opentype from 'opentype.js';

/** Pixels per em in the atlas. */
export const EM_PX = 32;
/**
 * Distance range (atlas px) on each side of the edge: a quarter em, so an 11 px
 * label still has 2.75 px of field outside its letters for the halo.
 */
export const SPREAD = 8;
export const ATLAS_WIDTH = 1024;
/** Printable ASCII plus the few symbols labels use. */
export const CHARSET =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~°–’';

export type FontId = 'serifItalic' | 'sans' | 'sansBold';
export const FONT_IDS: readonly FontId[] = ['serifItalic', 'sans', 'sansBold'];

export interface GlyphMetrics {
  /** Atlas rectangle (texels), including the SDF padding. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Offset of the rectangle's left and top edges from the pen position on the baseline (em). */
  left: number;
  top: number;
  /** Advance width (em). */
  advance: number;
}

export interface FontMetrics {
  glyphs: Map<string, GlyphMetrics>;
  /** Ascender and descender (em, descender negative). */
  ascent: number;
  descent: number;
  /** Kerning between two characters (em). */
  kerning(a: string, b: string): number;
}

export interface FontAtlas {
  width: number;
  height: number;
  /** One byte per texel, row-major from the top. */
  data: Uint8Array;
  fonts: Record<FontId, FontMetrics>;
}

type Seg = [number, number, number, number];

/** Flattens an opentype path into line segments (px, y down). */
function flatten(cmds: opentype.PathCommand[]): Seg[] {
  const segs: Seg[] = [];
  let x0 = 0;
  let y0 = 0;
  let sx = 0;
  let sy = 0;
  const line = (x: number, y: number) => {
    if (x !== x0 || y !== y0) segs.push([x0, y0, x, y]);
    x0 = x;
    y0 = y;
  };
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        x0 = sx = c.x;
        y0 = sy = c.y;
        break;
      case 'L':
        line(c.x, c.y);
        break;
      case 'Q': {
        const ax = x0;
        const ay = y0;
        for (let i = 1; i <= 6; i++) {
          const t = i / 6;
          const u = 1 - t;
          line(
            u * u * ax + 2 * u * t * c.x1 + t * t * c.x,
            u * u * ay + 2 * u * t * c.y1 + t * t * c.y,
          );
        }
        break;
      }
      case 'C': {
        const ax = x0;
        const ay = y0;
        for (let i = 1; i <= 8; i++) {
          const t = i / 8;
          const u = 1 - t;
          line(
            u * u * u * ax + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
            u * u * u * ay + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
          );
        }
        break;
      }
      case 'Z':
        line(sx, sy);
        break;
    }
  }
  return segs;
}

/** Signed distance field of segments over a w × h texel box at offset (ox, oy). */
export function sdf(
  segs: readonly Seg[],
  ox: number,
  oy: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const py = oy + j + 0.5;
    for (let i = 0; i < w; i++) {
      const px = ox + i + 0.5;
      let d2 = Infinity;
      let winding = 0;
      for (const [x1, y1, x2, y2] of segs) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x1 + t * dx - px;
        const ey = y1 + t * dy - py;
        const e = ex * ex + ey * ey;
        if (e < d2) d2 = e;
        // Nonzero winding: a ray toward +x.
        if (y1 <= py !== y2 <= py) {
          const xi = x1 + ((py - y1) / (y2 - y1)) * dx;
          if (xi > px) winding += y2 > y1 ? 1 : -1;
        }
      }
      const d = Math.sqrt(d2) * (winding !== 0 ? 1 : -1);
      out[j * w + i] = Math.max(0, Math.min(255, Math.round((0.5 + d / (2 * SPREAD)) * 255)));
    }
  }
  return out;
}

/** Builds the atlas from the three label fonts (WOFF or TTF bytes). */
export function buildFontAtlas(buffers: Record<FontId, ArrayBuffer>): FontAtlas {
  const glyphs: {
    font: FontId;
    ch: string;
    data: Uint8Array;
    w: number;
    h: number;
    m: GlyphMetrics;
  }[] = [];
  const fonts = {} as Record<FontId, FontMetrics>;
  for (const id of FONT_IDS) {
    const font = opentype.parse(buffers[id]);
    const upm = font.unitsPerEm;
    const map = new Map<string, GlyphMetrics>();
    for (const ch of CHARSET) {
      const g = font.charToGlyph(ch);
      const path = g.getPath(0, 0, EM_PX);
      const box = path.getBoundingBox();
      const empty = !Number.isFinite(box.x1) || box.x2 <= box.x1;
      const x0 = empty ? 0 : Math.floor(box.x1) - SPREAD;
      const y0 = empty ? 0 : Math.floor(box.y1) - SPREAD;
      const w = empty ? 0 : Math.ceil(box.x2) + SPREAD - x0;
      const h = empty ? 0 : Math.ceil(box.y2) + SPREAD - y0;
      const m: GlyphMetrics = {
        x: 0,
        y: 0,
        w,
        h,
        left: x0 / EM_PX,
        top: y0 / EM_PX,
        advance: (g.advanceWidth ?? 0) / upm,
      };
      map.set(ch, m);
      if (!empty)
        glyphs.push({ font: id, ch, data: sdf(flatten(path.commands), x0, y0, w, h), w, h, m });
    }
    fonts[id] = {
      glyphs: map,
      ascent: font.ascender / upm,
      descent: font.descender / upm,
      kerning: (a, b) => font.getKerningValue(font.charToGlyph(a), font.charToGlyph(b)) / upm,
    };
  }
  // Shelf packing, tallest first.
  const order = [...glyphs].sort(
    (a, b) => b.h - a.h || a.font.localeCompare(b.font) || a.ch.localeCompare(b.ch),
  );
  let x = 0;
  let y = 0;
  let row = 0;
  for (const g of order) {
    if (x + g.w + 1 > ATLAS_WIDTH) {
      x = 0;
      y += row + 1;
      row = 0;
    }
    g.m.x = x;
    g.m.y = y;
    x += g.w + 1;
    row = Math.max(row, g.h);
  }
  const height = 2 ** Math.ceil(Math.log2(Math.max(1, y + row + 1)));
  const data = new Uint8Array(ATLAS_WIDTH * height);
  for (const g of glyphs) {
    for (let j = 0; j < g.h; j++)
      data.set(g.data.subarray(j * g.w, (j + 1) * g.w), (g.m.y + j) * ATLAS_WIDTH + g.m.x);
  }
  return { width: ATLAS_WIDTH, height, data, fonts };
}
