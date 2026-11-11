import { describe, expect, it } from 'vitest';
import { VIGNETTE, vignetteFactor } from '../src/render/strategic/mapFinish';

describe('map finish', () => {
  it('leaves the center untouched and darkens the corners lightly', () => {
    expect(vignetteFactor(0.5, 0.5)).toBe(1);
    expect(vignetteFactor(0.6, 0.45)).toBe(1);
    expect(vignetteFactor(0, 0)).toBeCloseTo(1 - VIGNETTE, 12);
    expect(vignetteFactor(1, 1)).toBeCloseTo(1 - VIGNETTE, 12);
    // Edges midway are between.
    const edge = vignetteFactor(0, 0.5);
    expect(edge).toBeLessThan(1);
    expect(edge).toBeGreaterThan(1 - VIGNETTE);
  });
});
