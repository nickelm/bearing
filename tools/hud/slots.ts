/**
 * The display slots' layout (src/ui/displays/layout.ts, decision 195) drawn over
 * a HUD composite: each slot's rect with its name, its collapsed tab dashed,
 * and the central column that belongs to the aircraft and the HUD. Outlines
 * only, to judge where the displays will sit against the HUD; the display
 * frame itself comes later in P2.
 */
import { layout, SLOT_IDS } from '../../src/ui/displays/layout';
import type { Rect } from '../../src/ui/displays/layout';

const NAMES: Record<string, string> = {
  leftMfd: 'LEFT MFD',
  rightMfd: 'RIGHT MFD',
  threat: 'THREAT',
  messages: 'MESSAGES',
  strip: 'STATUS STRIP',
};

export function drawSlots(uiScale: number): void {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const L = layout({ width: W, height: H }, uiScale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:20';
  document.body.appendChild(canvas);
  const c = canvas.getContext('2d')!;
  const box = (r: Rect, color: string, dash: number[] = [], width = 2) => {
    c.setLineDash(dash);
    c.strokeStyle = color;
    c.lineWidth = width;
    c.strokeRect(r.x + width / 2, r.y + width / 2, r.width - width, r.height - width);
  };
  // The central column, faint.
  box(L.center, 'rgba(255,255,255,0.35)', [6, 6], 1);
  for (const id of SLOT_IDS) {
    const { rect, tab } = L.slots[id];
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(rect.x, rect.y, rect.width, rect.height);
    box(rect, '#FFB347');
    if (tab) box(tab, 'rgba(255,179,71,0.8)', [4, 3], 1);
    c.setLineDash([]);
    c.fillStyle = '#FFB347';
    c.font = `${Math.round(13 * L.scale)}px ui-monospace, 'JetBrains Mono', Consolas, monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(
      `${NAMES[id]}  ${rect.width}×${rect.height}`,
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
  }
  c.textAlign = 'left';
  c.fillStyle = 'rgba(255,255,255,0.7)';
  c.fillText(`${W}×${H}, UI scale ${L.scale}`, L.center.x + 8, L.center.y + L.center.height - 12);
}
