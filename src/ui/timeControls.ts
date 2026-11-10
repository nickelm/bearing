/**
 * Time controls (milestone 6): a bar at the bottom center with pause and the
 * clock rates, the local date and time under the camera, the campaign clock
 * and the weather under the camera, plus short notices when auto-slowdown
 * drops the rate to 1×.
 *
 * Keys: Space pauses and resumes; 1–5 pick 1×, 4×, 16×, 64× and 256×.
 */
import { TIME_RATES } from '../sim/host';

export interface TimeDisplay {
  rate: number;
  /** Local date and time at the camera, e.g. "15 Aug 06:00". */
  local: string;
  /** Time since campaign start, e.g. "T+1 d 06:00". */
  campaign: string;
  /** Weather under the camera (short). */
  weather: string;
}

export class TimeControls {
  private readonly el: HTMLDivElement;
  private readonly buttons = new Map<number, HTMLButtonElement>();
  private readonly localEl: HTMLSpanElement;
  private readonly campaignEl: HTMLSpanElement;
  private readonly weatherEl: HTMLSpanElement;
  private readonly noticeEl: HTMLDivElement;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private rate = 0;
  /** Rate to resume at after a pause. */
  private resumeRate = 1;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(
    private readonly setRate: (rate: number) => void,
    parent: HTMLElement = document.body,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'time-controls';
    const rates = document.createElement('div');
    rates.className = 'rates';
    for (const r of TIME_RATES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r === 0 ? '❚❚' : `${r}×`;
      b.title = r === 0 ? 'Pause (Space)' : `${r}× (key ${TIME_RATES.indexOf(r)})`;
      b.addEventListener('click', () => this.choose(r));
      this.buttons.set(r, b);
      rates.appendChild(b);
    }
    const info = document.createElement('div');
    info.className = 'clock';
    this.localEl = document.createElement('span');
    this.localEl.className = 'local';
    this.localEl.title = 'Local date and solar time under the camera';
    this.campaignEl = document.createElement('span');
    this.campaignEl.title = 'Time since campaign start';
    this.weatherEl = document.createElement('span');
    this.weatherEl.title = 'Weather under the camera';
    info.append(this.localEl, this.campaignEl, this.weatherEl);
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'notice';
    this.noticeEl.hidden = true;
    this.el.append(this.noticeEl, rates, info);
    parent.appendChild(this.el);

    this.onKey = (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.choose(this.rate === 0 ? this.resumeRate : 0);
      } else if (/^Digit[1-5]$/.test(e.code)) {
        this.choose(TIME_RATES[Number(e.code.slice(5))]!);
      }
    };
    window.addEventListener('keydown', this.onKey);
    this.highlight();
  }

  private choose(rate: number): void {
    this.rate = rate;
    if (rate > 0) this.resumeRate = rate;
    this.highlight();
    this.setRate(rate);
  }

  private highlight(): void {
    for (const [r, b] of this.buttons) b.classList.toggle('active', r === this.rate);
  }

  update(d: TimeDisplay): void {
    if (d.rate !== this.rate) {
      this.rate = d.rate;
      if (d.rate > 0) this.resumeRate = d.rate;
      this.highlight();
    }
    if (this.localEl.textContent !== d.local) this.localEl.textContent = d.local;
    if (this.campaignEl.textContent !== d.campaign) this.campaignEl.textContent = d.campaign;
    if (this.weatherEl.textContent !== d.weather) this.weatherEl.textContent = d.weather;
  }

  /** Shows a short notice above the bar (e.g. why the clock slowed down). */
  notify(text: string, ms = 6000): void {
    this.noticeEl.textContent = text;
    this.noticeEl.hidden = false;
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.noticeEl.hidden = true), ms);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.el.remove();
  }
}
