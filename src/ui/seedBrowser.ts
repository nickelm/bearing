/**
 * Seed browser panel (milestone 4): a table of what each scanned seed
 * produces (theaters with fit scores, range factor, airbase room, retries).
 * Clicking a row loads that seed.
 */
import type { SeedSummary } from '../worldgen/campaignWorld';

const SHORT: Record<string, string> = {
  'continental-front': 'front',
  'sea-lane': 'lane',
  chokepoint: 'choke',
  'island-campaign': 'islands',
  strategic: 'strat',
};

export class SeedBrowser {
  private readonly el: HTMLDivElement;
  private readonly body: HTMLTableSectionElement;
  private readonly caption: HTMLDivElement;

  constructor(
    private readonly load: (seed: string) => void,
    parent: HTMLElement = document.body,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'seed-browser';
    this.el.hidden = true;
    this.caption = document.createElement('div');
    this.caption.className = 'caption';
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const h of ['seed', 'theaters (fit)', 'range', 'bases A/P', 'towns', 'retries']) {
      const th = document.createElement('th');
      th.textContent = h;
      head.appendChild(th);
    }
    this.body = table.createTBody();
    this.el.append(this.caption, table);
    parent.appendChild(this.el);
  }

  set visible(v: boolean) {
    this.el.hidden = !v;
  }

  clear(): void {
    this.body.replaceChildren();
  }

  status(text: string): void {
    this.caption.textContent = text;
  }

  add(row: SeedSummary): void {
    const tr = this.body.insertRow();
    tr.title = `Load seed ${row.seed}`;
    tr.onclick = () => this.load(row.seed);
    const theaters = row.theaters
      .filter((t) => t.kind !== 'strategic')
      .map((t) => `${SHORT[t.kind] ?? t.kind} ${t.fit.toFixed(2)}`)
      .join(', ');
    const cells = [
      row.seed,
      theaters || '—',
      row.rangeFactor.toFixed(2),
      `${row.placed.alliance}/${row.placed.pact}`,
      String(row.settlements),
      row.valid ? String(row.retries) : `${row.retries} (invalid)`,
    ];
    for (const c of cells) tr.insertCell().textContent = c;
  }
}
