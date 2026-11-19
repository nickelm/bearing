/**
 * Invented place and operation names (briefing, settlements), drawn from a
 * caller-given stream.
 * Names are invented from syllables, so they belong to no real place.
 */
import type { Rng } from './rng';

const ONSETS = [
  'b',
  'br',
  'd',
  'dr',
  'g',
  'gr',
  'k',
  'kr',
  'l',
  'm',
  'n',
  'p',
  'r',
  's',
  'st',
  't',
  'tr',
  'v',
  'z',
  'h',
  'f',
  'sk',
  'th',
];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'o', 'ai', 'ei', 'au'];
const CODAS = ['', '', '', 'n', 'r', 'l', 's', 'k', 'th', 'rn', 'st', 'm'];
const LAND_ENDINGS = ['ia', 'a', 'ania', 'mark', 'land', 'or', 'en', 'heim', 'ova'];
const OPERATION_WORDS = [
  'Anvil',
  'Bastion',
  'Cinder',
  'Dagger',
  'Ember',
  'Falchion',
  'Granite',
  'Harrow',
  'Iron',
  'Javelin',
  'Keystone',
  'Lantern',
  'Mistral',
  'Nightfall',
  'Onyx',
  'Pike',
  'Quarry',
  'Rampart',
  'Sabre',
  'Tempest',
  'Umber',
  'Vigil',
  'Warden',
  'Zenith',
];

/** Surname endings by side, for invented aircrew names. */
const SURNAME_ENDINGS: Record<'alliance' | 'pact', readonly string[]> = {
  alliance: ['son', 'er', 'ley', 'ton', 'ard', 'well', 'ford', 'by', 'ett', 'man', 'ing', 'wick'],
  pact: ['ov', 'in', 'enko', 'ski', 'ev', 'ich', 'yuk', 'ak', 'ovich', 'ets'],
};
const INITIALS = 'ABCDEFGHIJKLMNOPRSTVWY';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class NameGenerator {
  private readonly used = new Set<string>();

  constructor(private readonly r: Rng) {}

  private syllable(): string {
    return this.r.pick(ONSETS) + this.r.pick(VOWELS) + this.r.pick(CODAS);
  }

  private unique(make: () => string): string {
    for (let i = 0; i < 50; i++) {
      const name = make();
      if (!this.used.has(name)) {
        this.used.add(name);
        return name;
      }
    }
    const name = `${make()} ${this.used.size}`;
    this.used.add(name);
    return name;
  }

  /** A landmass or region name, e.g. "Varnia". */
  land(): string {
    return this.unique(() => {
      const stem = this.syllable() + (this.r.chance(0.4) ? this.syllable() : '');
      return capitalize(stem + this.r.pick(LAND_ENDINGS));
    });
  }

  /** A short proper name for straits and islands, e.g. "Kessa". */
  short(): string {
    return this.unique(() =>
      capitalize(this.syllable() + this.r.pick(['a', 'o', 'en', 'is', 'ar'])),
    );
  }

  /** An aircrew member's name for a side, an initial and a surname, e.g. "R. Kessley" or "T. Drauvenko". */
  person(side: 'alliance' | 'pact'): string {
    return this.unique(() => {
      const initial = INITIALS[this.r.int(INITIALS.length)]!;
      // Open syllables, then a soft coda that does not double the ending's first letter.
      const open = () => this.r.pick(ONSETS) + this.r.pick(VOWELS);
      let stem = open() + (this.r.chance(0.3) ? open() : '');
      const ending = this.r.pick(SURNAME_ENDINGS[side]);
      const coda = this.r.pick(['', 'n', 'r', 'l', 's', 'nd', 'rk']);
      if (!'aeiou'.includes(ending[0]!) && coda && coda.at(-1) !== ending[0]) stem += coda;
      return `${initial}. ${capitalize(stem + ending)}`;
    });
  }

  /** An operation name, e.g. "Operation Granite Vigil". */
  operation(): string {
    return this.unique(() => `${this.r.pick(OPERATION_WORDS)} ${this.r.pick(OPERATION_WORDS)}`);
  }
}
