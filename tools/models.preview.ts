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
 * Also prints each model's triangle count against its class budget.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/models.preview.ts
 *   MODELS=alliance-fighter,pact-strike SCHEME=pact-tactical  (scheme override)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { buildModel, withinBudget } from '../src/render/common/models/builder';
import type { BuiltModel } from '../src/render/common/models/builder';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { MODEL_BUDGETS } from '../src/render/common/models/spec';
import { encodePng } from './png';

const CELL = Number(process.env.CELL ?? 320);
const SKY = [0xc9, 0xd8, 0xe3];

type M3 = [number, number, number, number, number, number, number, number, number];

/** View rotation (rows: screen right, screen up, toward viewer) from yaw and pitch (rad). */
function view(yaw: number, pitch: number): M3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Camera looks along d (from the eye toward the model).
  const d = [-cp * cy, -sp, -cp * sy];
  const right = [-d[2]!, 0, d[0]!];
  const rl = Math.hypot(right[0]!, right[2]!) || 1;
  const r = [right[0]! / rl, 0, right[2]! / rl];
  const up = [
    r[1]! * d[2]! - r[2]! * d[1]!,
    r[2]! * d[0]! - r[0]! * d[2]!,
    r[0]! * d[1]! - r[1]! * d[0]!,
  ];
  return [r[0]!, r[1]!, r[2]!, -up[0]!, -up[1]!, -up[2]!, -d[0]!, -d[1]!, -d[2]!];
}

const toSrgb = (c: number) => {
  const x = Math.max(0, Math.min(1, c));
  return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
};

/** Draws one view of a model into the sheet at (ox, oy). */
function draw(
  img: Uint8Array,
  width: number,
  ox: number,
  oy: number,
  m: BuiltModel,
  rot: M3,
  silhouette: boolean,
): void {
  const zbuf = new Float32Array(CELL * CELL).fill(-Infinity);
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) img.set(SKY, ((oy + y) * width + ox + x) * 3);
  const c = m.bounds.min.map((v, i) => (v + m.bounds.max[i]!) / 2);
  const size = Math.hypot(...m.bounds.max.map((v, i) => v - m.bounds.min[i]!));
  const s = (CELL * 0.9) / size;
  const proj = (i: number): [number, number, number] => {
    const p = [m.position[i]! - c[0]!, m.position[i + 1]! - c[1]!, m.position[i + 2]! - c[2]!];
    const vx = rot[0] * p[0]! + rot[1] * p[1]! + rot[2] * p[2]!;
    const vy = rot[3] * p[0]! + rot[4] * p[1]! + rot[5] * p[2]!;
    const vz = rot[6] * p[0]! + rot[7] * p[1]! + rot[8] * p[2]!;
    return [CELL / 2 + vx * s, CELL / 2 + vy * s, vz];
  };
  // Low sun from the front left, above; sky light from above.
  const sun = [0.55, 0.62, -0.56];
  const sl = Math.hypot(...sun);
  for (let t = 0; t < m.triangles; t++) {
    const [a, b, cc] = [proj(t * 9), proj(t * 9 + 3), proj(t * 9 + 6)];
    const nx = m.normal[t * 9]!;
    const ny = m.normal[t * 9 + 1]!;
    const nz = m.normal[t * 9 + 2]!;
    const lambert = Math.max(0, (nx * sun[0]! + ny * sun[1]! + nz * sun[2]!) / sl);
    const sky = 0.5 + 0.25 * ny;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], cc[0])));
    const x1 = Math.min(CELL - 1, Math.ceil(Math.max(a[0], b[0], cc[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], cc[1])));
    const y1 = Math.min(CELL - 1, Math.ceil(Math.max(a[1], b[1], cc[1])));
    const area = (b[0] - a[0]) * (cc[1] - a[1]) - (cc[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((b[0] - px) * (cc[1] - py) - (cc[0] - px) * (b[1] - py)) / area;
        const w1 = ((cc[0] - px) * (a[1] - py) - (a[0] - px) * (cc[1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * cc[2];
        const k = y * CELL + x;
        if (z <= zbuf[k]!) continue;
        zbuf[k] = z;
        const o = ((oy + y) * width + ox + x) * 3;
        if (silhouette) {
          img[o] = img[o + 1] = img[o + 2] = 0;
          continue;
        }
        const ao = w0 * m.ao[t * 3]! + w1 * m.ao[t * 3 + 1]! + w2 * m.ao[t * 3 + 2]!;
        const light = (sky * ao + 0.9 * lambert * (0.6 + 0.4 * ao)) * 1.05;
        for (let ch = 0; ch < 3; ch++) img[o + ch] = toSrgb(m.color[t * 9 + ch]! * light);
      }
    }
  }
}

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
      draw(img, width, i * CELL, 0, m, v, false);
      draw(img, width, i * CELL, CELL, m, v, true);
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
