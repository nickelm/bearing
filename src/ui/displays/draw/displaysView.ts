/**
 * Draws the display models and the strip model (decision 199): HTML and CSS
 * for the bezels, buttons, tabs and strip, Canvas 2D at device pixel ratio for
 * the screens. It holds no state of its own beyond its elements: what to show
 * comes in as models, and every click goes out as a `DisplayCommand`.
 *
 * A screen redraws only when its model changed, so formats can update at their
 * own rates. Screens leave a margin for the bezel buttons' labels, which the
 * screen draws beside each button, as on a real multifunction display.
 */
import './displays.css';
import { layout } from '../layout';
import type { DisplayLayout, Rect, SlotId } from '../layout';
import type {
  DisplayCommand,
  DisplayModel,
  DisplayState,
  ScreenItem,
  StripModel,
  Tone,
} from '../model';

const SLOTS: Exclude<SlotId, 'strip'>[] = ['leftMfd', 'rightMfd', 'messages', 'threat'];

interface SlotEls {
  box: HTMLDivElement;
  screen: HTMLCanvasElement;
  title: HTMLDivElement;
  buttons: HTMLButtonElement[];
  tab: HTMLButtonElement;
  drawn: string;
  rect: string;
}

export class DisplaysView {
  readonly root = document.createElement('div');
  /** Clicks on buttons, tabs and strip items. */
  onCommand: ((c: DisplayCommand) => void) | null = null;
  private readonly slots = new Map<SlotId, SlotEls>();
  private readonly strip = document.createElement('div');
  private stripDrawn = '';
  private lay: DisplayLayout | null = null;
  private commands = new Map<string, DisplayCommand>();
  /** The model each slot shows now. */
  private readonly shown = new Map<SlotId, DisplayModel | null>();
  /** The moving map's latest picture (decision 201). */
  private map: MapImage | null = null;

  constructor(parent: HTMLElement = document.body) {
    this.root.className = 'dsp-root';
    this.root.hidden = true;
    this.strip.className = 'dsp-strip';
    this.root.append(this.strip);
    for (const id of SLOTS) {
      const box = document.createElement('div');
      box.className = `dsp-slot dsp-closed${id === 'messages' || id === 'threat' ? ' dsp-top' : ''}${id === 'rightMfd' || id === 'threat' ? ' dsp-right' : ''}`;
      const screen = document.createElement('canvas');
      screen.className = 'dsp-screen';
      const title = document.createElement('div');
      title.className = 'dsp-title';
      const tab = document.createElement('button');
      tab.className = 'dsp-tab dsp-closed';
      tab.addEventListener('click', () =>
        this.send({ to: 'ui', command: { type: 'toggle-slot', slot: id } }),
      );
      box.append(screen, title);
      // The wheel over the map steps its range in cursor mode (Proposal 0006; decision 202).
      let wheel = 0;
      box.addEventListener(
        'wheel',
        (e) => {
          const m = this.shown.get(id);
          if (m?.format !== 'moving-map') return;
          e.preventDefault();
          const px =
            e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
          wheel += px;
          if (Math.abs(wheel) < 80) return;
          const delta = wheel > 0 ? 1 : -1;
          wheel = 0;
          this.send({ to: 'ui', command: { type: 'map-range', slot: id, delta } });
        },
        { passive: false },
      );
      this.root.append(box, tab);
      this.slots.set(id, { box, screen, title, buttons: [], tab, drawn: '', rect: '' });
    }
    this.strip.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-cmd]');
      const key = el?.getAttribute('data-cmd');
      const c = key ? this.commands.get(key) : undefined;
      if (c) this.send(c);
    });
    parent.append(this.root);
  }

  set visible(v: boolean) {
    this.root.hidden = !v;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /**
   * A new map picture: RGBA rows from the top (`flipY` when the read-back's rows run from the
   * bottom). Screens showing the map redraw with it.
   */
  setMapPicture(p: {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
    lat: number;
    lon: number;
    halfExtent: number;
    flipY?: boolean;
  }): void {
    const canvas = document.createElement('canvas');
    canvas.width = p.width;
    canvas.height = p.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const data = new ImageData(new Uint8ClampedArray(p.pixels), p.width, p.height);
    if (p.flipY) {
      ctx.translate(0, p.height);
      ctx.scale(1, -1);
      const tmp = document.createElement('canvas');
      tmp.width = p.width;
      tmp.height = p.height;
      tmp.getContext('2d')?.putImageData(data, 0, 0);
      ctx.drawImage(tmp, 0, 0);
    } else ctx.putImageData(data, 0, 0);
    this.map = { image: canvas, size: p.width, lat: p.lat, lon: p.lon, halfExtent: p.halfExtent };
    for (const el of this.slots.values()) el.drawn = '';
  }

  /** The current layout (after `draw`), for tools and tests. */
  get currentLayout(): DisplayLayout | null {
    return this.lay;
  }

  private send(c: DisplayCommand): void {
    this.onCommand?.(c);
  }

  /** Draws the models for a viewport of `width` × `height` CSS px. */
  draw(
    models: Partial<Record<SlotId, DisplayModel | null>>,
    state: DisplayState,
    strip: StripModel,
    skin: 'alliance' | 'pact',
    width = window.innerWidth,
    height = window.innerHeight,
  ): void {
    this.root.classList.toggle('dsp-pact', skin === 'pact');
    const L = layout({ width, height }, state.uiScale);
    this.lay = L;
    for (const id of SLOTS) this.drawSlot(id, models[id] ?? null, state, L);
    this.drawStrip(strip, L.slots.strip.rect, L.scale);
  }

  private drawSlot(
    id: Exclude<SlotId, 'strip'>,
    m: DisplayModel | null,
    d: DisplayState,
    L: DisplayLayout,
  ): void {
    const el = this.slots.get(id)!;
    this.shown.set(id, m);
    const st = d.slots[id];
    const { rect, tab } = L.slots[id];
    const open = m !== null && st.state === 'expanded';
    el.box.classList.toggle('dsp-closed', !open);
    el.tab.classList.toggle('dsp-closed', !(m !== null && st.state === 'collapsed'));
    if (tab) place(el.tab, tab);
    el.tab.textContent = m ? `${m.title} ▴` : '';
    if (!m) return;
    el.box.classList.toggle('dsp-alert', m.alert);
    const rectKey = JSON.stringify(rect);
    const n = m.buttons.length;
    if (el.rect !== rectKey || el.buttons.length !== n) {
      place(el.box, rect);
      this.buildButtons(el, n, rect);
      el.rect = rectKey;
      el.drawn = '';
    }
    // Buttons: enabled where the model has one.
    m.buttons.forEach((b, i) => {
      const btn = el.buttons[i]!;
      btn.disabled = b === null || b.command === null;
      btn.title = b?.label ?? '';
      btn.onclick = b?.command ? () => this.send(b.command!) : null;
    });
    const key = JSON.stringify([
      m.title,
      m.owner,
      m.items,
      m.buttons.map((b) => b && [b.label, b.active]),
    ]);
    if (key === el.drawn) return;
    el.drawn = key;
    // The owner's tag on the bezel's top edge (P5's crew); the format names itself on its screen.
    el.title.textContent = m.owner ?? '';
    drawScreen(el.screen, m, getComputedStyle(this.root), this.map);
  }

  /** Places the screen inside the bezel and the buttons on its edges. */
  private buildButtons(el: SlotEls, n: number, r: Rect): void {
    for (const b of el.buttons) b.remove();
    el.buttons = [];
    const side = Math.min(r.width, r.height);
    const bez = Math.max(10, Math.round(side * (n > 5 ? 0.09 : 0.08)));
    const top = Math.max(bez, 14);
    place(el.screen, {
      x: n > 5 ? bez : 6,
      y: top,
      width: r.width - (n > 5 ? 2 * bez : 12) - 4,
      height: r.height - top - (n > 5 ? bez : 6) - 4,
    });
    const inner = { w: r.width - 4, h: r.height - 4 };
    const bw = Math.round(bez * 0.75);
    const span = (len: number, i: number) => ((i + 0.5) / 5) * len;
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.className = 'dsp-osb';
      const k = i % 5;
      let x: number;
      let y: number;
      let w = bw * 1.6;
      let h = bw * 0.7;
      if (i < 5) {
        x = span(inner.w, k) - w / 2;
        y = (top - h) / 2;
      } else if (i < 10) {
        [w, h] = [h, w];
        x = inner.w - bez / 2 - w / 2;
        y = top + span(inner.h - top - bez, k) - h / 2;
      } else if (i < 15) {
        x = span(inner.w, 4 - k) - w / 2;
        y = inner.h - bez / 2 - h / 2;
      } else {
        [w, h] = [h, w];
        x = bez / 2 - w / 2;
        y = top + span(inner.h - top - bez, 4 - k) - h / 2;
      }
      place(b, { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
      el.box.append(b);
      el.buttons.push(b);
    }
  }

  private drawStrip(m: StripModel, r: Rect, scale: number): void {
    place(this.strip, r);
    const key = JSON.stringify(m);
    if (key === this.stripDrawn) return;
    this.stripDrawn = key;
    this.commands.clear();
    const parts: string[] = [];
    if (m.masterCaution) {
      this.commands.set('master', {
        to: 'avionics',
        command: {
          type: 'acknowledge',
          ids: m.items.filter((i) => i.level !== 'normal').map((i) => i.id),
        },
      });
      parts.push(`<button class="dsp-master" data-cmd="master">MASTER CAUTION</button>`);
    }
    for (const it of m.items) {
      const cmd = it.command ? `item-${it.id}` : null;
      if (cmd) this.commands.set(cmd, it.command!);
      parts.push(
        `<span class="dsp-item dsp-${it.level}${it.fresh ? ' dsp-fresh' : ''}"${cmd ? ` data-cmd="${cmd}"` : ''}>${esc(it.label)}</span>`,
      );
    }
    for (const g of m.gauges)
      parts.push(
        `<span class="dsp-gauge dsp-${g.level}">${esc(g.label)}<i><b style="width:${Math.round(g.fill * 100)}%"></b></i>${esc(g.text)}</span>`,
      );
    parts.push(`<span class="dsp-mode">${esc(m.mode)}</span>`);
    this.strip.innerHTML = parts.join('');
    this.strip.style.fontSize = `${Math.round(12 * scale)}px`;
  }

  dispose(): void {
    this.root.remove();
  }
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function place(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

/** The moving map's latest picture, as the view keeps it (decision 201). */
export interface MapImage {
  image: CanvasImageSource;
  size: number;
  lat: number;
  lon: number;
  halfExtent: number;
}

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

const TONE_ALPHA: Record<Tone, number> = { normal: 1, dim: 0.5, caution: 1, warning: 1 };

/** Draws a model's screen: its items, and its buttons' labels beside them. */
function drawScreen(
  canvas: HTMLCanvasElement,
  m: DisplayModel,
  css: CSSStyleDeclaration,
  map: MapImage | null,
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || parseFloat(canvas.style.width);
  const h = canvas.clientHeight || parseFloat(canvas.style.height);
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const phosphor = css.getPropertyValue('--phosphor').trim() || '#6CFF8A';
  const color = (t: Tone) =>
    t === 'caution'
      ? css.getPropertyValue('--amber').trim()
      : t === 'warning'
        ? css.getPropertyValue('--red').trim()
        : phosphor;
  const base = Math.max(9, Math.min(w, h) / 16);
  const sizes = { small: base * 0.85, normal: base, large: base * 1.5 };
  // Over the map's picture, symbology and labels get a dark halo (Part I, Moving Map).
  halo = m.items.some((i) => i.kind === 'map');
  for (const it of m.items) drawItem(c, it, w, h, sizes, color, map);
  // Button labels on the screen's edges, beside their buttons.
  c.globalAlpha = 1;
  c.font = `${Math.round(base * 0.8)}px ui-monospace, 'JetBrains Mono', Consolas, monospace`;
  const n = m.buttons.length;
  m.buttons.forEach((b, i) => {
    if (!b) return;
    const k = i % 5;
    const at = (k + 0.5) / 5;
    let x: number;
    let y: number;
    let align: CanvasTextAlign = 'center';
    let baseLine: CanvasTextBaseline = 'middle';
    if (i < 5) {
      x = at * w;
      y = 3;
      baseLine = 'top';
    } else if (i < 10) {
      x = w - 3;
      y = at * h;
      align = 'right';
    } else if (i < 15) {
      x = (1 - at) * w;
      y = h - 3;
      baseLine = 'bottom';
    } else {
      x = 3;
      y = (1 - at) * h;
      align = 'left';
    }
    if (n <= 5) y = 3;
    c.textAlign = align;
    c.textBaseline = baseLine;
    const tw = c.measureText(b.label).width;
    if (b.active) {
      c.fillStyle = phosphor;
      const bx = align === 'center' ? x - tw / 2 - 2 : align === 'right' ? x - tw - 2 : x - 2;
      const by =
        baseLine === 'top' ? y - 1 : baseLine === 'bottom' ? y - base * 0.8 - 1 : y - base * 0.45;
      c.fillRect(bx, by, tw + 4, base * 0.9);
      c.fillStyle = css.getPropertyValue('--screen').trim() || '#000';
    } else c.fillStyle = phosphor;
    if (halo && !b.active) haloText(c, b.label, x, y);
    c.fillText(b.label, x, y);
  });
}

/** Whether the screen being drawn shows the map (its symbology then gets a halo). */
let halo = false;

function haloText(c: CanvasRenderingContext2D, t: string, x: number, y: number): void {
  const fill = c.fillStyle;
  c.save();
  c.globalAlpha = 1;
  c.strokeStyle = 'rgba(0, 12, 4, 0.85)';
  c.lineWidth = 3;
  c.lineJoin = 'round';
  c.strokeText(t, x, y);
  c.restore();
  c.fillStyle = fill;
}

/** Strokes the current path, with a dark halo under it over the map. */
function haloStroke(c: CanvasRenderingContext2D): void {
  if (halo) {
    const color = c.strokeStyle;
    const width = c.lineWidth;
    c.save();
    c.globalAlpha = 1;
    c.strokeStyle = 'rgba(0, 12, 4, 0.85)';
    c.lineWidth = width + 2.5;
    c.stroke();
    c.restore();
    c.strokeStyle = color;
    c.lineWidth = width;
  }
  c.stroke();
}

function drawItem(
  c: CanvasRenderingContext2D,
  it: ScreenItem,
  w: number,
  h: number,
  sizes: Record<'small' | 'normal' | 'large', number>,
  color: (t: Tone) => string,
  map: MapImage | null,
): void {
  const tone: Tone = 'tone' in it ? it.tone : 'normal';
  c.globalAlpha = TONE_ALPHA[tone];
  c.strokeStyle = c.fillStyle = color(tone);
  c.lineWidth = 1.5;
  c.setLineDash([]);
  switch (it.kind) {
    case 'text':
      c.font = `${Math.round(sizes[it.size])}px ui-monospace, 'JetBrains Mono', Consolas, monospace`;
      c.textAlign = it.align;
      c.textBaseline = 'alphabetic';
      if (it.tone === 'warning') {
        // Warnings in inverse video: red alone turns dark for protanopes (check 13).
        const tw = c.measureText(it.text).width;
        const fs = sizes[it.size];
        const x0 =
          it.align === 'center'
            ? it.x * w - tw / 2
            : it.align === 'right'
              ? it.x * w - tw
              : it.x * w;
        c.fillRect(x0 - 3, it.y * h - fs * 0.85, tw + 6, fs * 1.1);
        c.fillStyle = '#FFFFFF';
      } else if (it.tone === 'caution') {
        // Cautions boxed: on the Pact's amber screens their color alone is the text's own.
        const tw = c.measureText(it.text).width;
        const fs = sizes[it.size];
        const x0 =
          it.align === 'center'
            ? it.x * w - tw / 2
            : it.align === 'right'
              ? it.x * w - tw
              : it.x * w;
        c.lineWidth = 1;
        c.strokeRect(x0 - 3, it.y * h - fs * 0.85, tw + 6, fs * 1.1);
      }
      if (halo && it.tone !== 'warning') haloText(c, it.text, it.x * w, it.y * h);
      c.fillText(it.text, it.x * w, it.y * h);
      break;
    case 'line':
      c.lineWidth = it.width ?? 1.5;
      c.beginPath();
      it.points.forEach(([x, y], i) => (i ? c.lineTo(x * w, y * h) : c.moveTo(x * w, y * h)));
      haloStroke(c);
      break;
    case 'arc':
      if (it.dashed) c.setLineDash([4, 4]);
      c.beginPath();
      c.arc(it.x * w, it.y * h, it.r * Math.min(w, h), 0, 2 * Math.PI);
      haloStroke(c);
      break;
    case 'map': {
      // The latest picture, centered on the aircraft and turned for track-up (decision 201).
      const pic = map;
      if (!pic) {
        c.font = `${Math.round(sizes.small)}px ui-monospace, 'JetBrains Mono', Consolas, monospace`;
        c.textAlign = 'center';
        c.fillText('MAP LOADING', w / 2, h * 0.8);
        break;
      }
      const mPerScreenPx = (2 * it.halfExtent) / w;
      const mPerPicPx = (2 * pic.halfExtent) / pic.size;
      const east = it.radius * Math.cos(it.lat) * wrap(it.lon - pic.lon);
      const north = it.radius * (it.lat - pic.lat);
      c.save();
      c.globalAlpha = 1;
      c.beginPath();
      c.rect(0, 0, w, h);
      c.clip();
      c.translate(w / 2, h / 2);
      c.rotate(-it.rotation);
      c.scale(mPerPicPx / mPerScreenPx, mPerPicPx / mPerScreenPx);
      c.drawImage(pic.image, -pic.size / 2 - east / mPerPicPx, -pic.size / 2 + north / mPerPicPx);
      c.restore();
      break;
    }
    case 'log': {
      // Wrapped to the width, stacked up from the bottom, newest last.
      const size = sizes.small;
      c.font = `${Math.round(size)}px ui-monospace, 'JetBrains Mono', Consolas, monospace`;
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
      const pad = 6;
      const lh = size * 1.25;
      const rows: { text: string; tone: Tone }[] = [];
      for (const l of it.lines) {
        let row = '';
        for (const word of l.text.split(' ')) {
          const next = row ? `${row} ${word}` : word;
          if (row && c.measureText(next).width > w - 2 * pad) {
            rows.push({ text: row, tone: l.tone });
            row = `  ${word}`;
          } else row = next;
        }
        rows.push({ text: row, tone: l.tone });
      }
      let y = h - pad;
      for (let i = rows.length - 1; i >= 0 && y > lh * 1.6; i--, y -= lh) {
        const r = rows[i]!;
        c.globalAlpha = TONE_ALPHA[r.tone];
        c.fillStyle = color(r.tone);
        c.fillText(r.text, pad, y);
      }
      break;
    }
    case 'bar': {
      const x = it.x * w;
      const y = it.y * h;
      const bw = it.w * w;
      const bh = it.h * h;
      c.strokeRect(x, y, bw, bh);
      const f = Math.max(0, Math.min(1, it.fill));
      if (it.vertical) c.fillRect(x, y + bh * (1 - f), bw, bh * f);
      else c.fillRect(x, y, bw * f, bh);
      break;
    }
  }
}
