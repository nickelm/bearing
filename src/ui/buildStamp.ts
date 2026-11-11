/**
 * Build stamp: a small note under the frame-time overlay with the commit and
 * the time the running build was made, in the viewer's local time, and how
 * long ago. On GitHub Pages this shows whether a new deploy has taken hold.
 */
export class BuildStamp {
  private readonly el: HTMLDivElement;

  constructor(
    private readonly commit: string,
    /** ISO time of the build; empty on the dev server. */
    private readonly builtAt: string,
    parent: HTMLElement = document.body,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'build-stamp';
    parent.appendChild(this.el);
    this.update();
    // The age text only changes by the minute.
    setInterval(() => this.update(), 30_000);
  }

  update(now = Date.now()): void {
    this.el.textContent = buildStampText(this.commit, this.builtAt, now);
  }
}

/** "build 6274249 · 11 Nov, 14:23 (5 min ago)", or "dev build" without a build time. */
export function buildStampText(commit: string, builtAt: string, now: number): string {
  const t = Date.parse(builtAt);
  if (!builtAt || Number.isNaN(t)) return commit === 'dev' ? 'dev build' : `build ${commit}`;
  const when = new Date(t).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `build ${commit} · ${when} (${formatAge(now - t)})`;
}

/** Elapsed time as "just now", "12 min ago", "3 h ago" or "2 d ago". */
export function formatAge(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
