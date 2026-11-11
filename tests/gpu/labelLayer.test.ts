/**
 * Draws map labels (decision 98) with three's WebGPURenderer on Dawn: the SDF
 * shader compiles and a placed label marks the pixels around its anchor.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { AgXToneMapping, Color, PerspectiveCamera, Scene } from 'three/webgpu';
import { drawOverlay } from '../../src/render/strategic/labels/labelLayer';
import { buildFontAtlas, FONT_IDS } from '../../src/render/strategic/labels/fontAtlas';
import type { FontId } from '../../src/render/strategic/labels/fontAtlas';
import { LABEL_FONT_FILES } from '../../src/render/strategic/labels/fontFiles';
import { LabelLayer } from '../../src/render/strategic/labels/labelLayer';
import type { LabelView } from '../../src/render/strategic/labels/labelPlacement';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('LabelLayer on Dawn', () => {
  it('draws a placed label around its anchor', async () => {
    const req = createRequire(import.meta.url);
    const buffers = Object.fromEntries(
      FONT_IDS.map((id) => {
        const b = readFileSync(req.resolve(LABEL_FONT_FILES[id]));
        return [id, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)];
      }),
    ) as Record<FontId, ArrayBuffer>;
    const head = await headlessRenderer(gpu!.device, 256, 128);
    const scene = new Scene();
    scene.background = new Color(0x808080);
    const layer = new LabelLayer();
    layer.setFonts(buildFontAtlas(buffers));
    layer.setLabels([
      {
        id: 0,
        text: 'KESSAR',
        style: 'city',
        importance: 1,
        placement: 'point',
        anchor: [0, 0, 1],
        height: 0,
        path: null,
        gap: 0,
        bands: ['region'],
      },
    ]);
    const overlay = new Scene();
    overlay.add(layer.group);
    const view: LabelView = { width: 256, height: 128, project: () => [60, 64] };
    layer.update(view, 'region', () => 1, 0, true);
    expect(layer.placedCount).toBe(1);
    // As in the app: the map under AgX, then the labels without a tone curve.
    head.renderer.toneMapping = AgXToneMapping;
    const camera = new PerspectiveCamera();
    head.renderer.render(scene, camera);
    drawOverlay(head.renderer, overlay, camera);
    const rgb = await head.readRgb();
    let dark = 0;
    let light = 0;
    let darkRight = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 256; x++) {
        const v = rgb[(y * 256 + x) * 3]!;
        if (v < 120) {
          dark++;
          if (x > 60) darkRight++;
        }
        if (v > 200) light++;
      }
    }
    // Dark letters with a light halo, right of the anchor. The readback encodes sRGB once
    // (decision 100), so #22252A ink reads its own red, 0x22 = 34, when no tone curve
    // touches it; under AgX it would read lighter.
    expect(Math.abs(Math.min(...rgb) - 0x22)).toBeLessThan(8);
    expect(dark).toBeGreaterThan(40);
    expect(light).toBeGreaterThan(80);
    expect(darkRight).toBe(dark);
    head.dispose();
  });
});
