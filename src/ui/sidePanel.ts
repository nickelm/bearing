/**
 * Side selection at campaign start (roadmap R1.4): the generated briefing and
 * one button per side. The choice is a campaign input (logged) and becomes the
 * map's viewing side; the developer view of both sides stays in the debug GUI.
 */
import type { Cast, Side } from '../campaign/cast';
import { SIDE_LABELS } from '../campaign/cast';
import { THEATER_LABELS } from '../campaign/theaters';

export class SidePanel {
  private readonly el: HTMLDivElement;
  /** The player chose a side. */
  onChoose: ((side: Side) => void) | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'side-panel';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  set visible(v: boolean) {
    this.el.hidden = !v;
  }

  /** Shows the briefing of `cast` with a choice of side. */
  show(seed: string, cast: Cast): void {
    this.el.replaceChildren();
    const h = document.createElement('h2');
    h.textContent = `The war on world ${seed}`;
    this.el.appendChild(h);
    const ul = document.createElement('ul');
    for (const t of cast.theaters) {
      const li = document.createElement('li');
      li.textContent = `${t.name}: ${THEATER_LABELS[t.kind].toLowerCase()}`;
      ul.appendChild(li);
    }
    this.el.appendChild(ul);
    for (const para of cast.briefing.split('\n\n')) {
      const p = document.createElement('p');
      p.textContent = para;
      this.el.appendChild(p);
    }
    const choose = document.createElement('div');
    choose.className = 'choose';
    for (const side of ['alliance', 'pact'] as const) {
      const b = document.createElement('button');
      b.textContent = `Fly for the ${SIDE_LABELS[side]}`;
      b.addEventListener('click', () => {
        this.visible = false;
        this.onChoose?.(side);
      });
      choose.appendChild(b);
    }
    this.el.appendChild(choose);
    this.visible = true;
  }
}
