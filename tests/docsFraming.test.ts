import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the game framing in the Markdown (CLAUDE.md rule 22, decision 370): Bearing is a
 * cartoony browser game, and its documents do not call it a flight simulator.
 */

const ROOT = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'out', 'references', 'screens']);

function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...markdownFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith('.md')) files.push(join(dir, entry.name));
  }
  return files;
}

/** Records say what happened and keep their words (decision 370). */
const RECORDS = ['docs/decisions.md', 'docs/status/', 'docs/reports/', 'docs/style/'];

/** Quoted references that may keep a phrase: file prefix, phrase. */
const ALLOWED: { file: string; phrase: string }[] = [
  { file: 'CLAUDE.md', phrase: 'study-level realism of DCS' },
  { file: 'docs/design.md', phrase: 'study-level realism of DCS' },
];

const BANNED_EVERYWHERE = [/flight sim(ulator)?s?\b/i, /realistic simulation/i];
const BANNED_IN_DESIGN_DOCS = [/\bsimulators?\b/i, /\bsimulation views?\b/i];

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(patterns: RegExp[], include: (rel: string) => boolean): Hit[] {
  const hits: Hit[] = [];
  for (const path of markdownFiles(ROOT)) {
    const rel = relative(ROOT, path).split(sep).join('/');
    if (!include(rel)) continue;
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (ALLOWED.some((a) => rel === a.file && text.includes(a.phrase))) return;
        if (patterns.some((p) => p.test(text)))
          hits.push({ file: rel, line: i + 1, text: text.trim().slice(0, 100) });
      });
  }
  return hits;
}

describe('documents keep the game framing', () => {
  it('never call Bearing a flight simulator or a realistic simulation', () => {
    expect(scan(BANNED_EVERYWHERE, () => true)).toEqual([]);
  });

  it('say flight view and game, not simulator or simulation view, outside the records', () => {
    const isRecord = (rel: string) => RECORDS.some((r) => rel === r || rel.startsWith(r));
    expect(scan(BANNED_IN_DESIGN_DOCS, (rel) => !isRecord(rel))).toEqual([]);
  });
});
