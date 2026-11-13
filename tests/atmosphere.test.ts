import { describe, expect, it } from 'vitest';
import {
  aerialHazeGain,
  CLEAR_AIR_HAZE,
  computeAtmosphereLuts,
  computeMultiScatteringLut,
  computeSkyIrradianceLut,
  computeTransmittanceLut,
  IRRADIANCE_MU_MIN,
  IRRADIANCE_SIZE,
  irradianceU,
  distanceToTop,
  earthLikeAtmosphere,
  extinctionAt,
  gradeSky,
  rayHitsGround,
  sampleMultiScatteringLut,
  sampleTransmittanceLut,
  SKY_VIEW_HEIGHT,
  skyRadiance,
  skyScattering,
  skyViewAngles,
  skyViewHorizon,
  skyViewUv,
  hgPhase,
  transmittanceRMu,
  transmittanceToTop,
  transmittanceUv,
} from '../src/render/sim/atmosphere/model';
import type { AtmosphereLuts, Rgb } from '../src/render/sim/atmosphere/model';
import { DEG, EARTH_RADIUS, PLANET_RADIUS } from '../src/core/units';

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

describe('sky irradiance', () => {
  const irr = computeSkyIrradianceLut(a, computeAtmosphereLuts(a));
  const at = (muS: number) => {
    const k = Math.min(
      IRRADIANCE_SIZE - 1,
      Math.floor(((muS - IRRADIANCE_MU_MIN) / (1 - IRRADIANCE_MU_MIN)) * IRRADIANCE_SIZE),
    );
    return [irr[k * 4]!, irr[k * 4 + 1]!, irr[k * 4 + 2]!];
  };

  it('is blue, grows with sun elevation and vanishes after twilight', () => {
    const noon = at(0.95);
    const low = at(0.2);
    const night = at(-0.28);
    expect(noon[2]).toBeGreaterThan(noon[0]);
    expect(noon[2]).toBeGreaterThan(low[2]);
    expect(night[2]).toBeLessThan(noon[2] * 0.01);
    // Clear-sky diffuse light is a modest fraction of direct sunlight (about 10–20%).
    const lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    expect(lum(noon) * Math.PI).toBeGreaterThan(0.04);
    expect(lum(noon) * Math.PI).toBeLessThan(0.3);
  });

  it('maps sun-elevation cosines onto texel centers', () => {
    expect(irradianceU(IRRADIANCE_MU_MIN)).toBeCloseTo(0.5 / IRRADIANCE_SIZE, 9);
    expect(irradianceU(1)).toBeCloseTo(1 - 0.5 / IRRADIANCE_SIZE, 9);
  });
});

/** A unit direction at an elevation and an azimuth from the sun's (degrees), in the reference's frame. */
const toward = (elevation: number, azimuth: number): [number, number, number] => [
  Math.cos(elevation * DEG) * Math.cos(azimuth * DEG),
  Math.sin(elevation * DEG),
  Math.cos(elevation * DEG) * Math.sin(azimuth * DEG),
];
const lum = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('multiple scattering', () => {
  const luts = computeAtmosphereLuts(a);
  const single: AtmosphereLuts = {
    transmittance: luts.transmittance,
    multiScattering: new Float32Array(luts.multiScattering.length),
  };

  it('is positive, strongest under a high sun, and fades through twilight', () => {
    const psi = (h: number, mu: number) =>
      lum(sampleMultiScatteringLut(a, luts.multiScattering, R + h, mu));
    expect(psi(10, 1)).toBeGreaterThan(psi(10, 0.2));
    expect(psi(10, 0.2)).toBeGreaterThan(psi(10, 0));
    expect(psi(10, 0)).toBeGreaterThan(psi(10, -0.1));
    expect(psi(10, -0.1)).toBeGreaterThan(0);
    // 17° below the horizon there is still a trace of it, far under a percent of noon's.
    expect(psi(10, -0.3)).toBeGreaterThan(0);
    expect(psi(10, -0.3)).toBeLessThan(0.01 * psi(10, 1));
    // The air thins out upward.
    expect(psi(60_000, 0.5)).toBeLessThan(psi(10, 0.5));
  });

  it('is converged in directions and steps where the simulation view flies', () => {
    // Within 10% of a LUT with eight times the samples (measured against 128 × 12
    // directions of 48 steps, the default is within 6% and this finer one within 4%;
    // the largest differences are in twilight, where the light comes from a thin band
    // of directions above the planet's shadow).
    const fine = computeMultiScatteringLut(a, luts.transmittance, 64, 6, 24);
    for (const h of [10, 2000, 8000, 20_000]) {
      for (const mu of [0.9, 0.3, 0.05, -0.05, -0.15]) {
        const coarse = sampleMultiScatteringLut(a, luts.multiScattering, R + h, mu);
        const exact = sampleMultiScatteringLut(a, fine, R + h, mu);
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(coarse[c]! - exact[c]!) / exact[c]!).toBeLessThan(0.1);
        }
      }
    }
  });

  it('brightens the sky by a modest share, more by day than at dusk', () => {
    const r = R + 50;
    const gain = (sunElevation: number, view: [number, number, number]) => {
      const sun = toward(sunElevation, 0);
      return (
        lum(skyRadiance(a, luts, r, view, sun, 200)) /
        lum(skyRadiance(a, single, r, view, sun, 200))
      );
    };
    const noon = gain(60, toward(90, 0));
    expect(noon).toBeGreaterThan(1.25);
    expect(noon).toBeLessThan(2);
    const dusk = gain(0, toward(90, 0));
    expect(dusk).toBeGreaterThan(1.1);
    expect(dusk).toBeLessThan(noon);
    // Deep in twilight single scattering leaves the zenith; multiple scattering holds it.
    expect(gain(-18, toward(90, 0))).toBeGreaterThan(2);
  });
});

describe('sky reference', () => {
  const luts = computeAtmosphereLuts(a);
  const r = R + 50;

  it('is blue overhead by day and warm toward a setting sun', () => {
    const zenith = skyRadiance(a, luts, r, toward(90, 0), toward(50, 0));
    expect(zenith[2]).toBeGreaterThan(2 * zenith[0]);
    const glow = skyRadiance(a, luts, r, toward(2, 0), toward(0, 0));
    expect(glow[0]).toBeGreaterThan(2 * glow[2]);
    // The horizon is brighter than the zenith.
    expect(lum(skyRadiance(a, luts, r, toward(2, 90), toward(50, 0)))).toBeGreaterThan(
      2 * lum(zenith),
    );
  });

  it("has converged at the sky-view LUT's 48 samples", () => {
    for (const sunElevation of [40, 2, -6]) {
      for (const view of [toward(90, 0), toward(20, 0), toward(3, 0), toward(3, 180)]) {
        const coarse = skyRadiance(a, luts, r, view, toward(sunElevation, 0), 48);
        const exact = skyRadiance(a, luts, r, view, toward(sunElevation, 0), 1500, 1);
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(coarse[c]! - exact[c]!) / exact[c]!).toBeLessThan(0.015);
        }
      }
    }
  });

  it('splits off the Mie phase function exactly', () => {
    const view = toward(8, 25);
    const sun = toward(6, 0);
    const parts = skyScattering(a, luts, r, view, sun, 96);
    const whole = skyRadiance(a, luts, r, view, sun, 96);
    const phase = hgPhase(view[0] * sun[0] + view[1] * sun[1] + view[2] * sun[2], a.mieG);
    for (let c = 0; c < 3; c++) {
      expect(whole[c]).toBeCloseTo(parts.base[c]! + parts.mie[c]! * phase, 12);
    }
    // Next to the sun the forward peak carries most of the light.
    const near = toward(6.5, 1);
    const beside = skyScattering(a, luts, r, near, sun, 96);
    const peak = hgPhase(near[0] * sun[0] + near[1] * sun[1] + near[2] * sun[2], a.mieG);
    expect(beside.mie[0]! * peak).toBeGreaterThan(beside.base[0]!);
  });

  it("shows the planet's shadow and the pink band above it opposite a sun 3° down", () => {
    const sun = toward(-3, 0);
    const shadow = skyRadiance(a, luts, r, toward(1, 180), sun, 200);
    const band = skyRadiance(a, luts, r, toward(4.5, 180), sun, 200);
    // In the shadow only blue, multiply scattered light; above it reddened sunlight.
    expect(shadow[2]).toBeGreaterThan(shadow[0]);
    expect(band[0]).toBeGreaterThan(band[2]);
    expect(band[0]).toBeGreaterThan(3 * shadow[0]);
  });

  it('fades through twilight without a step, the zenith faster than the glow', () => {
    const zenith = (e: number) => lum(skyRadiance(a, luts, r, toward(90, 0), toward(e, 0)));
    const glow = (e: number) => lum(skyRadiance(a, luts, r, toward(3, 0), toward(e, 0)));
    let last = zenith(6);
    for (let e = 5.5; e >= -18; e -= 0.5) {
      const now = zenith(e);
      expect(now).toBeLessThan(last);
      // Half a degree never takes more than a third of the light: no step at sunset.
      expect(now).toBeGreaterThan(0.66 * last);
      last = now;
    }
    // On the small planet the shadow rises slowly: 12° down the zenith still has a
    // thirtieth of its light at sunset, and the glow toward the sun a twentieth.
    expect(zenith(-12) / zenith(0)).toBeGreaterThan(0.02);
    expect(zenith(-12) / zenith(0)).toBeLessThan(0.08);
    expect(glow(-12) / glow(0)).toBeGreaterThan(0.03);
    expect(zenith(-18) / zenith(0)).toBeLessThan(0.005);
  });
});

describe('sky-view LUT mapping', () => {
  it('maps directions to coordinates and back', () => {
    for (const altitude of [1, 300, 12_000, 45_000]) {
      const r = R + altitude;
      const { horizon, below } = skyViewHorizon(a, r);
      expect(horizon + below).toBeCloseTo(Math.PI, 12);
      // The horizon dips below the horizontal as the camera climbs.
      expect(horizon).toBeGreaterThanOrEqual(Math.PI / 2);
      for (const zenith of [0.01, 0.7, horizon - 0.05, horizon - 1e-4, horizon + 1e-4, 3]) {
        for (const azimuth of [-3, -0.4, 0, 1.1, 3.1]) {
          const [u, v] = skyViewUv(a, r, Math.cos(zenith), azimuth);
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThan(1);
          const back = skyViewAngles(a, r, u, v);
          expect(back.zenith).toBeCloseTo(zenith, 6);
          expect(back.azimuth).toBeCloseTo(azimuth, 9);
        }
      }
    }
  });

  it('puts the horizon between the two middle rows and crowds the rows around it', () => {
    const r = R + 100;
    const { horizon } = skyViewHorizon(a, r);
    expect(skyViewUv(a, r, Math.cos(horizon), 0)[1]).toBeCloseTo(0.5, 9);
    const rowAngle = (row: number) =>
      skyViewAngles(a, r, 0.5, (row + 0.5) / SKY_VIEW_HEIGHT).zenith;
    const middle = SKY_VIEW_HEIGHT / 2;
    expect(rowAngle(middle - 1)).toBeLessThan(horizon);
    expect(rowAngle(middle)).toBeGreaterThan(horizon);
    // A row next to the horizon spans a few hundredths of a degree, one at the zenith degrees.
    expect((rowAngle(middle - 1) - rowAngle(middle - 2)) / DEG).toBeLessThan(0.1);
    expect((rowAngle(1) - rowAngle(0)) / DEG).toBeGreaterThan(2);
  });
});

describe('clear-air haze and the sky grade', () => {
  const a = earthLikeAtmosphere(PLANET_RADIUS);
  /** Transmittance in blue along a level path of the given length at an altitude. */
  const level = (distance: number, altitude: number) =>
    Math.exp(-extinctionAt(a, altitude, [0, 0, 0])[2] * distance);

  it('keeps the haze thin for 15 km, has most of it by 60 km and all of it at the horizon', () => {
    // At a flight altitude of 3 km, looking level.
    expect(aerialHazeGain(level(5_000, 3000))).toBe(CLEAR_AIR_HAZE);
    expect(aerialHazeGain(level(15_000, 3000))).toBeLessThan(CLEAR_AIR_HAZE + 0.02);
    expect(aerialHazeGain(level(20_000, 3000))).toBeLessThan(0.4);
    expect(aerialHazeGain(level(40_000, 3000))).toBeGreaterThan(0.55);
    expect(aerialHazeGain(level(60_000, 3000))).toBeGreaterThan(0.8);
    expect(aerialHazeGain(level(110_000, 3000))).toBe(1);
    // Straight down from the envelope's ceiling the ground keeps its palette.
    const down = sampleTransmittanceLut(
      a,
      computeAtmosphereLuts(a).transmittance,
      PLANET_RADIUS + 1,
      1,
    );
    expect(aerialHazeGain(down[2])).toBe(CLEAR_AIR_HAZE);
    // The uniform's other values: all of the light everywhere, and humid air above that.
    expect(aerialHazeGain(0.9, 1)).toBe(1);
    expect(aerialHazeGain(0.9, 2)).toBe(2);
    expect(aerialHazeGain(0.05, 2)).toBe(1);
  });

  it('grades about the luminance, linearly, and never below zero', () => {
    const c: Rgb = [1.83, 0.8, 0.26];
    expect(gradeSky(c, 1)).toEqual(c);
    const g = gradeSky(c, 1.2);
    // More orange: red up, blue down, the luminance where it was.
    expect(g[0]).toBeGreaterThan(c[0]);
    expect(g[2]).toBeLessThan(c[2]);
    expect(lum(g)).toBeCloseTo(lum(c), 9);
    // Linear while no channel clips: parts of a sum can be graded one by one.
    const d: Rgb = [0.2, 0.25, 0.4];
    const sum = gradeSky([c[0] + d[0], c[1] + d[1], c[2] + d[2]], 1.2);
    const parts = [gradeSky(c, 1.2), gradeSky(d, 1.2)];
    for (let k = 0; k < 3; k++) expect(sum[k]).toBeCloseTo(parts[0]![k]! + parts[1]![k]!, 9);
    for (const x of gradeSky(c, 3)) expect(x).toBeGreaterThanOrEqual(0);
    expect(gradeSky(c, 3)[2]).toBe(0);
  });
});

describe('ozone on a small planet', () => {
  it("is Earth's on Earth and scaled by the square root of the radius ratio elsewhere", () => {
    const earth = earthLikeAtmosphere(EARTH_RADIUS);
    expect(earth.ozoneAbsorption[1]).toBeCloseTo(1.881e-6, 12);
    const scale = a.ozoneAbsorption[1] / earth.ozoneAbsorption[1];
    expect(scale).toBeCloseTo(Math.sqrt(EARTH_RADIUS / PLANET_RADIUS), 9);
    // A grazing path through the layer (10 to 40 km) then has Earth's ozone depth.
    const chord = (radius: number) =>
      2 * (Math.sqrt(2 * radius * 40_000) - Math.sqrt(2 * radius * 10_000));
    const depth = a.ozoneAbsorption[1] * chord(PLANET_RADIUS);
    const earthDepth = earth.ozoneAbsorption[1] * chord(EARTH_RADIUS);
    expect(depth / earthDepth).toBeCloseTo(1, 6);
  });
});
