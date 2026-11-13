/**
 * Draws the Free Flight HUD (src/ui/flight/hud.ts) over a render from
 * tools/freeflight.preview.ts: `composite.html?shot=<name>` loads
 * tools/out/freeflight-<name>.png and .json and draws the HUD with the
 * frame's camera, so the screenshot shows the real HUD code over the real
 * render. tools/freeflight.screens.mjs drives it in headless Chromium.
 */
import { Hud, matrixProjector } from '../../src/ui/flight/hud';
import type { HudFrame } from '../../src/ui/flight/hud';

interface Shot {
  width: number;
  height: number;
  frame: HudFrame;
  messages: string[][];
  view: number[];
  projection: number[];
}

async function main(): Promise<void> {
  const name = new URLSearchParams(location.search).get('shot') ?? 'runway';
  const shot = (await (await fetch(`../out/freeflight-${name}.json`)).json()) as Shot;
  const img = document.getElementById('shot') as HTMLImageElement;
  img.src = `../out/freeflight-${name}.png`;
  await img.decode();
  const hud = new Hud();
  hud.show(true);
  for (const m of shot.messages) hud.message(m, 600);
  hud.draw(
    shot.frame,
    matrixProjector(shot.view, shot.projection, window.innerWidth, window.innerHeight),
  );
  document.title = 'ready';
}

void main();
