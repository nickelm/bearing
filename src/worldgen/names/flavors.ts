/**
 * Naming flavors (decision 96): syllable inventories and phonotactic rules that make
 * each cultural region's names sound alike, and different from its neighbors',
 * without copying a real language. Names are plain ASCII, so every label font
 * covers them.
 *
 * A word is 1–4 syllables (weights `syllables`), each onset + nucleus + coda, with
 * codas allowed only where `codaChance` permits, no run of three consonants, and
 * at most 9 letters (toponymy.ts). Region and continent names add one of the flavor's `landEndings`.
 */
export interface Flavor {
  id: number;
  /** A neutral label for tools; flavors are not named after real cultures. */
  label: string;
  onsets: readonly string[];
  nuclei: readonly string[];
  codas: readonly string[];
  /** Weights for 1, 2, 3 and 4 syllables. */
  syllables: readonly [number, number, number, number];
  /** Chance of a coda on a non-final syllable (final syllables use `finalCoda`). */
  codaChance: number;
  finalCoda: number;
  landEndings: readonly string[];
  /** Endings for settlements, appended now and then. */
  townEndings: readonly string[];
}

export const FLAVORS: readonly Flavor[] = [
  {
    id: 0,
    label: 'A (northern)',
    onsets: [
      'b',
      'br',
      'd',
      'dr',
      'f',
      'g',
      'gr',
      'h',
      'k',
      'kr',
      'l',
      'm',
      'n',
      'r',
      's',
      'sk',
      'st',
      't',
      'th',
      'v',
      'w',
    ],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'o', 'ei', 'au', 'aa'],
    codas: ['n', 'r', 'l', 'rd', 'rn', 'nd', 'st', 'k', 'th', 'n', 'r'],
    syllables: [4, 6, 1, 0],
    codaChance: 0.5,
    finalCoda: 0.75,
    landEndings: ['mark', 'land', 'heim', 'vik', 'holm', 'gard'],
    townEndings: ['by', 'stad', 'dal', 'ness', 'berg'],
  },
  {
    id: 1,
    label: 'B (eastern)',
    onsets: [
      'b',
      'v',
      'g',
      'd',
      'z',
      'k',
      'l',
      'm',
      'n',
      'p',
      'r',
      's',
      't',
      'ch',
      'zh',
      'sh',
      'kr',
      'pr',
      'sl',
      'st',
      'dv',
      'vl',
      'br',
    ],
    nuclei: ['a', 'o', 'e', 'i', 'u', 'y', 'a', 'o', 'ya'],
    codas: ['v', 'k', 'n', 'r', 'sk', 'ch', 'l', 'm', 'z'],
    syllables: [2, 6, 3, 0],
    codaChance: 0.2,
    finalCoda: 0.55,
    landEndings: ['ovia', 'ania', 'ia', 'evo', 'ensk'],
    townEndings: ['ovo', 'ets', 'insk', 'ava', 'ograd'],
  },
  {
    id: 2,
    label: 'C (southern)',
    onsets: [
      'b',
      'c',
      'd',
      'f',
      'l',
      'm',
      'n',
      'p',
      'r',
      's',
      't',
      'v',
      'br',
      'tr',
      'pr',
      'gr',
      'gi',
      'ch',
    ],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'o', 'ia', 'io'],
    codas: ['l', 'n', 'r', 's'],
    syllables: [0, 5, 5, 0],
    codaChance: 0.15,
    finalCoda: 0.2,
    landEndings: ['ia', 'ona', 'enza', 'ara', 'ino', 'esa'],
    townEndings: ['ello', 'ano', 'ezza', 'ira', 'osa'],
  },
  {
    id: 3,
    label: 'D (steppe)',
    onsets: [
      'b',
      'k',
      't',
      's',
      'y',
      'q',
      'j',
      'm',
      'n',
      'd',
      'g',
      'z',
      'kh',
      'sh',
      'ch',
      'ar',
      'ak',
      'ul',
    ],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'a', 'u', 'ai', 'ay'],
    codas: ['n', 'r', 'l', 'k', 'sh', 'z', 't', 'm', 'q', 'y'],
    syllables: [2, 6, 2, 0],
    codaChance: 0.45,
    finalCoda: 0.8,
    landEndings: ['ar', 'tay', 'kul', 'ish', 'an', 'yr'],
    townEndings: ['kent', 'abad', 'tai', 'ul', 'sar'],
  },
  {
    id: 4,
    label: 'E (islands)',
    onsets: ['k', 'l', 'm', 'n', 'p', 't', 'h', 'v', 'w', 'r', '', ''],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'a', 'ai', 'au', 'oa'],
    codas: ['n'],
    syllables: [0, 4, 5, 1],
    codaChance: 0,
    finalCoda: 0.05,
    landEndings: ['nui', 'ka', 'ani', 'ua'],
    townEndings: ['a', 'i', 'o'],
  },
];

/** Flavor for archipelago naming regions. */
export const ISLAND_FLAVOR = 4;
/** Flavors that landmass regions cycle through. */
export const LAND_FLAVORS = [0, 1, 2, 3];
