import { describe, expect, it } from 'vitest';
import {
  computeTransmittanceLut,
  distanceToTop,
  earthLikeAtmosphere,
  rayHitsGround,
  sampleTransmittanceLut,
  transmittanceRMu,
  transmittanceToTop,
  transmittanceUv,
} from '../src/render/atmosphere/model';
import { PLANET_RADIUS } from '../src/core/units';

const a = earthLikeAtmosphere(PLANET_RADIUS);
const R = a.groundRadius;

describe('atmosphere model', () => {
  it('integrates zenith transmittance to the analytic value', () => {
    // Vertical optical depth: β·H·(1 − e^(−top/H)) per exponential layer, plus the ozone tent.
    const top = a.topRadius - R;
    const ozone = a.ozoneHalfWidth; // area of the tent with unit peak
    const t = transmittanceToTop(a, R, 1, 4000);
    for (let c = 0; c < 3; c++) {
      const depth =
        a.rayleighScattering[c]! *
          a.rayleighScaleHeight *
          (1 - Math.exp(-top / a.rayleighScaleHeight)) +
        a.mieExtinction * a.mieScaleHeight * (1 - Math.exp(-top / a.mieScaleHeight)) +
        a.ozoneAbsorption[c]! * ozone;
      expect(t[c]).toBeCloseTo(Math.exp(-depth), 4);
    }
    // Clear sky at the zenith passes most light; blue least.
    expect(t[0]).toBeGreaterThan(t[1]);
    expect(t[1]).toBeGreaterThan(t[2]);
    expect(t[2]).toBeGreaterThan(0.6);
  });

  it('reddens light near the horizon', () => {
    const zenith = transmittanceToTop(a, R, 1);
    const horizon = transmittanceToTop(a, R, 0.01);
    expect(horizon[2] / horizon[0]).toBeLessThan(zenith[2] / zenith[0]);
    expect(horizon[2]).toBeLessThan(0.1);
  });

  it('finds the ground and the top of the atmosphere', () => {
    expect(distanceToTop(a, R, 1)).toBeCloseTo(a.topRadius - R, 3);
    expect(rayHitsGround(a, R + 1000, -0.5)).toBe(true);
    expect(rayHitsGround(a, R + 1000, 0)).toBe(false);
    expect(rayHitsGround(a, R + 100_000, 0.2)).toBe(false);
  });

  it('maps LUT coordinates to (r, μ) and back', () => {
    for (const [r, mu] of [
      [R, 1],
      [R, 0.05],
      [R + 2000, -0.03],
      [R + 30_000, 0.5],
      [a.topRadius - 10, -0.2],
    ] as const) {
      const [u, v] = transmittanceUv(a, r, mu);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      const [r2, mu2] = transmittanceRMu(a, u, v);
      expect(r2).toBeCloseTo(r, 0);
      expect(mu2).toBeCloseTo(mu, 5);
    }
  });

  it('LUT lookups match direct integration', () => {
    const lut = computeTransmittanceLut(a);
    for (const [r, mu] of [
      [R, 1],
      [R, 0.3],
      [R, 0.05],
      [R + 5000, 0.1],
      [R + 50_000, -0.1],
    ] as const) {
      const direct = transmittanceToTop(a, r, mu, 2000);
      const looked = sampleTransmittanceLut(a, lut, r, mu);
      for (let c = 0; c < 3; c++) expect(Math.abs(looked[c] - direct[c])).toBeLessThan(0.01);
    }
  });
});
