/**
 * Zoom bands of the strategic view (visual-style Part II, Camera and Zoom; decision 76).
 *
 *   Globe    above 1,500 km
 *   Theater  400–1,500 km
 *   Region   below 400 km
 *
 * - **Hysteresis.** The band changes only once the altitude clears an edge by
 *   `BAND_HYSTERESIS` (8%) in the direction of travel, so a camera resting on an
 *   edge does not flicker between bands.
 * - **Fades.** Each band has a fade factor that ramps linearly to 1 while it is the
 *   active band and to 0 otherwise, over `BAND_FADE_TIME` of real time; `fade()`
 *   returns it smoothstep-eased. Band content multiplies its opacity by it, so
 *   content crossfades in short fades rather than popping. A step with dt = 0 (headless
 *   renders, the first frame) snaps the fades to their targets.
 * - **Change event.** Listeners hear each band change once, with the old band.
 *
 * Pure TypeScript with no Three.js, so it is unit-tested in Node; the scene copies the
 * fades into TSL uniforms (strategicScene.ts).
 */
import { KM } from '../../core/units';
import type { Meters, Seconds } from '../../core/units';

export type ZoomBand = 'globe' | 'theater' | 'region';
/** From the highest altitudes down. */
export const ZOOM_BANDS: readonly ZoomBand[] = ['globe', 'theater', 'region'];

/** Lower edge of the Globe band (also where the camera stops tilting, decision 75). */
export const GLOBE_BAND_FLOOR = 1500 * KM;
/** Lower edge of the Theater band. */
export const THEATER_BAND_FLOOR = 400 * KM;
/** Fraction by which the altitude must clear an edge before the band changes. */
export const BAND_HYSTERESIS = 0.08;
/** Real time for a band's content to fade fully in or out. */
export const BAND_FADE_TIME: Seconds = 0.35;

/** Lower and upper altitude edges of a band. */
export function bandRange(band: ZoomBand): [Meters, Meters] {
  switch (band) {
    case 'globe':
      return [GLOBE_BAND_FLOOR, Infinity];
    case 'theater':
      return [THEATER_BAND_FLOOR, GLOBE_BAND_FLOOR];
    case 'region':
      return [0, THEATER_BAND_FLOOR];
  }
}

/** The band an altitude falls in, without hysteresis (edges belong to the band above). */
export function bandForAltitude(altitude: Meters): ZoomBand {
  if (altitude >= GLOBE_BAND_FLOOR) return 'globe';
  if (altitude >= THEATER_BAND_FLOOR) return 'theater';
  return 'region';
}

/**
 * The band after `current` at `altitude`, with hysteresis: leave the current band only
 * past its edge by the margin; a jump across several bands lands in the band whose
 * edges the altitude has cleared by the margin.
 */
export function nextBand(
  current: ZoomBand,
  altitude: Meters,
  hysteresis = BAND_HYSTERESIS,
): ZoomBand {
  const [lo, hi] = bandRange(current);
  const k = 1 + hysteresis;
  if (altitude > hi * k) return bandForAltitude(altitude / k);
  if (altitude < lo / k) return bandForAltitude(altitude * k);
  return current;
}

export type BandListener = (band: ZoomBand, previous: ZoomBand) => void;

export class ZoomBands {
  private current: ZoomBand;
  /** Linear fade progress per band, 0..1. */
  private readonly progress: Record<ZoomBand, number> = { globe: 0, theater: 0, region: 0 };
  private readonly listeners = new Set<BandListener>();

  constructor(altitude: Meters) {
    this.current = bandForAltitude(altitude);
    this.progress[this.current] = 1;
  }

  get band(): ZoomBand {
    return this.current;
  }

  /** Eased fade factor of a band's content, 0..1. */
  fade(band: ZoomBand): number {
    const u = this.progress[band];
    return u * u * (3 - 2 * u);
  }

  /** Calls `fn` on each band change; returns a function that removes it. */
  onChange(fn: BandListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Updates the band from the camera altitude and advances the fades by `dt` real
   * seconds (dt ≤ 0 snaps them). Returns whether the band changed.
   */
  update(altitude: Meters, dt: Seconds): boolean {
    const previous = this.current;
    this.current = nextBand(previous, altitude);
    const step = dt > 0 ? dt / BAND_FADE_TIME : Infinity;
    for (const b of ZOOM_BANDS) {
      const target = b === this.current ? 1 : 0;
      const p = this.progress[b];
      this.progress[b] = target > p ? Math.min(target, p + step) : Math.max(target, p - step);
    }
    if (previous === this.current) return false;
    for (const fn of this.listeners) fn(this.current, previous);
    return true;
  }
}
