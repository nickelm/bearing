import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generateShapeNoise, generateDetailNoise, SHAPE_SIZE } from '../src/render/sim/clouds/noiseVolume';
import { encodePng } from './png';
it('bench', () => {
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    const s = generateShapeNoise();
    const t1 = performance.now();
    const d = generateDetailNoise();
    const t2 = performance.now();
    console.log('shape', (t1 - t0).toFixed(0), 'detail', (t2 - t1).toFixed(0), s.length, d.length);
    if (k === 2) {
      const n = SHAPE_SIZE;
      // histogram of R
      const hist = new Array(10).fill(0);
      for (let i = 0; i < n * n * n; i++) hist[Math.min(9, Math.floor(s[i * 4]! / 25.6))]++;
      console.log(hist.map((h) => (h / (n * n * n)).toFixed(3)).join(' '));
      // slices: 4 channels side by side, tiled 2x
      const Z = 2; const W = n * 2 * 4 * Z, H = n * 2 * Z;
      const rgb = new Uint8Array(W * H * 3);
      for (let c = 0; c < 4; c++) for (let y = 0; y < H; y++) for (let x = 0; x < n * 2 * Z; x++) {
        const v = s[(((10 * n) + ((y / Z | 0) % n)) * n + ((x / Z | 0) % n)) * 4 + c]!;
        const o = (y * W + c * n * 2 * Z + x) * 3;
        rgb[o] = rgb[o + 1] = rgb[o + 2] = v;
      }
      writeFileSync('/tmp/claude-0/-home-user-bearing/36e5f62a-3438-527d-8a9b-7cbbce85524d/scratchpad/volumetrics/shape-slices.png', encodePng(W, H, rgb));
      // thresholded R at 0.6 
      const rgb2 = new Uint8Array(W * H * 3);
      for (let c = 0; c < 4; c++) for (let y = 0; y < H; y++) for (let x = 0; x < n * 2 * Z; x++) {
        const thr = [0.6, 0.5, 0.4, 0.6][c]!;
        const v = s[(((x / Z | 0) % n) * n * n * (c === 3 ? 1 : 0) + ((10 * n) * (c === 3 ? 0 : 1) + ((y / Z | 0) % n)) * n + ((x / Z | 0) % n) * (c === 3 ? 0 : 1) + (c === 3 ? 20 : 0)) * 4]! / 255;
        const dn = Math.max(0, (v - thr) / (1 - thr));
        const o = (y * W + c * n * 2 * Z + x) * 3;
        rgb2[o] = rgb2[o + 1] = rgb2[o + 2] = Math.round(255 * Math.min(1, dn * 2));
      }
      writeFileSync('/tmp/claude-0/-home-user-bearing/36e5f62a-3438-527d-8a9b-7cbbce85524d/scratchpad/volumetrics/shape-thresh.png', encodePng(W, H, rgb2));
    }
  }
});
