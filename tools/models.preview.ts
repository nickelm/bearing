/**
 * Model previews without a GPU (decision 106): renders every model spec (or MODELS, a
 * comma list of ids) with a small CPU z-buffer rasterizer into one sheet per model,
 * tools/out/model-<id>.png:
 *
 *   top row: three-quarter view, side, top, front, lit by a low sun from the front
 *            left with sky light and the baked ambient occlusion;
 *   bottom row: the same four views as silhouettes, solid black on a pale sky
 *            (Part I acceptance check 6: each type recognizable by outline alone).
 *
 * Shaded views carry ink outlines (decision 107; INK=0 turns them off, INK_PX sets the
 * width). Also prints each model's triangle count against its class budget.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/models.preview.ts
 *   MODELS=alliance-fighter,pact-strike SCHEME=pact-tactical  (scheme override)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { buildModel, withinBudget } from '../src/render/common/models/builder';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { MODEL_BUDGETS } from '../src/render/common/models/spec';
import { draw, view } from './modelRaster';
import type { M3 } from './modelRaster';
import { encodePng } from './png';

const CELL = Number(process.env.CELL ?? 320);
/** Ink outlines (INK=0 turns them off) and their width in pixels. */
const INK = process.env.INK !== '0';
const INK_PX = Number(process.env.INK_PX ?? 1.6);

it('model previews', () => {
  const ids = process.env.MODELS?.split(',').map((s) => s.trim()) ?? Object.keys(MODEL_SPECS);
  const out = join(import.meta.dirname, 'out');
  mkdirSync(out, { recursive: true });
  const views: M3[] = [
    view(-Math.PI * 0.25, 0.45), // three-quarter, from the front left (port), above
    view(Math.PI / 2, 0.0001), // side (from port)
    view(0.0001, Math.PI / 2 - 0.0001), // top
    view(0.0001, 0.0001), // front
  ];
  const opts = { w: CELL, h: CELL, ink: INK ? INK_PX : 0 };
  const lines: string[] = [];
  for (const id of ids) {
    const spec = MODEL_SPECS[id];
    if (!spec) throw new Error(`no model "${id}"`);
    const t0 = performance.now();
    const m = buildModel(spec, { scheme: process.env.SCHEME });
    const ms = performance.now() - t0;
    const width = CELL * 4;
    const img = new Uint8Array(width * CELL * 2 * 3);
    views.forEach((v, i) => {
      draw(img, width, i * CELL, 0, m, v, false, opts);
      draw(img, width, i * CELL, CELL, m, v, true, opts);
    });
    writeFileSync(join(out, `model-${id}.png`), encodePng(width, CELL * 2, img));
    const [lo, hi] = MODEL_BUDGETS[m.class];
    lines.push(
      `${id.padEnd(22)} ${m.name.padEnd(22)} ${m.class.padEnd(9)} ${String(m.triangles).padStart(5)} tris ` +
        `(budget ${lo}–${hi}${withinBudget(m) ? '' : ' OUT'})  ${ms.toFixed(0)} ms`,
    );
  }
  writeFileSync(join(out, 'models.txt'), lines.join('\n') + '\n');
  console.info(lines.join('\n'));
});
