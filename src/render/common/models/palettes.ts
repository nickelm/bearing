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
  // Ground cover (decisions 172, 174, 178): rock shades per face, and gray rock with lichen,
  // cool grays a little darker than warm open ground so boulders stand out from it; the
  // bounce light keeps their shaded sides from going black.
  rock: { name: 'Rock', colors: ['#77736E', '#8A857E', '#64605B'], patch: 0.35 },
  'rock-lichen': {
    name: 'Rock with lichen',
    colors: ['#77736E', '#8A857E', '#8F8E5E', '#64605B'],
    patch: 0.3,
  },
  sandstone: { name: 'Sandstone', colors: ['#B8693C', '#C98D58', '#A65A36'], patch: 0.5 },
  // Ships: haze gray over a darker waterline, per side (decision 106).
  'alliance-ship': { name: 'Alliance ship', colors: ['#8C949B'], patch: 20 },
  'pact-ship': { name: 'Pact ship', colors: ['#7E8A86'], patch: 20 },
};

/** Named colors specs may use for a group (Part I's tables, plus model materials). */
export const MODEL_COLORS: Record<string, string> = {
  // Aircraft.
  canopy: '#1E2A33',
  // The gold tint of the F-16's and F-22's coated canopies, muted to the palette (owner, decision 310).
  'canopy-gold': '#8A713F',
  intake: '#2A2C2E',
  nozzle: '#4A4642',
  radome: '#5E6266',
  'insignia-alliance': '#2F6FB5',
  'insignia-pact': '#D0532B',
  // Buildings and bases (Part I, Buildings and Bases: pale concrete and muted paint).
  concrete: '#A9A69E',
  'concrete-dark': '#8D8A83',
  // Bridge decks (decision 192).
  asphalt: '#55565A',
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
  // Vegetation (Part I, Palette: the canopy shades of temperate and conifer forest, plus
  // a lighter birch green and barks; tree kit, docs/proposals/0003).
  'leaf-conifer-dark': '#24382A',
  'leaf-conifer': '#2C4434',
  'leaf-conifer-light': '#35503C',
  'leaf-dark': '#2F4A2A',
  leaf: '#3B5A33',
  'leaf-light': '#466B3B',
  'leaf-birch': '#52713A',
  'leaf-birch-light': '#5F7E40',
  'leaf-dry': '#6B6A3A',
  bark: '#4A3A2C',
  'bark-dark': '#3A2E24',
  'bark-pale': '#BDB8AA',
  'bark-dead': '#6A625A',
  // Ground cover (decision 172): grass from Part I's grassland shades, dry grass from
  // savanna's, reeds, and muted flowers; the cover takes the ground's color in the scene.
  'grass-dark': '#6B7C40',
  grass: '#7A8C4A',
  'grass-light': '#8A9A55',
  'grass-dry': '#A89A5A',
  'grass-dry-light': '#B8AA68',
  reed: '#7F8A4A',
  'reed-head': '#5A3E28',
  'flower-cream': '#E3D9B8',
  'flower-yellow': '#D4B04A',
  'flower-violet': '#9A86AE',
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
