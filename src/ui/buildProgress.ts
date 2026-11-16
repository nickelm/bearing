/**
 * The world build's progress panel (decision 184): the stage and a bar, in the
 * dark translucent panel and monospaced type of the UI (visual-style Part I,
 * User Interface), at the bottom of the screen while a world is being built.
 */
export class BuildProgress {
  private readonly el: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly bar: HTMLDivElement;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'build-progress';
    this.el.hidden = true;
    this.label = document.createElement('div');
    const track = document.createElement('div');
    track.className = 'build-progress-track';
    this.bar = document.createElement('div');
    this.bar.className = 'build-progress-bar';
    track.appendChild(this.bar);
    this.el.append(this.label, track);
    parent.appendChild(this.el);
  }

  /** Shows `stage` at `fraction` (0..1). */
  show(stage: string, fraction: number): void {
    this.el.hidden = false;
    const f = Math.max(0, Math.min(1, fraction));
    this.label.textContent = `${stage} — ${Math.round(f * 100)}%`;
    this.bar.style.width = `${(f * 100).toFixed(1)}%`;
  }

  hide(): void {
    this.el.hidden = true;
  }
}
