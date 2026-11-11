/**
 * Simulated color-vision deficiencies for the strategic acceptance check 4
 * (visual-style Part II): Machado, Oliveira and Fernandes (2009), severity 1.0,
 * applied in linear RGB to an sRGB image.
 */
export const CVD_MATRICES = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
} as const;

export type Deficiency = keyof typeof CVD_MATRICES;
export const DEFICIENCIES = Object.keys(CVD_MATRICES) as Deficiency[];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** The image (RGB bytes) as seen with a deficiency. */
export function simulateCvd(rgb: Uint8Array, kind: Deficiency): Uint8Array {
  const m = CVD_MATRICES[kind];
  const lut = new Float64Array(256).map((_, i) => toLinear(i / 255));
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const r = lut[rgb[i]!]!;
    const g = lut[rgb[i + 1]!]!;
    const b = lut[rgb[i + 2]!]!;
    for (let k = 0; k < 3; k++) {
      const row = m[k]!;
      const v = Math.min(1, Math.max(0, row[0]! * r + row[1]! * g + row[2]! * b));
      out[i + k] = Math.round(toSrgb(v) * 255);
    }
  }
  return out;
}
