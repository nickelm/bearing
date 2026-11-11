/**
 * Label typography (visual-style Part II, Labels; decision 98): Part II's
 * cartographic conventions as styles.
 *
 * - **Water** in blue italic serif (EB Garamond), letter-spaced for oceans and seas.
 * - **Landforms** in brown, letter-spaced sans capitals (Fira Sans).
 * - **Settlements** in dark sans with a light halo, sized by class.
 * - **Theaters** in near-black spaced capitals (military features take faction
 *   colors once the overlays exist, S3).
 *
 * Every style has a halo so text stays legible over relief, glyphs and the night
 * side; water labels get a pale, thin one.
 */
import type { FontId } from './fontAtlas';

export type LabelStyleId =
  | 'ocean'
  | 'sea'
  | 'water'
  | 'river'
  | 'continent'
  | 'landform'
  | 'landformSmall'
  | 'peak'
  | 'island'
  | 'city'
  | 'town'
  | 'village'
  | 'theater';

export interface LabelStyle {
  font: FontId;
  /** Size (CSS px, the em). */
  size: number;
  /** Extra letter spacing (em). */
  tracking: number;
  uppercase: boolean;
  /** sRGB hex. */
  color: number;
  halo: number;
  /** Halo width (px) and opacity. */
  haloWidth: number;
  haloOpacity: number;
}

const WATER = 0x2f5f86;
const LANDFORM = 0x6b4a2e;
const SETTLEMENT = 0x22252a;
const HALO = 0xf4efe4;
const WATER_HALO = 0xe6eff2;

export const LABEL_STYLES: Record<LabelStyleId, LabelStyle> = {
  ocean: {
    font: 'serifItalic',
    size: 22,
    tracking: 0.3,
    uppercase: false,
    color: WATER,
    halo: WATER_HALO,
    haloWidth: 1.5,
    haloOpacity: 0.45,
  },
  sea: {
    font: 'serifItalic',
    size: 17,
    tracking: 0.15,
    uppercase: false,
    color: WATER,
    halo: WATER_HALO,
    haloWidth: 1.5,
    haloOpacity: 0.45,
  },
  water: {
    font: 'serifItalic',
    size: 14,
    tracking: 0.02,
    uppercase: false,
    color: WATER,
    halo: WATER_HALO,
    haloWidth: 1.5,
    haloOpacity: 0.5,
  },
  river: {
    font: 'serifItalic',
    size: 13,
    tracking: 0.04,
    uppercase: false,
    color: WATER,
    halo: HALO,
    haloWidth: 1.6,
    haloOpacity: 0.7,
  },
  continent: {
    font: 'sans',
    size: 19,
    tracking: 0.4,
    uppercase: true,
    color: LANDFORM,
    halo: HALO,
    haloWidth: 2,
    haloOpacity: 0.6,
  },
  landform: {
    font: 'sans',
    size: 13,
    tracking: 0.2,
    uppercase: true,
    color: LANDFORM,
    halo: HALO,
    haloWidth: 1.8,
    haloOpacity: 0.7,
  },
  landformSmall: {
    font: 'sans',
    size: 11,
    tracking: 0.16,
    uppercase: true,
    color: LANDFORM,
    halo: HALO,
    haloWidth: 1.6,
    haloOpacity: 0.7,
  },
  peak: {
    font: 'sans',
    size: 11,
    tracking: 0.02,
    uppercase: false,
    color: LANDFORM,
    halo: HALO,
    haloWidth: 1.6,
    haloOpacity: 0.8,
  },
  island: {
    font: 'sans',
    size: 12,
    tracking: 0.12,
    uppercase: true,
    color: LANDFORM,
    halo: HALO,
    haloWidth: 1.8,
    haloOpacity: 0.7,
  },
  city: {
    font: 'sansBold',
    size: 14,
    tracking: 0.02,
    uppercase: false,
    color: SETTLEMENT,
    halo: HALO,
    haloWidth: 2,
    haloOpacity: 0.85,
  },
  town: {
    font: 'sans',
    size: 12,
    tracking: 0.02,
    uppercase: false,
    color: SETTLEMENT,
    halo: HALO,
    haloWidth: 1.8,
    haloOpacity: 0.85,
  },
  village: {
    font: 'sans',
    size: 10.5,
    tracking: 0.02,
    uppercase: false,
    color: SETTLEMENT,
    halo: HALO,
    haloWidth: 1.6,
    haloOpacity: 0.8,
  },
  theater: {
    font: 'sansBold',
    size: 15,
    tracking: 0.14,
    uppercase: true,
    color: 0x2a2a2a,
    halo: HALO,
    haloWidth: 2,
    haloOpacity: 0.75,
  },
};
