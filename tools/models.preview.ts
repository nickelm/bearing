/**
 * Model previews without a GPU (decision 106): renders every model spec (or MODELS, a
 * comma list of ids) with a small CPU z-buffer rasterizer into one sheet per model,
 * tools/out/model-<id>.png:
 *
 *   top row: three-quarter view, side, top, front, lit by a low sun from the front
 *            left with sky light and the baked ambient occlusion;
 *   bottom row: the same four views as silhouettes, solid black on a pale sky
 *            (Part I acceptance check 6: each type recognizable by outline alone);
 *   helicopters add two rows with the rotors spinning: hubs and translucent discs
 *            instead of blades (decision 149), shaded and as silhouettes.
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
import { buildModel, buildRotors, withinBudget } from '../src/render/common/models/builder';
import type { BuiltModel } from '../src/render/common/models/builder';
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
    const rows = spec.rotors ? 4 : 2;
    const img = new Uint8Array(width * CELL * rows * 3);
    views.forEach((v, i) => {
      draw(img, width, i * CELL, 0, m, v, false, opts);
      draw(img, width, i * CELL, CELL, m, v, true, opts);
    });
    let discs = '';
    if (spec.rotors) {
      // Spinning: the body and hubs with the discs over them, framed as the static model.
      const rotors = buildRotors(spec, { scheme: process.env.SCHEME });
      const body = buildModel({ ...spec, rotors: undefined }, { scheme: process.env.SCHEME });
      const spin = concat([body, ...rotors.map((r) => r.hubModel)]);
      const framing = {
        center: m.bounds.min.map((v, k) => (v + m.bounds.max[k]!) / 2) as [number, number, number],
        size: Math.hypot(...m.bounds.max.map((v, k) => v - m.bounds.min[k]!)),
        translucent: rotors.map((r) => r.disc),
      };
      views.forEach((v, i) => {
        draw(img, width, i * CELL, 2 * CELL, spin, v, false, { ...opts, ...framing });
        draw(img, width, i * CELL, 3 * CELL, spin, v, true, { ...opts, ...framing });
      });
      discs = ` + discs ${rotors.map((r) => r.disc.triangles).join(' + ')}`;
    }
    writeFileSync(join(out, `model-${id}.png`), encodePng(width, CELL * rows, img));
    const [lo, hi] = MODEL_BUDGETS[m.class];
    lines.push(
      `${id.padEnd(22)} ${m.name.padEnd(22)} ${m.class.padEnd(9)} ${String(m.triangles).padStart(5)} tris ` +
        `(budget ${lo}–${hi}${withinBudget(m) ? '' : ' OUT'})${discs}  ${ms.toFixed(0)} ms`,
    );
  }
  writeFileSync(join(out, 'models.txt'), lines.join('\n') + '\n');
  console.info(lines.join('\n'));
});

/** Joins built models into one triangle list for drawing (the fields the rasterizer reads). */
function concat(models: BuiltModel[]): BuiltModel {
  const join = <T extends Float32Array | Uint16Array>(
    k: keyof BuiltModel,
    make: (n: number) => T,
  ) => {
    const parts = models.map((x) => x[k] as T);
    const out = make(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const f = (n: number) => new Float32Array(n);
  return {
    ...models[0]!,
    triangles: models.reduce((n, x) => n + x.triangles, 0),
    position: join('position', f),
    normal: join('normal', f),
    color: join('color', f),
    ao: join('ao', f),
    outlineNormal: join('outlineNormal', f),
    group: join('group', (n) => new Uint16Array(n)),
  };
}
