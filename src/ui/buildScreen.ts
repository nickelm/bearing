/**
 * The world build screen (decision 186): while a world is generated or loaded,
 * a full-screen panel lists the build's phases, each with its bar and time,
 * and a log of what is going on; the app draws nothing behind it and takes no
 * input but the debug panel's. In the dark panels and monospaced type of the UI
 * (visual-style Part I, User Interface).
 */
export class BuildScreen {
  private readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly list: HTMLOListElement;
  private readonly logEl: HTMLDivElement;
  private rows: {
    li: HTMLLIElement;
    bar: HTMLDivElement;
    state: HTMLSpanElement;
    detail: HTMLDivElement;
    t0: number;
    note: string;
  }[] = [];
  private t0 = 0;
  /** Whether a build is showing (the app skips its frames while it is). */
  active = false;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'build-screen';
    this.el.hidden = true;
    const panel = document.createElement('div');
    panel.className = 'build-panel';
    this.title = document.createElement('div');
    this.title.className = 'build-title';
    this.list = document.createElement('ol');
    this.list.className = 'build-phases';
    this.logEl = document.createElement('div');
    this.logEl.className = 'build-log';
    panel.append(this.title, this.list, this.logEl);
    this.el.appendChild(panel);
    parent.appendChild(this.el);
  }

  /** Starts a build titled `title` with these phases. */
  begin(title: string, phases: readonly string[]): void {
    this.active = true;
    this.el.hidden = false;
    this.title.textContent = title;
    this.list.replaceChildren();
    this.logEl.replaceChildren();
    this.t0 = performance.now();
    this.rows = phases.map((name) => {
      const li = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'build-phase-head';
      const label = document.createElement('span');
      label.textContent = name;
      const state = document.createElement('span');
      state.className = 'build-state';
      state.textContent = 'waiting';
      head.append(label, state);
      const track = document.createElement('div');
      track.className = 'build-track';
      const bar = document.createElement('div');
      bar.className = 'build-bar';
      track.appendChild(bar);
      const detail = document.createElement('div');
      detail.className = 'build-detail';
      li.append(head, track, detail);
      this.list.appendChild(li);
      return { li, bar, state, detail, t0: 0, note: '' };
    });
  }

  /**
   * Phase `i` is at `fraction` (0..1), doing `detail` (shown under its bar); the log
   * gets a line when `note` (the stage, without counts) changes, `detail` by default.
   */
  progress(i: number, fraction: number, detail = '', note = detail): void {
    const r = this.rows[i];
    if (!r) return;
    if (!r.t0) {
      r.t0 = performance.now();
      r.li.classList.add('running');
    }
    const f = Math.max(0, Math.min(1, fraction));
    r.bar.style.width = `${(f * 100).toFixed(1)}%`;
    r.state.textContent = `${Math.round(f * 100)}%`;
    if (detail) r.detail.textContent = detail;
    if (note && note !== r.note) {
      r.note = note;
      this.log(note);
    }
  }

  /** Phase `i` is finished; `summary` goes to the log. */
  done(i: number, summary = ''): void {
    const r = this.rows[i];
    if (!r) return;
    const t = (performance.now() - (r.t0 || performance.now())) / 1000;
    r.li.classList.remove('running');
    r.li.classList.add('done');
    r.bar.style.width = '100%';
    r.state.textContent = `${t.toFixed(1)} s`;
    r.detail.textContent = summary;
    if (summary) this.log(summary);
  }

  /** Adds a line to the log, with the time since the build began. */
  log(message: string): void {
    const line = document.createElement('div');
    line.textContent = `${((performance.now() - this.t0) / 1000).toFixed(1).padStart(6)} s  ${message}`;
    this.logEl.appendChild(line);
    while (this.logEl.childElementCount > 12) this.logEl.firstElementChild!.remove();
  }

  /** Hides the screen: the world is ready, or the build was cancelled or failed. */
  finish(): void {
    this.active = false;
    this.el.hidden = true;
  }
}
