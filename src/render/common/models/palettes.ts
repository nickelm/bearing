/**
 * Model palettes and camouflage schemes (visual-style Part I, Palette; decision 106),
 * as data shared by the model builder and the model viewer. Colors are sRGB hex
 * strings as the guide writes them; the builder converts them to linear.
 */

/** A camouflage scheme: large flat patches over the faces of `camo` groups. */
export interface CamoScheme {
  name: string;
  /** Patch colors, drawn by a low-frequency pattern over face centers. */
  colors: readonly string[];
  /** Underside color for faces facing down (naval and bare schemes), if any. */
  underside?: string;
  /** Patch size (m): the pattern's feature size. */
  patch: number;
}

/** Part I's faction schemes. */
export const SCHEMES: Record<string, CamoScheme> = {
  'alliance-air': { name: 'Alliance air superiority', colors: ['#8A9199', '#6F7780'], patch: 5 },
  'alliance-woodland': {
    name: 'Alliance woodland',
    colors: ['#3E4A36', '#2E3328', '#55594F'],
    patch: 4,
  },
  'alliance-naval': {
    name: 'Alliance naval',
    colors: ['#B4B7B8'],
    underside: '#E6E6E2',
    patch: 6,
  },
  'alliance-stealth': { name: 'Alliance stealth', colors: ['#1C1D20', '#26282C'], patch: 3 },
  'pact-air': { name: 'Pact air superiority', colors: ['#7F8C96', '#A3B1B9'], patch: 5 },
  'pact-tactical': {
    name: 'Pact tactical',
    colors: ['#8B7350', '#5E6B45', '#A39070'],
    patch: 4,
  },
  'pact-bomber': { name: 'Pact bomber', colors: ['#A7ABAE'], patch: 10 },
  // Ships: haze gray over a darker waterline, per side (decision 106).
  'alliance-ship': { name: 'Alliance ship', colors: ['#8C949B'], patch: 20 },
  'pact-ship': { name: 'Pact ship', colors: ['#7E8A86'], patch: 20 },
};

/** Named colors specs may use for a group (Part I's tables, plus model materials). */
export const MODEL_COLORS: Record<string, string> = {
  // Aircraft.
  canopy: '#1E2A33',
  intake: '#2A2C2E',
  nozzle: '#4A4642',
  radome: '#5E6266',
  'insignia-alliance': '#2F6FB5',
  'insignia-pact': '#D0532B',
  // Buildings and bases (Part I, Buildings and Bases: pale concrete and muted paint).
  concrete: '#A9A69E',
  'concrete-dark': '#8D8A83',
  'paint-green': '#5E6B4F',
  'paint-sand': '#B3A585',
  'paint-white': '#D9D7D0',
  steel: '#7A7C7E',
  opening: '#1A1B1D',
  glass: '#2C3A44',
  earth: '#6E6450',
  // Settlements (Part I, Terrain and Water: walls and roofs).
  wall: '#C9BFAF',
  'wall-dark': '#B5A898',
  'roof-red': '#8E5A48',
  'roof-gray': '#5E5E62',
  // Ships.
  deck: '#5A5C5E',
  'flight-deck': '#4A4C4E',
  waterline: '#3A3E42',
  mast: '#6E7276',
};

/** Emissive colors (Part I, Light and Emissives). */
export const EMISSIVE_COLORS: Record<string, string> = {
  afterburner: '#FFB347',
  'nav-red': '#FF3B30',
  'nav-green': '#34C759',
  'nav-white': '#FFFFFF',
  beacon: '#FF3B30',
  runway: '#FFD27A',
  flood: '#FFD27A',
  window: '#FFC98A',
};

export function hexToLinear(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [lin((v >> 16) & 255), lin((v >> 8) & 255), lin(v & 255)];
}
