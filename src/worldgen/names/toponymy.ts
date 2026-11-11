/**
 * The toponymy generator (design pipeline step 8; decision 96): proper names from a
 * flavor's syllables, completed by English generic terms ("the Varden Range",
 * "Mount Kessar", "Lake Brann", "the Teller Strait", "the Oskel Waste").
 *
 * Every name is unique within a world: a stem used once is never reused, whatever
 * the generic term. Draws come from the caller's stream only.
 */
import type { Rng } from '../../core/rng';
import { FLAVORS } from './flavors';
import type { Flavor } from './flavors';

const VOWEL = /[aeiouy]/;
/** Stems that read as English words next to a generic term ("the The Mountains"). */
const BANNED = new Set([
  'the',
  'and',
  'of',
  'at',
  'in',
  'on',
  'to',
  'mount',
  'lake',
  'bay',
  'sea',
  'gulf',
  'gap',
  'range',
  'hills',
  'river',
  'island',
  'isle',
  'ocean',
  'strait',
  'plain',
  'waste',
  'forest',
  'woods',
  'marsh',
  'fens',
  'nazi',
  'kill',
  'dead',
  'rape',
  'shit',
  'fuck',
  'cunt',
  'piss',
  'damn',
  'hell',
  'slut',
  'whore',
  'nig',
  'fag',
  'cum',
  'tit',
  'ass',
  'kkk',
]);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** True if a string would end in a consonant cluster of three or more letters. */
function heavy(s: string): boolean {
  return /[^aeiouy]{3,}$/.test(s);
}

export class Toponymy {
  /** Lowercase stems already used. */
  private readonly used = new Set<string>();

  constructor(private readonly r: Rng) {}

  /** True with probability p, from the generator's stream. */
  chance(p: number): boolean {
    return this.r.chance(p);
  }

  /** One syllable; `final` uses the final-coda chance. */
  private syllable(f: Flavor, prev: string, final: boolean): string {
    for (let i = 0; i < 8; i++) {
      const onset = this.r.pick(f.onsets);
      const nucleus = this.r.pick(f.nuclei);
      const coda = this.r.chance(final ? f.finalCoda : f.codaChance) ? this.r.pick(f.codas) : '';
      const s = onset + nucleus + coda;
      // Phonotactics: no triple consonants across the join, no doubled vowels across it.
      if (heavy(prev + onset)) continue;
      if (prev && VOWEL.test(prev.slice(-1)) && onset === '') continue;
      if (prev.endsWith(s)) continue;
      return s;
    }
    return this.r.pick(f.onsets.filter((o) => o !== '')) + this.r.pick(f.nuclei);
  }

  /** A raw stem of the flavor's syllable count, 3–9 letters. */
  word(flavor: number, minSyllables = 1): string {
    const f = FLAVORS[flavor] ?? FLAVORS[0]!;
    for (let attempt = 0; attempt < 40; attempt++) {
      let total = 0;
      for (const w of f.syllables) total += w;
      let u = this.r.nextFloat() * total;
      let n = 1;
      for (let k = 0; k < 4; k++) {
        u -= f.syllables[k]!;
        if (u < 0) {
          n = k + 1;
          break;
        }
      }
      n = Math.max(n, minSyllables);
      let s = '';
      for (let k = 0; k < n; k++) s += this.syllable(f, s, k === n - 1);
      if (s.length < 3 || s.length > 9 || !VOWEL.test(s) || /[^aeiouy]{3}/.test(s)) continue;
      if (/[aeiouy]{3}|ii|uu|yy|iy|yi/.test(s)) continue;
      if (BANNED.has(s) || [...BANNED].some((b) => b.length >= 4 && s.includes(b))) continue;
      if (this.used.has(s)) continue;
      return s;
    }
    // Exhausted: a longer word is all but certain to be new.
    let s: string;
    do
      s =
        this.r.pick(f.onsets) +
        this.r.pick(f.nuclei) +
        this.r.pick(f.codas) +
        this.r.pick(f.nuclei);
    while (this.used.has(s));
    return s;
  }

  /** A unique proper name ("Kessar"), marked as used. */
  proper(flavor: number, minSyllables = 1): string {
    const s = this.word(flavor, minSyllables);
    this.used.add(s);
    return capitalize(s);
  }

  /** A land or region name with the flavor's ending ("Varnmark"). */
  land(flavor: number): string {
    const f = FLAVORS[flavor] ?? FLAVORS[0]!;
    for (let i = 0; i < 20; i++) {
      let stem = this.word(flavor);
      const ending = this.r.pick(f.landEndings);
      if (VOWEL.test(stem.slice(-1)) && VOWEL.test(ending[0]!)) stem = stem.slice(0, -1);
      const s = stem + ending;
      if (s.length > 11 || this.used.has(s) || heavy(stem + ending.slice(0, 1))) continue;
      this.used.add(s);
      this.used.add(stem);
      return capitalize(s);
    }
    return this.proper(flavor, 2);
  }

  /** A settlement name: a stem, sometimes with a town ending. */
  town(flavor: number): string {
    const f = FLAVORS[flavor] ?? FLAVORS[0]!;
    if (this.r.chance(0.35)) {
      for (let i = 0; i < 10; i++) {
        let stem = this.word(flavor);
        const ending = this.r.pick(f.townEndings);
        if (VOWEL.test(stem.slice(-1)) && VOWEL.test(ending[0]!)) stem = stem.slice(0, -1);
        const s = stem + ending;
        if (s.length > 12 || this.used.has(s)) continue;
        this.used.add(s);
        return capitalize(s);
      }
    }
    return this.proper(flavor);
  }
}
