import { describe, expect, it } from 'vitest';
import { KM } from '../src/core/units';
import {
  BAND_FADE_TIME,
  BAND_HYSTERESIS,
  bandForAltitude,
  GLOBE_BAND_FLOOR,
  nextBand,
  THEATER_BAND_FLOOR,
  ZOOM_BANDS,
  ZoomBands,
} from '../src/render/strategic/zoomBands';
import type { ZoomBand } from '../src/render/strategic/zoomBands';

describe('zoom band edges', () => {
  it('follows Part II: globe above 1,500 km, theater 400–1,500 km, region below', () => {
    expect(bandForAltitude(3000 * KM)).toBe('globe');
    expect(bandForAltitude(1500 * KM)).toBe('globe');
    expect(bandForAltitude(1499 * KM)).toBe('theater');
    expect(bandForAltitude(400 * KM)).toBe('theater');
    expect(bandForAltitude(399 * KM)).toBe('region');
    expect(bandForAltitude(100 * KM)).toBe('region');
  });

  it('changes band only after clearing an edge by the margin', () => {
    const k = 1 + BAND_HYSTERESIS;
    // Zooming in from globe: stays until below 1,500 km / k.
    expect(nextBand('globe', GLOBE_BAND_FLOOR * 0.99)).toBe('globe');
    expect(nextBand('globe', (GLOBE_BAND_FLOOR / k) * 0.999)).toBe('theater');
    // Zooming out from theater: stays until above 1,500 km · k.
    expect(nextBand('theater', GLOBE_BAND_FLOOR * 1.01)).toBe('theater');
    expect(nextBand('theater', GLOBE_BAND_FLOOR * k * 1.001)).toBe('globe');
    // The same at the theater/region edge.
    expect(nextBand('theater', THEATER_BAND_FLOOR * 0.97)).toBe('theater');
    expect(nextBand('region', THEATER_BAND_FLOOR * 1.03)).toBe('region');
    expect(nextBand('region', THEATER_BAND_FLOOR * k * 1.001)).toBe('theater');
  });

  it('jumps across several bands at once, with the margin on every edge it crosses', () => {
    expect(nextBand('globe', 100 * KM)).toBe('region');
    expect(nextBand('region', 3000 * KM)).toBe('globe');
    // Just past the region edge from globe, but not clear of it: theater.
    expect(nextBand('globe', THEATER_BAND_FLOOR * 0.99)).toBe('theater');
  });

  it('does not flicker while the altitude wobbles on an edge', () => {
    let band: ZoomBand = 'theater';
    let changes = 0;
    for (let i = 0; i < 200; i++) {
      const h = GLOBE_BAND_FLOOR * (1 + 0.05 * Math.sin(i * 0.7));
      const next = nextBand(band, h);
      if (next !== band) changes++;
      band = next;
    }
    expect(changes).toBe(0);
  });
});

describe('ZoomBands', () => {
  it('starts in the altitude band with that band fully faded in', () => {
    const z = new ZoomBands(800 * KM);
    expect(z.band).toBe('theater');
    expect(z.fade('theater')).toBe(1);
    expect(z.fade('globe')).toBe(0);
    expect(z.fade('region')).toBe(0);
  });

  it('crossfades over the fade time and reports each change once', () => {
    const z = new ZoomBands(3000 * KM);
    const events: string[] = [];
    const off = z.onChange((band, previous) => events.push(`${previous}>${band}`));
    expect(z.update(800 * KM, 0.016)).toBe(true);
    expect(z.update(800 * KM, 0.016)).toBe(false);
    expect(events).toEqual(['globe>theater']);
    // Partway: both fade factors between 0 and 1, the new one rising.
    const half = BAND_FADE_TIME / 2;
    z.update(800 * KM, half - 0.032);
    expect(z.fade('theater')).toBeGreaterThan(0.3);
    expect(z.fade('theater')).toBeLessThan(0.7);
    expect(z.fade('globe')).toBeCloseTo(1 - z.fade('theater'), 12);
    // Done after the fade time.
    z.update(800 * KM, BAND_FADE_TIME);
    expect(z.fade('theater')).toBe(1);
    expect(z.fade('globe')).toBe(0);
    off();
    z.update(100 * KM, 0.016);
    expect(events).toHaveLength(1);
  });

  it('snaps the fades with dt = 0 (headless renders)', () => {
    const z = new ZoomBands(3000 * KM);
    z.update(100 * KM, 0);
    expect(z.band).toBe('region');
    for (const b of ZOOM_BANDS) expect(z.fade(b)).toBe(b === 'region' ? 1 : 0);
  });

  it('keeps the fades bounded and summing to at most one per step', () => {
    const z = new ZoomBands(3000 * KM);
    const path = [3000, 1000, 300, 1000, 2000, 120, 2500].map((h) => h * KM);
    for (const h of path) {
      for (let i = 0; i < 5; i++) {
        z.update(h, 0.05);
        let sum = 0;
        for (const b of ZOOM_BANDS) {
          const f = z.fade(b);
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThanOrEqual(1);
          sum += f;
        }
        expect(sum).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });
});
