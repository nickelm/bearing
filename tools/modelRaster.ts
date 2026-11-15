/**
 * The CPU rasterizer of the model previews (decision 106), shared by
 * tools/models.preview.ts and tools/trees.preview.ts: flat-shaded triangles with
 * a z-buffer, a low sun from the front left and sky light, optional ink outlines.
 */
import type { BuiltModel, RotorDisc } from '../src/render/common/models/builder';

export const SKY = [0xc9, 0xd8, 0xe3];

export interface RasterOptions {
  /** Cell size in pixels. */
  w: number;
  h: number;
  /** Ink outline width in pixels (0: none). */
  ink: number;
  /** Framing: the point at the cell's center and the world size that fills 90% of it. */
  center?: [number, number, number];
  size?: number;
  /** Sun direction (toward the sun), unnormalized. */
  sun?: [number, number, number];
  /**
   * Translucent triangles drawn over the model, depth-tested but not written, lit from
   * either side and blended by their per-vertex alpha (rotor discs, decision 149).
   */
  translucent?: readonly RotorDisc[];
}

export type M3 = [number, number, number, number, number, number, number, number, number];

/** View rotation (rows: screen right, screen up, toward viewer) from yaw and pitch (rad). */
export function view(yaw: number, pitch: number): M3 {
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

export const toSrgb = (c: number) => {
  const x = Math.max(0, Math.min(1, c));
  return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
};

/** Draws one view of a model into the sheet at (ox, oy). */
export function draw(
  img: Uint8Array,
  width: number,
  ox: number,
  oy: number,
  m: BuiltModel,
  rot: M3,
  silhouette: boolean,
  o: RasterOptions,
): void {
  const CW = o.w;
  const CH = o.h;
  const INK = o.ink > 0;
  const INK_PX = o.ink;
  const zbuf = new Float32Array(CW * CH).fill(-Infinity);
  for (let y = 0; y < CH; y++)
    for (let x = 0; x < CW; x++) img.set(SKY, ((oy + y) * width + ox + x) * 3);
  const c = o.center ?? m.bounds.min.map((v, i) => (v + m.bounds.max[i]!) / 2);
  const size = o.size ?? Math.hypot(...m.bounds.max.map((v, i) => v - m.bounds.min[i]!));
  const s = (Math.min(CW, CH) * 0.9) / size;
  // Ink outlines (decision 107): the inflated back faces first, in ink.
  let inflate = 0;
  const proj = (i: number): [number, number, number] => {
    const on = m.outlineNormal;
    const p = [0, 1, 2].map((k) => m.position[i + k]! - c[k]! + on[i + k]! * inflate);
    const vx = rot[0] * p[0]! + rot[1] * p[1]! + rot[2] * p[2]!;
    const vy = rot[3] * p[0]! + rot[4] * p[1]! + rot[5] * p[2]!;
    const vz = rot[6] * p[0]! + rot[7] * p[1]! + rot[8] * p[2]!;
    return [CW / 2 + vx * s, CH / 2 + vy * s, vz];
  };
  // Low sun from the front left, above; sky light from above.
  const sun = o.sun ?? [0.55, 0.62, -0.56];
  const sl = Math.hypot(...sun);
  for (const hull of INK && !silhouette ? [true, false] : [false]) {
    inflate = hull ? INK_PX / s : 0;
    for (let t = 0; t < m.triangles; t++) {
      const nx = m.normal[t * 9]!;
      const ny = m.normal[t * 9 + 1]!;
      const nz = m.normal[t * 9 + 2]!;
      if (hull && rot[6] * nx + rot[7] * ny + rot[8] * nz > 0) continue;
      const [a, b, cc] = [proj(t * 9), proj(t * 9 + 3), proj(t * 9 + 6)];
      const lambert = Math.max(0, (nx * sun[0]! + ny * sun[1]! + nz * sun[2]!) / sl);
      const sky = 0.5 + 0.25 * ny;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], cc[0])));
      const x1 = Math.min(CW - 1, Math.ceil(Math.max(a[0], b[0], cc[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], cc[1])));
      const y1 = Math.min(CH - 1, Math.ceil(Math.max(a[1], b[1], cc[1])));
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
          const k = y * CW + x;
          if (z <= zbuf[k]!) continue;
          zbuf[k] = z;
          const o = ((oy + y) * width + ox + x) * 3;
          if (silhouette || hull) {
            img[o] = img[o + 1] = img[o + 2] = hull ? 0x1a : 0;
            continue;
          }
          const ao = w0 * m.ao[t * 3]! + w1 * m.ao[t * 3 + 1]! + w2 * m.ao[t * 3 + 2]!;
          const light = (sky * ao + 0.9 * lambert * (0.6 + 0.4 * ao)) * 1.05;
          for (let ch = 0; ch < 3; ch++) img[o + ch] = toSrgb(m.color[t * 9 + ch]! * light);
        }
      }
    }
  }
  for (const d of o.translucent ?? []) {
    const at = (i: number): [number, number, number] => {
      const p = [0, 1, 2].map((k) => d.position[i + k]! - c[k]!);
      const vx = rot[0] * p[0]! + rot[1] * p[1]! + rot[2] * p[2]!;
      const vy = rot[3] * p[0]! + rot[4] * p[1]! + rot[5] * p[2]!;
      const vz = rot[6] * p[0]! + rot[7] * p[1]! + rot[8] * p[2]!;
      return [CW / 2 + vx * s, CH / 2 + vy * s, vz];
    };
    for (let t = 0; t < d.triangles; t++) {
      let [nx, ny, nz] = [d.normal[t * 9]!, d.normal[t * 9 + 1]!, d.normal[t * 9 + 2]!];
      // Double-sided: the face toward the viewer.
      if (rot[6] * nx + rot[7] * ny + rot[8] * nz < 0) [nx, ny, nz] = [-nx, -ny, -nz];
      const lambert = Math.max(0, (nx * sun[0]! + ny * sun[1]! + nz * sun[2]!) / sl);
      const light = (0.5 + 0.25 * ny + 0.9 * lambert) * 1.05;
      const alpha = d.alpha[t * 3]!;
      const [a, b, cc] = [at(t * 9), at(t * 9 + 3), at(t * 9 + 6)];
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], cc[0])));
      const x1 = Math.min(CW - 1, Math.ceil(Math.max(a[0], b[0], cc[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], cc[1])));
      const y1 = Math.min(CH - 1, Math.ceil(Math.max(a[1], b[1], cc[1])));
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
          if (z <= zbuf[y * CW + x]!) continue;
          const o2 = ((oy + y) * width + ox + x) * 3;
          for (let ch = 0; ch < 3; ch++) {
            const src = silhouette ? 0 : toSrgb(d.color[t * 9 + ch]! * light);
            img[o2 + ch] = Math.round(img[o2 + ch]! * (1 - alpha) + src * alpha);
          }
        }
      }
    }
  }
}
