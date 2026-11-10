/**
 * The campaign briefing as a panel over the globe: the seed that was
 * generated, the theaters with their fit scores, and the briefing text.
 */
import type { Cast } from '../campaign/cast';
import { THEATER_LABELS } from '../campaign/theaters';

export class CampaignPanel {
  private readonly el: HTMLDivElement;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'campaign-panel';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  set visible(v: boolean) {
    this.el.hidden = !v;
  }

  show(seed: string, retries: number, cast: Cast | null): void {
    this.el.replaceChildren();
    const h = document.createElement('h2');
    h.textContent = `Briefing: world ${seed}`;
    this.el.appendChild(h);
    if (retries > 0) {
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = `The seed's first ${retries} world${retries === 1 ? '' : 's'} failed the validity check; this is retry ${retries}.`;
      this.el.appendChild(p);
    }
    if (!cast) return;
    const ul = document.createElement('ul');
    for (const t of cast.theaters) {
      const li = document.createElement('li');
      li.textContent = `${t.name} (${THEATER_LABELS[t.kind].toLowerCase()}, fit ${t.fit.toFixed(2)})`;
      ul.appendChild(li);
    }
    this.el.appendChild(ul);
    for (const para of cast.briefing.split('\n\n')) {
      const p = document.createElement('p');
      p.textContent = para;
      this.el.appendChild(p);
    }
  }
}
