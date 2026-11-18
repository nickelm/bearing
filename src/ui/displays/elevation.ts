/**
 * The moving map's elevation modes (decision 227; Part I, Moving Map): terrain tinted by
 * height with thin dark contours and a spot height, or, in the relative mode, colored
 * against the aircraft's altitude: red with a diagonal hatch where the ground rises above
 * it, amber within 500 ft below, plain gray-green shading where it lies clear below. Pure:
 * from the snapshot's height samples to a raster of colors and a few symbols.
 */
import type { ScreenItem } from './model';
import type { SnapshotTerrain } from './snapshot';

const FOOT = 0.3048;

/** Part I's tints: height (m) and color. */
const TINTS: [number, number][] = [
  [0, 0x5e7f5a],
  [500, 0x8a9a62],
  [1000, 0xb5a46e],
  [2000, 0xa88660],
  [3000, 0x8f7a6e],
  [4000, 0xd8d4cc],
];
const WATER = 0x3d5a73;
const RED = 0xd9483b;
const AMBER = 0xe8a33d;
const CLEAR = 0x7d8a78;

const mix = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s;
  return ch(16) | ch(8) | ch(0);
};
const shade = (c: number, k: number) => {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((c >> s) & 255) * k))) << s;
  return ch(16) | ch(8) | ch(0);
};

/** The tint at height `h` (m). */
export function tint(h: number): number {
  if (h <= TINTS[0]![0]) return TINTS[0]![1];
  for (let i = 1; i < TINTS.length; i++) {
    const [h1, c1] = TINTS[i]!;
    const [h0, c0] = TINTS[i - 1]!;
    if (h <= h1) return mix(c0, c1, (h - h0) / (h1 - h0));
  }
  return TINTS[TINTS.length - 1]![1];
}

/**
 * The relative mode's class of a cell at height `h` for an aircraft at `alt` (m): above it,
 * within 500 ft below it, or clear.
 */
export function relativeClass(h: number, alt: number): 'above' | 'near' | 'clear' {
  if (h >= alt) return 'above';
  if (h >= alt - 500 * FOOT) return 'near';
  return 'clear';
}

/**
 * The raster (filling the screen) and the spot height for `t` in `mode`. Contours every
 * 100 m (500 ft in Alliance skins), every fifth darker.
 */
export function elevationItems(
  t: SnapshotTerrain,
  mode: 'elevation' | 'relative',
  pact: boolean,
): ScreenItem[] {
  const n = t.n;
  const at = (i: number, j: number) => t.heights[j * n + i]!;
  const wet = (i: number, j: number) => t.water[j * n + i] === 1;
  const step = pact ? 100 : 500 * FOOT;
  const cell = (2 * t.halfExtent) / n;
  const colors = new Array<number>(n * n);
  let top = { h: -Infinity, i: 0, j: 0 };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const h = at(i, j);
      let c: number;
      if (wet(i, j)) c = WATER;
      else {
        // Light from the northwest of the picture: a gentle hillshade for depth.
        const dx = (at(Math.min(n - 1, i + 1), j) - at(Math.max(0, i - 1), j)) / (2 * cell);
        const dy = (at(i, Math.min(n - 1, j + 1)) - at(i, Math.max(0, j - 1))) / (2 * cell);
        const lit = Math.max(0.7, Math.min(1.2, 1 - 0.9 * (dx + dy)));
        if (mode === 'elevation') {
          c = shade(tint(h), lit);
          const band = Math.floor(h / step);
          const r = i + 1 < n ? Math.floor(at(i + 1, j) / step) : band;
          const d = j + 1 < n ? Math.floor(at(i, j + 1) / step) : band;
          if (r !== band || d !== band) {
            const major = Math.max(band, r, d) % 5 === 0;
            c = shade(c, major ? 0.55 : 0.75);
          }
        } else {
          const k = relativeClass(h, t.altitude);
          if (k === 'above') c = (i + j) % 4 < 2 ? RED : shade(RED, 0.6);
          else if (k === 'near') c = shade(AMBER, lit);
          else c = shade(CLEAR, lit);
        }
        if (h > top.h) top = { h, i, j };
      }
      // The raster's row 0 is at the bottom.
      colors[(n - 1 - j) * n + i] = c;
    }
  const items: ScreenItem[] = [
    { kind: 'raster', x: 0, y: 0, w: 1, h: 1, cols: n, rows: n, values: [], colors },
  ];
  if (top.h > 0) {
    const x = (top.i + 0.5) / n;
    const y = (top.j + 0.5) / n;
    const q = 0.014;
    items.push({
      kind: 'line',
      points: [
        [x - q, y + q * 0.8],
        [x, y - q],
        [x + q, y + q * 0.8],
        [x - q, y + q * 0.8],
      ],
      tone: 'normal',
    });
    const fig = pact ? `${Math.round(top.h / 10) * 10}` : `${Math.round(top.h / FOOT / 10) * 10}`;
    // The figure on the side toward the center, clear of the edge buttons' labels.
    const left = x > 0.5;
    items.push({
      kind: 'text',
      x: left ? x - 0.025 : x + 0.025,
      y: y + 0.01,
      text: fig,
      size: 'small',
      align: left ? 'right' : 'left',
      tone: 'normal',
    });
  }
  return items;
}
