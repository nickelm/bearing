import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { latLonToDirection } from '../src/core/coords';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { buildFontAtlas, EM_PX, FONT_IDS, SPREAD } from '../src/render/strategic/labels/fontAtlas';
import type { FontAtlas, FontId } from '../src/render/strategic/labels/fontAtlas';
import { LABEL_FONT_FILES } from '../src/render/strategic/labels/fontFiles';
import { bandsFor, buildLabels, peakText } from '../src/render/strategic/labels/labelModel';
import type { MapLabel } from '../src/render/strategic/labels/labelModel';
import {
  glyphBounds,
  layoutLabel,
  layoutText,
  MAX_BEND,
  perspectiveView,
  placeLabels,
} from '../src/render/strategic/labels/labelPlacement';
import type { LabelView, Placement } from '../src/render/strategic/labels/labelPlacement';
import { LABEL_STYLES } from '../src/render/strategic/labels/labelStyles';
import { StrategicCamera } from '../src/render/strategic/strategicCamera';
import { bandForAltitude } from '../src/render/strategic/zoomBands';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import type { Point } from '../src/worldgen/strategic/graph';

let atlas: FontAtlas;
beforeAll(() => {
  const req = createRequire(import.meta.url);
  const buffers = Object.fromEntries(
    FONT_IDS.map((id) => {
      const b = readFileSync(req.resolve(LABEL_FONT_FILES[id]));
      return [id, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)];
    }),
  ) as Record<FontId, ArrayBuffer>;
  atlas = buildFontAtlas(buffers);
});

/** Orthographic test view: longitude and latitude (degrees) to pixels, 10 px per degree. */
const flatView = (width = 800, height = 600): LabelView => ({
  width,
  height,
  project: (p) => {
    const lat = Math.asin(p[1]) / DEG;
    const lon = Math.atan2(p[0], p[2]) / DEG;
    return [width / 2 + lon * 10, height / 2 - lat * 10];
  },
});

const dir = (lat: number, lon: number): Point => {
  const v = latLonToDirection(lat * DEG, lon * DEG, new Vec3d());
  return [v.x, v.y, v.z];
};

function label(id: number, over: Partial<MapLabel>): MapLabel {
  return {
    id,
    text: 'Kessar',
    style: 'town',
    importance: 0.5,
    placement: 'point',
    anchor: dir(0, 0),
    height: 0,
    path: null,
    gap: 4,
    bands: ['region'],
    ...over,
  };
}

/** Every pair of glyph boxes from different labels is disjoint. */
function assertNoOverlap(placed: Map<number, Placement>, labels: readonly MapLabel[]) {
  const boxes: { id: number; b: [number, number, number, number] }[] = [];
  for (const [id, p] of placed) {
    const s = LABEL_STYLES[labels.find((l) => l.id === id)!.style];
    for (const q of p.quads) boxes.push({ id, b: glyphBounds(q, s.size, s.haloWidth) });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const c = boxes[j]!;
      if (a.id === c.id) continue;
      const overlap = a.b[0] < c.b[2] && a.b[2] > c.b[0] && a.b[1] < c.b[3] && a.b[3] > c.b[1];
      expect(overlap, `labels ${a.id} and ${c.id} overlap`).toBe(false);
    }
  }
}

describe('font atlas', () => {
  it('holds every font with sharp distance fields', () => {
    for (const id of FONT_IDS) {
      const f = atlas.fonts[id];
      expect(f.glyphs.get('A')!.advance).toBeGreaterThan(0.4);
      expect(f.ascent).toBeGreaterThan(0.6);
      expect(f.descent).toBeLessThan(0);
      // The middle of a capital I's stem is inside; a texel at the padding's edge is outside.
      const I = f.glyphs.get('I')!;
      const row = I.y + Math.floor(I.h / 2);
      let inside = 0;
      for (let x = I.x; x < I.x + I.w; x++)
        inside = Math.max(inside, atlas.data[row * atlas.width + x]!);
      expect(inside).toBeGreaterThan(140);
      expect(atlas.data[I.y * atlas.width + I.x]).toBeLessThan(40);
    }
    expect(atlas.width * atlas.height).toBeLessThanOrEqual(1024 * 1024);
    expect(SPREAD / EM_PX).toBeGreaterThanOrEqual(0.2);
  });

  it('sets text with tracking and capitals', () => {
    const s = LABEL_STYLES.landform;
    const plain = layoutText(atlas, { ...s, tracking: 0 }, 'Varden Range');
    const tracked = layoutText(atlas, s, 'Varden Range');
    expect(tracked.chars.map((c) => c.ch).join('')).toBe('VARDEN RANGE');
    expect(tracked.width).toBeGreaterThan(plain.width);
    expect(tracked.width - plain.width).toBeCloseTo(s.tracking * s.size * 11, 6);
  });
});

describe('label placement', () => {
  it('places point labels without overlaps, more important first', () => {
    const labels: MapLabel[] = [];
    for (let i = 0; i < 400; i++) {
      const lat = ((i * 37) % 51) - 25 + (i % 7) / 7;
      const lon = ((i * 53) % 71) - 35 + (i % 5) / 5;
      labels.push(
        label(i, { anchor: dir(lat, lon), importance: (i % 10) / 10, text: `Town ${i}` }),
      );
    }
    const placed = placeLabels(atlas, labels, flatView());
    expect(placed.size).toBeGreaterThan(20);
    expect(placed.size).toBeLessThan(labels.length);
    assertNoOverlap(placed, labels);
    for (const p of placed.values()) {
      for (const q of p.quads) {
        expect(q.x).toBeGreaterThan(0);
        expect(q.x).toBeLessThan(800);
      }
    }
  });

  it('lets the more important of two labels on one spot win', () => {
    const a = label(0, { importance: 0.3, text: 'Minor' });
    const b = label(1, { importance: 0.9, text: 'Major' });
    const placed = placeLabels(atlas, [a, b], flatView());
    expect(placed.has(1)).toBe(true);
    expect(placed.get(1)!.candidate).toEqual({ mode: 'point', side: 0 });
  });

  it('runs line labels along their path, left to right and gently bent', () => {
    // A river drawn east to west, gently curving: text must still read left to right.
    const pts: number[] = [];
    for (let i = 0; i <= 30; i++) {
      const lon = 20 - (i * 40) / 30;
      pts.push(...dir(5 * Math.sin((i / 30) * Math.PI), lon));
    }
    const river = label(0, {
      placement: 'line',
      style: 'river',
      text: 'Skaton River',
      path: Float64Array.from(pts),
      gap: 0,
    });
    const quads = layoutLabel(atlas, river, { mode: 'path', station: 0.5 }, flatView())!;
    expect(quads).not.toBeNull();
    for (let i = 1; i < quads.length; i++) {
      expect(quads[i]!.x).toBeGreaterThan(quads[i - 1]!.x);
      let d = quads[i]!.angle - quads[i - 1]!.angle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      expect(Math.abs(d)).toBeLessThanOrEqual(MAX_BEND);
    }
    for (const q of quads) expect(Math.abs(q.angle)).toBeLessThan(Math.PI / 2);
  });

  it('spreads area labels along the axis and falls back to level text', () => {
    const axis = Float64Array.from([...dir(0, -20), ...dir(0, 0), ...dir(0, 20)]);
    const sea = label(0, { placement: 'area', style: 'sea', text: 'Vern Sea', path: axis, gap: 0 });
    const spread = layoutLabel(atlas, sea, { mode: 'path', station: 0.5 }, flatView())!;
    const span = spread[spread.length - 1]!.x - spread[0]!.x;
    expect(span).toBeGreaterThan(0.4 * 400);
    const steep = label(1, {
      placement: 'area',
      style: 'sea',
      text: 'Vern Sea',
      path: Float64Array.from([...dir(-20, 0), ...dir(0, 0), ...dir(20, 0)]),
      gap: 0,
    });
    expect(layoutLabel(atlas, steep, { mode: 'path', station: 0.5 }, flatView())).toBeNull();
    expect(layoutLabel(atlas, steep, { mode: 'level' }, flatView())).not.toBeNull();
  });

  it('keeps last pass’s labels when the view has not changed', () => {
    const labels = Array.from({ length: 60 }, (_, i) =>
      label(i, { anchor: dir(((i * 7) % 30) - 15, ((i * 11) % 40) - 20), text: `Place ${i}` }),
    );
    const first = placeLabels(atlas, labels, flatView());
    const second = placeLabels(atlas, labels, flatView(), first);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
  });
});

describe('band content tables', () => {
  it('shows oceans and continents at globe scale, peaks and towns only near the ground', () => {
    expect(bandsFor('ocean', 0.5)).toContain('globe');
    expect(bandsFor('continent', 0.5)).toEqual(['globe']);
    expect(bandsFor('peak', 0.4)).toEqual(['region']);
    expect(bandsFor('peak', 0.6)).toEqual(['theater', 'region']);
    expect(bandsFor('town', 0.9)).toEqual(['region']);
    expect(bandsFor('theater', 1)).toEqual(['globe']);
    expect(peakText('Mount Seir', 1036.4)).toBe('Mount Seir 1,036 m');
  });
});

describe('labels on a generated world (acceptance check 2 in Node)', () => {
  const grid = new CubeGrid(128);
  const w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: 7 }, { grid });
  const labels = buildLabels(w.graph, w.campaign.cast, () => 0);

  it('places labels in every band without any overlap', () => {
    const cam = new StrategicCamera(DEFAULT_PLANET_PARAMS.radius);
    const c = w.world.info.mainContinent;
    cam.lat = Math.asin(c[1]);
    cam.lon = Math.atan2(c[0], c[2]);
    for (const altitude of [3000 * KM, 900 * KM, 250 * KM, 100 * KM]) {
      cam.altitude = cam.targetAltitude = altitude;
      cam.update(0);
      const view = perspectiveView({
        eye: cam.eye,
        forward: cam.forward,
        up: cam.up,
        fovY: 45 * DEG,
        width: 1920,
        height: 1080,
        near: cam.near,
        radius: cam.radius,
        exaggeration: 4,
      });
      const band = bandForAltitude(altitude);
      const active = labels.filter((l) => l.bands.includes(band));
      const t0 = performance.now();
      const placed = placeLabels(atlas, active, view);
      const ms = performance.now() - t0;
      expect(placed.size, `labels at ${altitude / KM} km`).toBeGreaterThan(
        band === 'region' ? 3 : 1,
      );
      assertNoOverlap(placed, labels);
      // Part II: the placement pass within a few milliseconds (generous for CI machines).
      expect(ms).toBeLessThan(250);
      if (process.env.LABEL_STATS)
        console.log(
          band,
          altitude / KM,
          active.length,
          placed.size,
          ms.toFixed(1),
          [...placed.keys()]
            .slice(0, 12)
            .map((id) => labels[id]!.text)
            .join(' | '),
        );
    }
  });
});
